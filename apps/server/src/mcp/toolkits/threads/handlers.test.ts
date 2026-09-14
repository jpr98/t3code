import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readThreadPage, ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const CURRENT_THREAD_ID = ThreadId.make("thread-current");
const OTHER_THREAD_ID = ThreadId.make("thread-other");

type Message = OrchestrationThread["messages"][number];

function message(input: {
  id: string;
  role: Message["role"];
  text: string;
  turnId?: string;
}): Message {
  return {
    id: input.id,
    role: input.role,
    text: input.text,
    turnId: input.turnId ?? null,
    streaming: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  } as Message;
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: OTHER_THREAD_ID,
    projectId: "project-1",
    title: "Fix login redirect",
    branch: "fix/login",
    worktreePath: null,
    updatedAt: "2026-09-02T00:00:00.000Z",
    archivedAt: "2026-09-03T00:00:00.000Z",
    messages: [
      message({ id: "m0", role: "system", text: "compacted" }),
      message({ id: "m1", role: "user", text: "Users get bounced after login", turnId: "t1" }),
      message({ id: "m2", role: "assistant", text: "Fixed the redirect.", turnId: "t1" }),
      message({ id: "m3", role: "user", text: "Thanks", turnId: "t2" }),
    ],
    checkpoints: [
      {
        turnId: "t1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/1",
        status: "ready",
        files: [{ path: "src/auth.ts", kind: "modified", additions: 3, deletions: 1 }],
        assistantMessageId: "m2",
        completedAt: "2026-09-01T00:00:01.000Z",
      },
    ],
    ...overrides,
  } as unknown as OrchestrationThread;
}

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: CURRENT_THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  thread: OrchestrationThread | null = makeThread(),
) {
  const dependencies = Layer.mock(ProjectionSnapshotQuery)({
    getThreadDetailById: (threadId, query) =>
      Effect.succeed(
        threadId === OTHER_THREAD_ID && query?.includeArchived === true
          ? Option.fromNullishOr(thread)
          : Option.none(),
      ),
  });
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = (
    params: Parameters<typeof toolkit.handle<"read_thread">>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["threads"],
  ) =>
    toolkit.handle("read_thread", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<typeof ThreadsToolkit.tools.read_thread>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { call };
});

describe("threads toolkit handlers", () => {
  it.effect("refuses a credential without the threads capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call({ threadId: OTHER_THREAD_ID }, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "threads",
        threadId: CURRENT_THREAD_ID,
      });
    }),
  );

  it.effect("reads an archived thread with files per turn and readable chips", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        makeThread({
          messages: [
            message({
              id: "m1",
              role: "user",
              text: "See [log](t3-context://v1/terminal/terminal_1)",
              turnId: "t1",
            }),
            message({ id: "m2", role: "assistant", text: "Fixed the redirect.", turnId: "t1" }),
          ],
        }),
      );
      const result = yield* harness.call({ threadId: OTHER_THREAD_ID });
      expect(result).toMatchObject({
        threadId: OTHER_THREAD_ID,
        title: "Fix login redirect",
        branch: "fix/login",
        archived: true,
        messageCount: 2,
        offset: 0,
        nextOffset: null,
        truncated: false,
      });
      expect(result.messages).toEqual([
        expect.objectContaining({
          id: "m1",
          role: "user",
          text: "See [Terminal: log]",
          filesChanged: [],
        }),
        expect.objectContaining({
          id: "m2",
          role: "assistant",
          filesChanged: [{ path: "src/auth.ts", kind: "modified", additions: 3, deletions: 1 }],
        }),
      ]);
    }),
  );

  it.effect("reports an unknown thread as not found", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call({ threadId: "thread-missing" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ThreadNotFoundError", threadId: "thread-missing" });
    }),
  );
});

describe("readThreadPage", () => {
  it("skips system messages and pages with offset and limit", () => {
    const thread = makeThread();
    const first = readThreadPage(thread, { limit: 2 });
    expect(first.messageCount).toBe(3);
    expect(first.messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(first.nextOffset).toBe(2);
    const second = readThreadPage(thread, { offset: 2, limit: 2 });
    expect(second.messages.map((entry) => entry.id)).toEqual(["m3"]);
    expect(second.nextOffset).toBeNull();
  });

  it("caps oversized message bodies and says so", () => {
    const thread = makeThread({
      messages: [message({ id: "m1", role: "user", text: "x".repeat(30_000) })],
    });
    const page = readThreadPage(thread, {});
    expect(page.truncated).toBe(true);
    expect(page.messages[0]!.text.endsWith("[... message truncated ...]")).toBe(true);
    expect(page.messages[0]!.text.length).toBeLessThanOrEqual(20_000);
  });
});
