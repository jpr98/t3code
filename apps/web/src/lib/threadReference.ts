import type { EnvironmentId } from "@t3tools/contracts";

import type { ThreadReferenceContext } from "../threadReferenceContext";

interface ThreadReferenceCandidate {
  readonly id: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
}

function candidateIdsFromPastedText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return [];
  const ids = [trimmed];
  // Web (`/{env}/{thread}`), desktop (`#/{env}/{thread}`), and mobile (`threads/{env}/{thread}`)
  // links all end in the thread id; the rest of the URL is not needed to match a known thread.
  const path = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/#]*/i, "").replace(/^\/?#/, "");
  const lastSegment = path
    .split(/[?#]/)[0]!
    .split("/")
    .findLast((segment) => segment.length > 0);
  if (lastSegment !== undefined) {
    ids.push(lastSegment);
    try {
      ids.push(decodeURIComponent(lastSegment));
    } catch {
      // Not percent-encoded; the raw segment was already added.
    }
  }
  return ids;
}

/**
 * Turns a pasted thread id or thread link into a reference when it names a thread this
 * environment knows. Exact id matches only: thread ids are opaque, so nothing is guessed from
 * shape. The current thread never references itself.
 */
export function resolvePastedThreadReference(input: {
  readonly text: string;
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: string | null;
  readonly threads: ReadonlyArray<ThreadReferenceCandidate>;
}): ThreadReferenceContext | null {
  const ids = new Set(candidateIdsFromPastedText(input.text));
  if (ids.size === 0) return null;
  const match = input.threads.find(
    (thread) =>
      thread.environmentId === input.environmentId &&
      thread.id !== input.activeThreadId &&
      ids.has(thread.id),
  );
  return match ? { id: match.id, title: match.title } : null;
}

const THREAD_MENU_LIMIT = 5;

/** Threads in this environment whose title contains the query, newest first, excluding the current one. */
export function searchThreadReferences(input: {
  readonly query: string;
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: string | null;
  readonly threads: ReadonlyArray<ThreadReferenceCandidate & { readonly updatedAt: string }>;
}): ThreadReferenceContext[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  return input.threads
    .filter(
      (thread) =>
        thread.environmentId === input.environmentId &&
        thread.id !== input.activeThreadId &&
        thread.title.toLowerCase().includes(query),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, THREAD_MENU_LIMIT)
    .map((thread) => ({ id: thread.id, title: thread.title }));
}
