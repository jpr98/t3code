import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  DESKTOP_PROMPT_LINK_MAX_TEXT_CHARS,
  findDesktopPromptLinkInArgv,
  isBackgroundPromptLinkArgv,
  parseDesktopPromptLink,
} from "./DesktopPromptLink.ts";

describe("parseDesktopPromptLink", () => {
  it("parses a prompt link with the background defaults", () => {
    const result = parseDesktopPromptLink("t3code://prompt?text=hello%20world", "t3code");

    assert.deepEqual(result, {
      _tag: "PromptLink",
      link: { type: "submit-prompt", text: "hello world", submit: true, focus: false },
    });
  });

  it("reads explicit flags and optional targets", () => {
    const result = parseDesktopPromptLink(
      "t3code://prompt/?text=hi&submit=0&focus=1&environment=env-1&thread=thread-1",
      "t3code",
    );

    assert.deepEqual(result, {
      _tag: "PromptLink",
      link: {
        type: "submit-prompt",
        text: "hi",
        submit: false,
        focus: true,
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
      },
    });
  });

  it("percent-decodes the text exactly once", () => {
    const result = parseDesktopPromptLink(
      "t3code://prompt?text=100%2520done%20%2B%20a%26b",
      "t3code",
    );

    assert.equal(result._tag, "PromptLink");
    if (result._tag !== "PromptLink") return;
    assert.equal(result.link.text, "100%20done + a&b");
  });

  it("only matches the scheme this build owns", () => {
    assert.deepEqual(parseDesktopPromptLink("t3code://prompt?text=hi", "t3code-dev"), {
      _tag: "NotPromptLink",
    });
    assert.equal(
      parseDesktopPromptLink("t3code-dev://prompt?text=hi", "t3code-dev")._tag,
      "PromptLink",
    );
  });

  it("leaves the renderer and thread hosts alone", () => {
    assert.deepEqual(parseDesktopPromptLink("t3code://app/?text=hi", "t3code"), {
      _tag: "NotPromptLink",
    });
    assert.deepEqual(parseDesktopPromptLink("t3code://threads/thread-1", "t3code"), {
      _tag: "NotPromptLink",
    });
    assert.deepEqual(parseDesktopPromptLink("not a url", "t3code"), { _tag: "NotPromptLink" });
  });

  it("rejects empty text", () => {
    assert.equal(parseDesktopPromptLink("t3code://prompt", "t3code")._tag, "InvalidPromptLink");
    assert.equal(
      parseDesktopPromptLink("t3code://prompt?text=%20%20", "t3code")._tag,
      "InvalidPromptLink",
    );
  });

  it("rejects oversized text", () => {
    const text = "a".repeat(DESKTOP_PROMPT_LINK_MAX_TEXT_CHARS + 1);
    const result = parseDesktopPromptLink(`t3code://prompt?text=${text}`, "t3code");

    assert.equal(result._tag, "InvalidPromptLink");
  });

  it("rejects malformed flags and unknown paths", () => {
    assert.equal(
      parseDesktopPromptLink("t3code://prompt?text=hi&focus=yes", "t3code")._tag,
      "InvalidPromptLink",
    );
    assert.equal(
      parseDesktopPromptLink("t3code://prompt/extra?text=hi", "t3code")._tag,
      "InvalidPromptLink",
    );
  });
});

describe("findDesktopPromptLinkInArgv", () => {
  it("finds the prompt link among process arguments", () => {
    const result = findDesktopPromptLinkInArgv(
      ["/usr/bin/t3code", "--no-sandbox", "t3code://prompt?text=hi"],
      "t3code",
    );

    assert.equal(result._tag, "PromptLink");
  });

  it("ignores arguments without a prompt link", () => {
    assert.deepEqual(findDesktopPromptLinkInArgv(["/usr/bin/t3code", "t3code://app/"], "t3code"), {
      _tag: "NotPromptLink",
    });
  });
});

describe("isBackgroundPromptLinkArgv", () => {
  it("is true only for a prompt link that did not ask for focus", () => {
    assert.isTrue(isBackgroundPromptLinkArgv(["t3code://prompt?text=hi"], "t3code"));
    assert.isFalse(isBackgroundPromptLinkArgv(["t3code://prompt?text=hi&focus=1"], "t3code"));
    assert.isFalse(isBackgroundPromptLinkArgv(["t3code://app/"], "t3code"));
  });
});
