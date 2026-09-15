import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppActivationRequest,
  type DesktopAppActivationDependencies,
} from "./desktopAppActivation";

const environmentId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("project-existing");
const createdProjectId = ProjectId.make("project-created");
const threadId = ThreadId.make("thread-1");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
} as const;

function dependencies(
  overrides: Partial<DesktopAppActivationDependencies> = {},
): DesktopAppActivationDependencies {
  return {
    getTarget: () => ({ environmentId, platform: "linux" }),
    findProject: () => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }),
    createProject: vi.fn(async () => createdProjectId),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId })),
    resolveEnvironment: (requested) => requested ?? environmentId,
    findThread: () => ({ projectId: existingProjectId }),
    resolveDefaultProject: () => existingProjectId,
    startTurn: vi.fn(async () => threadId),
    stagePrompt: vi.fn(async () => threadId),
    ...overrides,
  };
}

const promptRequest = {
  version: 1,
  requestId: "prompt-1",
  type: "submit-prompt",
  text: "fix the flaky test",
  submit: true,
  focus: false,
} as const;

describe("desktop app activation", () => {
  it("reuses an existing project and opens a new thread", async () => {
    const deps = dependencies();

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).toHaveBeenCalledWith({ environmentId, projectId: existingProjectId });
    expect(response).toEqual({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: existingProjectId,
      threadId,
    });
  });

  it("waits for a created project before it opens the thread", async () => {
    const order: string[] = [];
    const deps = dependencies({
      findProject: () => null,
      createProject: vi.fn(async () => {
        order.push("create");
        return createdProjectId;
      }),
      waitForProject: vi.fn(async () => {
        order.push("project-event");
      }),
      openThread: vi.fn(async () => {
        order.push("open-thread");
        return { threadId };
      }),
    });

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(order).toEqual(["create", "project-event", "open-thread"]);
    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
  });

  it("rejects a Windows path when the primary environment is WSL", async () => {
    const response = await handleDesktopAppActivationRequest(
      { ...request, platform: "win32" },
      dependencies({ getTarget: () => ({ environmentId, platform: "linux" }) }),
    );

    expect(response).toMatchObject({ ok: false, code: "platform-mismatch" });
  });

  it("returns a project error without opening a thread", async () => {
    const openThread = vi.fn(async () => ({ threadId }));
    const response = await handleDesktopAppActivationRequest(
      request,
      dependencies({
        findProject: () => null,
        createProject: vi.fn(async () => {
          throw new Error("Project path is not available.");
        }),
        openThread,
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      code: "project-create-failed",
      message: "Project path is not available.",
    });
    expect(openThread).not.toHaveBeenCalled();
  });
});

describe("desktop prompt links", () => {
  it("starts a turn in a new thread of the default project", async () => {
    const deps = dependencies();

    const response = await handleDesktopAppActivationRequest(promptRequest, deps);

    expect(deps.startTurn).toHaveBeenCalledWith({
      environmentId,
      projectId: existingProjectId,
      threadId: null,
      text: promptRequest.text,
    });
    expect(deps.stagePrompt).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
    expect(response).toEqual({
      version: 1,
      requestId: promptRequest.requestId,
      ok: true,
      projectId: existingProjectId,
      threadId,
    });
  });

  it("appends to the requested thread in the requested environment", async () => {
    const otherEnvironmentId = EnvironmentId.make("remote");
    const existingThreadId = ThreadId.make("thread-existing");
    const deps = dependencies({
      findThread: vi.fn(() => ({ projectId: createdProjectId })),
      startTurn: vi.fn(async ({ threadId: target }) => target ?? threadId),
    });

    const response = await handleDesktopAppActivationRequest(
      { ...promptRequest, environmentId: otherEnvironmentId, threadId: existingThreadId },
      deps,
    );

    expect(deps.findThread).toHaveBeenCalledWith({
      environmentId: otherEnvironmentId,
      threadId: existingThreadId,
    });
    expect(deps.startTurn).toHaveBeenCalledWith({
      environmentId: otherEnvironmentId,
      projectId: createdProjectId,
      threadId: existingThreadId,
      text: promptRequest.text,
    });
    expect(response).toMatchObject({ ok: true, threadId: existingThreadId });
  });

  it("stages the text without sending when submit is off", async () => {
    const deps = dependencies();

    const response = await handleDesktopAppActivationRequest(
      { ...promptRequest, submit: false },
      deps,
    );

    expect(deps.startTurn).not.toHaveBeenCalled();
    expect(deps.stagePrompt).toHaveBeenCalledWith({
      environmentId,
      projectId: existingProjectId,
      threadId: null,
      text: promptRequest.text,
    });
    expect(response).toMatchObject({ ok: true, threadId });
  });

  it("fails when the environment, thread, or project is missing", async () => {
    await expect(
      handleDesktopAppActivationRequest(
        promptRequest,
        dependencies({ resolveEnvironment: () => null }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "environment-unavailable" });
    await expect(
      handleDesktopAppActivationRequest(
        { ...promptRequest, threadId: ThreadId.make("missing") },
        dependencies({ findThread: () => null }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "thread-unavailable" });
    await expect(
      handleDesktopAppActivationRequest(
        promptRequest,
        dependencies({ resolveDefaultProject: () => null }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "project-unavailable" });
  });

  it("reports a turn that could not start", async () => {
    const response = await handleDesktopAppActivationRequest(
      promptRequest,
      dependencies({
        startTurn: vi.fn(async () => {
          throw new Error("No provider is available to start a thread.");
        }),
      }),
    );

    expect(response).toEqual({
      version: 1,
      requestId: promptRequest.requestId,
      ok: false,
      code: "turn-start-failed",
      message: "No provider is available to start a thread.",
    });
  });
});
