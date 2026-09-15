import {
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  type DesktopAppSubmitPromptRequest,
} from "@t3tools/contracts";

// `t3code://prompt?text=…` lets launchers such as Raycast hand a prompt to the
// running app. It is a separate host from `app` (the renderer origin) and
// `threads` (navigation), so those keep their existing handling untouched.
const DESKTOP_PROMPT_LINK_HOST = "prompt";
export const DESKTOP_PROMPT_LINK_MAX_TEXT_CHARS = PROVIDER_SEND_TURN_MAX_INPUT_CHARS;

export type DesktopPromptLink = Omit<DesktopAppSubmitPromptRequest, "version" | "requestId">;

export type DesktopPromptLinkParseResult =
  | { readonly _tag: "PromptLink"; readonly link: DesktopPromptLink }
  | { readonly _tag: "NotPromptLink" }
  | { readonly _tag: "InvalidPromptLink"; readonly reason: string };

const NOT_PROMPT_LINK: DesktopPromptLinkParseResult = { _tag: "NotPromptLink" };

const invalid = (reason: string): DesktopPromptLinkParseResult => ({
  _tag: "InvalidPromptLink",
  reason,
});

function readFlag(
  params: URLSearchParams,
  name: string,
  fallback: boolean,
): boolean | DesktopPromptLinkParseResult {
  const value = params.get(name);
  if (value === null) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return invalid(`"${name}" must be 1 or 0.`);
}

function readOptionalId(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Parses one inbound URL against the scheme this build owns (`t3code` in the
 * packaged app, `t3code-dev` in development). Query values are percent-decoded
 * exactly once by `URLSearchParams`; the caller must not decode again.
 */
export function parseDesktopPromptLink(url: string, scheme: string): DesktopPromptLinkParseResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NOT_PROMPT_LINK;
  }
  if (parsed.protocol !== `${scheme}:` || parsed.host !== DESKTOP_PROMPT_LINK_HOST) {
    return NOT_PROMPT_LINK;
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    return invalid(`Unknown prompt link path "${parsed.pathname}".`);
  }

  const params = parsed.searchParams;
  const text = params.get("text")?.trim() ?? "";
  if (text.length === 0) {
    return invalid('"text" is required and cannot be empty.');
  }
  if (text.length > DESKTOP_PROMPT_LINK_MAX_TEXT_CHARS) {
    return invalid(
      `"text" is ${text.length - DESKTOP_PROMPT_LINK_MAX_TEXT_CHARS} characters over the ${DESKTOP_PROMPT_LINK_MAX_TEXT_CHARS}-character limit.`,
    );
  }
  const submit = readFlag(params, "submit", true);
  if (typeof submit !== "boolean") return submit;
  const focus = readFlag(params, "focus", false);
  if (typeof focus !== "boolean") return focus;
  const environmentId = readOptionalId(params, "environment");
  const threadId = readOptionalId(params, "thread");

  return {
    _tag: "PromptLink",
    link: {
      type: "submit-prompt",
      text,
      submit,
      focus,
      ...(environmentId === null ? {} : { environmentId: EnvironmentId.make(environmentId) }),
      ...(threadId === null ? {} : { threadId: ThreadId.make(threadId) }),
    },
  };
}

/**
 * Windows and Linux deliver protocol URLs as a process argument, both on a
 * cold start and through `second-instance`. Only the first prompt link counts.
 */
export function findDesktopPromptLinkInArgv(
  argv: ReadonlyArray<string>,
  scheme: string,
): DesktopPromptLinkParseResult {
  for (const argument of argv) {
    if (!argument.startsWith(`${scheme}://`)) continue;
    const result = parseDesktopPromptLink(argument, scheme);
    if (result._tag !== "NotPromptLink") return result;
  }
  return NOT_PROMPT_LINK;
}

/** True when the arguments carry a prompt link that asked to stay in the background. */
export function isBackgroundPromptLinkArgv(argv: ReadonlyArray<string>, scheme: string): boolean {
  const result = findDesktopPromptLinkInArgv(argv, scheme);
  return result._tag === "PromptLink" && !result.link.focus;
}
