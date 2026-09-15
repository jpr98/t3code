import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseThreadSearchQuery,
  resolvePastedThreadReference,
  searchThreadReferences,
} from "./threadReference";

const env = "primary" as EnvironmentId;
const threads = [
  {
    id: "9f1c2a3b-0000-4000-8000-000000000001",
    title: "Fix login redirect",
    environmentId: env,
    updatedAt: "2026-09-02T00:00:00.000Z",
  },
  {
    id: "import:claudeAgent:abc/def",
    title: "Imported session",
    environmentId: env,
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "other-env-thread",
    title: "Fix login on mobile",
    environmentId: "remote" as EnvironmentId,
    updatedAt: "2026-09-03T00:00:00.000Z",
  },
];

describe("resolvePastedThreadReference", () => {
  it("matches a bare thread id and thread links from every surface", () => {
    for (const text of [
      "9f1c2a3b-0000-4000-8000-000000000001",
      "  9f1c2a3b-0000-4000-8000-000000000001\n",
      "http://localhost:3000/primary/9f1c2a3b-0000-4000-8000-000000000001",
      "t3code://app/#/primary/9f1c2a3b-0000-4000-8000-000000000001",
      "t3code://threads/primary/9f1c2a3b-0000-4000-8000-000000000001?x=1",
    ]) {
      expect(
        resolvePastedThreadReference({ text, environmentId: env, activeThreadId: null, threads }),
        text,
      ).toEqual({ id: "9f1c2a3b-0000-4000-8000-000000000001", title: "Fix login redirect" });
    }
  });

  it("decodes percent-encoded import ids in links", () => {
    expect(
      resolvePastedThreadReference({
        text: "http://localhost:3000/primary/import%3AclaudeAgent%3Aabc%2Fdef",
        environmentId: env,
        activeThreadId: null,
        threads,
      }),
    ).toEqual({ id: "import:claudeAgent:abc/def", title: "Imported session" });
  });

  it("ignores prose, the current thread, and threads from other environments", () => {
    expect(
      resolvePastedThreadReference({
        text: "look at 9f1c2a3b-0000-4000-8000-000000000001",
        environmentId: env,
        activeThreadId: null,
        threads,
      }),
    ).toBeNull();
    expect(
      resolvePastedThreadReference({
        text: "9f1c2a3b-0000-4000-8000-000000000001",
        environmentId: env,
        activeThreadId: "9f1c2a3b-0000-4000-8000-000000000001",
        threads,
      }),
    ).toBeNull();
    expect(
      resolvePastedThreadReference({
        text: "other-env-thread",
        environmentId: env,
        activeThreadId: null,
        threads,
      }),
    ).toBeNull();
  });
});

describe("parseThreadSearchQuery", () => {
  it("recognises the thread prefixes and returns the rest of the query", () => {
    expect(parseThreadSearchQuery("t:login")).toBe("login");
    expect(parseThreadSearchQuery("Thread:Login fix")).toBe("Login fix");
    expect(parseThreadSearchQuery("t:")).toBe("");
    expect(parseThreadSearchQuery("src/threads.ts")).toBeNull();
    expect(parseThreadSearchQuery("tests")).toBeNull();
  });
});

describe("searchThreadReferences", () => {
  it("searches titles in the current environment, newest first, excluding the current thread", () => {
    expect(
      searchThreadReferences({
        query: "login",
        environmentId: env,
        activeThreadId: null,
        threads,
        limit: 5,
      }),
    ).toEqual([{ id: "9f1c2a3b-0000-4000-8000-000000000001", title: "Fix login redirect" }]);
    expect(
      searchThreadReferences({
        query: "i",
        environmentId: env,
        activeThreadId: "import:claudeAgent:abc/def",
        threads,
        limit: 5,
      }),
    ).toEqual([{ id: "9f1c2a3b-0000-4000-8000-000000000001", title: "Fix login redirect" }]);
  });

  it("lists the newest threads for an empty query, bounded by the limit", () => {
    expect(
      searchThreadReferences({
        query: "  ",
        environmentId: env,
        activeThreadId: null,
        threads,
        limit: 1,
      }),
    ).toEqual([{ id: "9f1c2a3b-0000-4000-8000-000000000001", title: "Fix login redirect" }]);
  });
});
