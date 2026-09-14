import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import {
  findDesktopPromptLinkInArgv,
  parseDesktopPromptLink,
  type DesktopPromptLinkParseResult,
} from "./DesktopPromptLink.ts";

// Receives `t3code://prompt` links from every delivery path the OS uses and
// hands them to the activation broker, which holds them until the renderer
// can dispatch commands. macOS emits `open-url` (possibly before `ready`, so
// registration happens before `whenReady`); Windows and Linux pass the URL as
// a process argument, on a cold start or via `second-instance` when the app
// already runs. The Linux `.desktop` handler entry forwards the URL as `%U`,
// so it lands on the same argv path.
const { logWarning } = makeComponentLogger("desktop-prompt-link");

export class DesktopPromptLinkHandler extends Context.Service<
  DesktopPromptLinkHandler,
  {
    readonly register: (
      launchArgv: ReadonlyArray<string>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/app/DesktopPromptLinkHandler") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const activation = yield* DesktopAppActivation.DesktopAppActivation;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const handle = Effect.fn("desktop.promptLink.handle")(function* (
    result: DesktopPromptLinkParseResult,
    source: "open-url" | "second-instance" | "launch",
  ) {
    if (result._tag === "NotPromptLink") return;
    if (result._tag === "InvalidPromptLink") {
      yield* logWarning("ignoring invalid prompt link", { source, reason: result.reason });
      return;
    }
    // Without focus=1 the window may still be created (cold start), but it
    // must appear without taking focus. When it is already on screen nothing
    // reveals it: the request runs behind whatever the user is doing.
    if (!result.link.focus) {
      yield* desktopWindow.markBackgroundLaunch;
    }
    yield* activation.submitPrompt(result.link);
  });

  return DesktopPromptLinkHandler.of({
    register: Effect.fn("desktop.promptLink.register")(function* (launchArgv) {
      yield* electronApp.on("open-url", (event: Electron.Event, url: string) => {
        const result = parseDesktopPromptLink(url, scheme);
        if (result._tag === "NotPromptLink") return;
        // Claim the URL so Electron does not treat it as a document to open.
        event.preventDefault();
        void runPromise(handle(result, "open-url"));
      });
      yield* electronApp.on(
        "second-instance",
        (_event: Electron.Event, argv: ReadonlyArray<string>) => {
          void runPromise(handle(findDesktopPromptLinkInArgv(argv, scheme), "second-instance"));
        },
      );
      yield* handle(findDesktopPromptLinkInArgv(launchArgv, scheme), "launch");
    }),
  });
});

export const layer = Layer.effect(DesktopPromptLinkHandler, make);
