import type {
  DesktopAppActivationFailure,
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
  DesktopAppOpenWorkspaceRequest,
  DesktopAppSubmitPromptRequest,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

export interface DesktopAppActivationProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface DesktopAppActivationTarget {
  readonly environmentId: EnvironmentId;
  readonly platform: ExecutionEnvironmentPlatformOs;
}

export interface DesktopAppPromptInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Null means a new thread, like a fresh composer send. */
  readonly threadId: ThreadId | null;
  readonly text: string;
}

export interface DesktopAppActivationDependencies {
  readonly getTarget: () => DesktopAppActivationTarget | null;
  readonly findProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => DesktopAppActivationProject | null;
  readonly createProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => Promise<ProjectId>;
  readonly waitForProject: (projectRef: ScopedProjectRef) => Promise<void>;
  readonly openThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly threadId: ThreadId } | null>;
  /** Null asks for the primary environment; returns null unless it accepts commands. */
  readonly resolveEnvironment: (environmentId: EnvironmentId | null) => EnvironmentId | null;
  readonly findThread: (threadRef: ScopedThreadRef) => { readonly projectId: ProjectId } | null;
  /** The project a fresh composer send would land in for this environment. */
  readonly resolveDefaultProject: (environmentId: EnvironmentId) => ProjectId | null;
  /** Starts the turn through the command pipeline; resolves with the thread it ran in. */
  readonly startTurn: (input: DesktopAppPromptInput) => Promise<ThreadId>;
  /** Puts the text in a composer without sending; null when no draft could be opened. */
  readonly stagePrompt: (input: DesktopAppPromptInput) => Promise<ThreadId | null>;
}

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return { version: 1, requestId, ok: false, code, message };
}

function desktopPlatformToEnvironmentOs(
  platform: DesktopAppOpenWorkspaceRequest["platform"],
): ExecutionEnvironmentPlatformOs {
  return platform === "win32" ? "windows" : platform;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

async function handleOpenWorkspaceRequest(
  request: DesktopAppOpenWorkspaceRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  const target = dependencies.getTarget();
  if (target === null) {
    return failure(
      request.requestId,
      "environment-unavailable",
      "The desktop app's primary local environment is not connected.",
    );
  }

  const requestPlatform = desktopPlatformToEnvironmentOs(request.platform);
  if (requestPlatform !== target.platform) {
    return failure(
      request.requestId,
      "platform-mismatch",
      `The command path is for ${requestPlatform}, but the desktop app's primary environment uses ${target.platform}. Cross-platform path mapping is not supported.`,
    );
  }

  let projectId = dependencies.findProject(target.environmentId, request.workspaceRoot)?.id ?? null;
  if (projectId === null) {
    try {
      projectId = await dependencies.createProject(target.environmentId, request.workspaceRoot);
      await dependencies.waitForProject({ environmentId: target.environmentId, projectId });
    } catch (error) {
      return failure(
        request.requestId,
        "project-create-failed",
        errorMessage(error, "T3 Code could not add the project."),
      );
    }
  }

  try {
    const opened = await dependencies.openThread({
      environmentId: target.environmentId,
      projectId,
    });
    if (opened === null) {
      return failure(
        request.requestId,
        "thread-open-failed",
        "T3 Code could not open a new thread for the project.",
      );
    }
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId,
      threadId: opened.threadId,
    };
  } catch (error) {
    return failure(
      request.requestId,
      "thread-open-failed",
      errorMessage(error, "T3 Code could not open a new thread for the project."),
    );
  }
}

async function handleSubmitPromptRequest(
  request: DesktopAppSubmitPromptRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  const environmentId = dependencies.resolveEnvironment(request.environmentId ?? null);
  if (environmentId === null) {
    return failure(
      request.requestId,
      "environment-unavailable",
      request.environmentId === undefined
        ? "The desktop app's primary environment is not connected."
        : `Environment "${request.environmentId}" is not connected.`,
    );
  }

  let projectId: ProjectId;
  if (request.threadId !== undefined) {
    const thread = dependencies.findThread({ environmentId, threadId: request.threadId });
    if (thread === null) {
      return failure(
        request.requestId,
        "thread-unavailable",
        `Thread "${request.threadId}" was not found in the environment.`,
      );
    }
    projectId = thread.projectId;
  } else {
    const defaultProjectId = dependencies.resolveDefaultProject(environmentId);
    if (defaultProjectId === null) {
      return failure(
        request.requestId,
        "project-unavailable",
        "Add a project in T3 Code before sending it a prompt.",
      );
    }
    projectId = defaultProjectId;
  }

  const input: DesktopAppPromptInput = {
    environmentId,
    projectId,
    threadId: request.threadId ?? null,
    text: request.text,
  };
  try {
    const threadId = request.submit
      ? await dependencies.startTurn(input)
      : await dependencies.stagePrompt(input);
    if (threadId === null) {
      return failure(
        request.requestId,
        "thread-open-failed",
        "T3 Code could not open a draft for the prompt.",
      );
    }
    return { version: 1, requestId: request.requestId, ok: true, projectId, threadId };
  } catch (error) {
    return request.submit
      ? failure(
          request.requestId,
          "turn-start-failed",
          errorMessage(error, "T3 Code could not start the turn."),
        )
      : failure(
          request.requestId,
          "thread-open-failed",
          errorMessage(error, "T3 Code could not open a draft for the prompt."),
        );
  }
}

export async function handleDesktopAppActivationRequest(
  request: DesktopAppActivationRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  switch (request.type) {
    case "open-workspace":
      return handleOpenWorkspaceRequest(request, dependencies);
    case "submit-prompt":
      return handleSubmitPromptRequest(request, dependencies);
  }
}
