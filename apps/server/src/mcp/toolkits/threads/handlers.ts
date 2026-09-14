import { ThreadId, type OrchestrationThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  threadCheckpointByMessageId,
  threadReferenceMessageText,
} from "../../../orchestration/threadReferenceContext.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  READ_THREAD_DEFAULT_LIMIT,
  type ReadThreadInput,
  type ReadThreadMessage,
  type ReadThreadResult,
  ThreadNotFoundError,
  ThreadReadFailedError,
  ThreadsToolkit,
} from "./tools.ts";

/** One message can be a pasted log; the page stays readable and the caller can page for more. */
const MESSAGE_TEXT_MAX_CHARS = 20_000;
const TRUNCATION_MARKER = "\n[... message truncated ...]";

/** Pages a thread's readable messages; exported so the shape is testable without a layer. */
export function readThreadPage(
  thread: OrchestrationThread,
  input: Pick<ReadThreadInput, "offset" | "limit">,
): ReadThreadResult {
  const checkpoints = threadCheckpointByMessageId(thread);
  const offset = input.offset ?? 0;
  const limit = input.limit ?? READ_THREAD_DEFAULT_LIMIT;
  let truncated = false;
  const readable = thread.messages.filter((message) => message.role !== "system");
  const messages: ReadThreadMessage[] = readable.slice(offset, offset + limit).map((message) => {
    const fullText = threadReferenceMessageText(message);
    const text =
      fullText.length > MESSAGE_TEXT_MAX_CHARS
        ? `${fullText.slice(0, MESSAGE_TEXT_MAX_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
        : fullText;
    if (text !== fullText) truncated = true;
    return {
      id: message.id,
      role: message.role === "user" ? "user" : "assistant",
      text,
      turnId: message.turnId,
      createdAt: message.createdAt,
      filesChanged: (checkpoints.get(message.id)?.files ?? []).map((file) => ({
        path: file.path,
        kind: file.kind,
        additions: file.additions,
        deletions: file.deletions,
      })),
    };
  });
  const end = offset + messages.length;
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    archived: thread.archivedAt !== null,
    updatedAt: thread.updatedAt,
    messageCount: readable.length,
    offset,
    messages,
    nextOffset: end < readable.length ? end : null,
    truncated,
  };
}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  return ThreadsToolkit.of({
    read_thread: (input) =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("threads");
        // Archived threads stay readable; deleted ones are gone. The projection only holds
        // this environment's threads, so an id from elsewhere is simply not found.
        const thread = yield* snapshots
          .getThreadDetailById(ThreadId.make(input.threadId), {
            activityKinds: [],
            includeArchived: true,
          })
          .pipe(Effect.mapError((cause) => new ThreadReadFailedError({ cause })));
        if (Option.isNone(thread)) {
          return yield* new ThreadNotFoundError({ threadId: input.threadId });
        }
        return readThreadPage(thread.value, input);
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
