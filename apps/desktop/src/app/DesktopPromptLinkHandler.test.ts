import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

// Only service tags are needed; keep the real Electron binary out of the test.
vi.mock("electron", () => ({ app: {}, screen: {}, session: {} }));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import type { DesktopPromptLink } from "./DesktopPromptLink.ts";
import * as DesktopPromptLinkHandler from "./DesktopPromptLinkHandler.ts";

const flush = Effect.yieldNow;

function makeScenario(launchArgv: ReadonlyArray<string> = []) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const submitted: DesktopPromptLink[] = [];
  let backgroundLaunches = 0;
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    isDevelopment: true,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
  const electronApp = {
    on: (eventName: string, listener: (...args: unknown[]) => void) =>
      Effect.sync(() => {
        listeners.set(eventName, listener);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];
  const activation = {
    submitPrompt: (link: DesktopPromptLink) =>
      Effect.sync(() => {
        submitted.push(link);
      }),
  } as unknown as DesktopAppActivation.DesktopAppActivation["Service"];
  const desktopWindow = {
    markBackgroundLaunch: Effect.sync(() => {
      backgroundLaunches += 1;
    }),
  } as unknown as DesktopWindow.DesktopWindow["Service"];
  const layer = DesktopPromptLinkHandler.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(DesktopAppActivation.DesktopAppActivation, activation),
        Layer.succeed(DesktopWindow.DesktopWindow, desktopWindow),
      ),
    ),
  );
  const register = Effect.gen(function* () {
    const handler = yield* DesktopPromptLinkHandler.DesktopPromptLinkHandler;
    yield* handler.register(launchArgv);
  }).pipe(Effect.provide(layer));
  return {
    register,
    listeners,
    submitted,
    backgroundLaunches: () => backgroundLaunches,
  };
}

describe("DesktopPromptLinkHandler", () => {
  it.effect("queues an open-url prompt link without activating the window", () =>
    Effect.gen(function* () {
      const scenario = makeScenario();
      yield* Effect.scoped(scenario.register);
      const openUrl = scenario.listeners.get("open-url");
      assert.isDefined(openUrl);
      let prevented = 0;
      openUrl?.(
        {
          preventDefault: () => {
            prevented += 1;
          },
        },
        "t3code-dev://prompt?text=hello%20there",
      );
      yield* flush;

      assert.equal(prevented, 1);
      assert.deepEqual(scenario.submitted, [
        { type: "submit-prompt", text: "hello there", submit: true, focus: false },
      ]);
      assert.equal(scenario.backgroundLaunches(), 1);
    }),
  );

  it.effect("leaves the background flag alone when focus=1", () =>
    Effect.gen(function* () {
      const scenario = makeScenario();
      yield* Effect.scoped(scenario.register);
      scenario.listeners.get("open-url")?.(
        { preventDefault: () => undefined },
        "t3code-dev://prompt?text=hi&focus=1",
      );
      yield* flush;

      assert.equal(scenario.submitted.length, 1);
      assert.equal(scenario.submitted[0]?.focus, true);
      assert.equal(scenario.backgroundLaunches(), 0);
    }),
  );

  it.effect("ignores URLs for other hosts and the other build's scheme", () =>
    Effect.gen(function* () {
      const scenario = makeScenario();
      yield* Effect.scoped(scenario.register);
      let prevented = 0;
      const event = {
        preventDefault: () => {
          prevented += 1;
        },
      };
      scenario.listeners.get("open-url")?.(event, "t3code-dev://app/oauth/callback?code=1");
      scenario.listeners.get("open-url")?.(event, "t3code://prompt?text=hi");
      scenario.listeners.get("open-url")?.(event, "t3code-dev://prompt");
      yield* flush;

      assert.equal(prevented, 1);
      assert.deepEqual(scenario.submitted, []);
      assert.equal(scenario.backgroundLaunches(), 0);
    }),
  );

  it.effect("reads prompt links from second-instance and launch arguments", () =>
    Effect.gen(function* () {
      const scenario = makeScenario(["/usr/bin/t3code", "t3code-dev://prompt?text=cold"]);
      yield* Effect.scoped(scenario.register);
      assert.deepEqual(
        scenario.submitted.map((link) => link.text),
        ["cold"],
      );

      scenario.listeners.get("second-instance")?.({}, [
        "/usr/bin/t3code",
        "t3code-dev://prompt?text=warm",
      ]);
      yield* flush;
      assert.deepEqual(
        scenario.submitted.map((link) => link.text),
        ["cold", "warm"],
      );
    }),
  );
});
