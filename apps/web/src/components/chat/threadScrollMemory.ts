/**
 * Where each thread's timeline was scrolled when the user last left it.
 *
 * The timeline list stays mounted across thread switches and ChatView pins
 * every newly displayed thread to its end. Remembering the row under the
 * viewport top lets a switch back land where the user was reading instead.
 * Module scope, like the remembered thread timelines: the memory must outlive
 * any single ChatView mount. A `null` anchor means "was at the end", which
 * restores to the end the same way an unknown thread does.
 */
export interface ThreadScrollAnchor {
  readonly rowId: string;
  readonly offsetWithinRow: number;
}

const MAX_REMEMBERED_THREAD_SCROLL_ANCHORS = 64;

let anchors = new Map<string, ThreadScrollAnchor>();

export function rememberThreadScrollAnchor(
  threadKey: string | null,
  anchor: ThreadScrollAnchor | null | undefined,
): void {
  if (threadKey === null) return;
  // Re-insert so the map's iteration order doubles as recency.
  anchors.delete(threadKey);
  if (!anchor) return;
  anchors.set(threadKey, anchor);
  while (anchors.size > MAX_REMEMBERED_THREAD_SCROLL_ANCHORS) {
    const oldest = anchors.keys().next().value;
    if (oldest === undefined) break;
    anchors.delete(oldest);
  }
}

export function peekThreadScrollAnchor(threadKey: string | null): ThreadScrollAnchor | null {
  if (threadKey === null) return null;
  return anchors.get(threadKey) ?? null;
}

/** Turns a remembered anchor into a LegendList scroll target, or null when the row is gone. */
export function resolveThreadScrollRestoreTarget(
  anchor: ThreadScrollAnchor | null,
  indexByKey: (key: string) => number | undefined,
): { index: number; viewOffset: number } | null {
  if (anchor === null) return null;
  const index = indexByKey(anchor.rowId);
  if (index === undefined || index < 0) return null;
  return { index, viewOffset: -Math.max(0, anchor.offsetWithinRow) };
}

export function resetThreadScrollAnchors(): void {
  anchors = new Map();
}
