import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  peekThreadScrollAnchor,
  rememberThreadScrollAnchor,
  resetThreadScrollAnchors,
  resolveThreadScrollRestoreTarget,
} from "./threadScrollMemory";

describe("thread scroll memory", () => {
  beforeEach(() => {
    resetThreadScrollAnchors();
  });

  it("returns the anchor remembered for a thread and nothing for unknown threads", () => {
    rememberThreadScrollAnchor("env:a", { rowId: "row-3", offsetWithinRow: 12 });
    expect(peekThreadScrollAnchor("env:a")).toEqual({ rowId: "row-3", offsetWithinRow: 12 });
    expect(peekThreadScrollAnchor("env:b")).toBeNull();
    expect(peekThreadScrollAnchor(null)).toBeNull();
  });

  it("forgets a thread once the user scrolls back to its end", () => {
    rememberThreadScrollAnchor("env:a", { rowId: "row-3", offsetWithinRow: 12 });
    rememberThreadScrollAnchor("env:a", null);
    expect(peekThreadScrollAnchor("env:a")).toBeNull();
  });

  it("keeps the most recently touched threads when the cap is exceeded", () => {
    for (let index = 0; index < 64; index += 1) {
      rememberThreadScrollAnchor(`env:${index}`, { rowId: "row", offsetWithinRow: index });
    }
    // Touching thread 0 makes it the newest; thread 1 becomes the eviction candidate.
    rememberThreadScrollAnchor("env:0", { rowId: "row", offsetWithinRow: 0 });
    rememberThreadScrollAnchor("env:new", { rowId: "row", offsetWithinRow: 1 });
    expect(peekThreadScrollAnchor("env:0")).not.toBeNull();
    expect(peekThreadScrollAnchor("env:1")).toBeNull();
    expect(peekThreadScrollAnchor("env:new")).not.toBeNull();
  });

  it("resolves the remembered row to an index with the offset pulled above the viewport", () => {
    const indexByKey = (key: string) => (key === "row-3" ? 7 : undefined);
    expect(
      resolveThreadScrollRestoreTarget({ rowId: "row-3", offsetWithinRow: 40 }, indexByKey),
    ).toEqual({ index: 7, viewOffset: -40 });
  });

  it("gives up when the remembered row is no longer in the list", () => {
    const indexByKey = () => undefined;
    expect(
      resolveThreadScrollRestoreTarget({ rowId: "row-3", offsetWithinRow: 40 }, indexByKey),
    ).toBeNull();
    expect(resolveThreadScrollRestoreTarget(null, indexByKey)).toBeNull();
  });
});
