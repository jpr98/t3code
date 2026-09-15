import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type DesktopAppActivationRequest,
  type EnvironmentId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { truncate } from "@t3tools/shared/String";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  handleDesktopAppActivationRequest,
  type DesktopAppPromptInput,
} from "../../desktopAppActivation";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newMessageId, newProjectId, newThreadId } from "../../lib/utils";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readProjects, readThreadShell, waitForProject } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForStartedServerThread } from "../ChatView.logic";

export function DesktopAppActivationCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const router = useRouter();
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  const shell = useEnvironmentQuery(
    primaryEnvironment === null
      ? null
      : environmentShell.stateAtom(primaryEnvironment.environmentId),
  );
  const ready =
    activation !== undefined &&
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null &&
    shell.data?.snapshot._tag === "Some";

  const readServerConfig = (environmentId: EnvironmentId) => {
    const presentation = appAtomRegistry
      .get(environmentPresentations.presentationsAtom)
      .get(environmentId);
    return presentation?.connection.phase === "connected" ? presentation.serverConfig : null;
  };

  // A prompt link starts its turn straight through the command pipeline: no
  // draft, no composer. A new thread takes the defaults a fresh composer send
  // would (project default model, else the sticky pick, else the provider
  // default; the project's configured runtime mode; the local checkout).
  const startPromptTurn = async (input: DesktopAppPromptInput) => {
    const serverConfig = readServerConfig(input.environmentId);
    if (serverConfig === null) {
      throw new Error("The environment is not connected.");
    }
    const createdAt = new Date().toISOString();
    const message = {
      messageId: newMessageId(),
      role: "user" as const,
      text: input.text,
      attachments: [],
    };
    if (input.threadId !== null) {
      const thread = readThreadShell(scopeThreadRef(input.environmentId, input.threadId));
      if (thread === null) {
        throw new Error("The thread is no longer available.");
      }
      const result = await startThreadTurn({
        environmentId: input.environmentId,
        input: {
          threadId: input.threadId,
          message,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      return input.threadId;
    }

    const project = readProjects().find(
      (candidate) =>
        candidate.id === input.projectId && candidate.environmentId === input.environmentId,
    );
    const projectSettings = resolveProjectSettings(serverConfig.settings, input.projectId, project);
    const draftStore = useComposerDraftStore.getState();
    const stickyModelSelection =
      draftStore.stickyActiveProvider === null
        ? null
        : (draftStore.stickyModelSelectionByProvider[draftStore.stickyActiveProvider] ?? null);
    const modelSelection = resolveDefaultProviderModelSelection(
      serverConfig.providers,
      projectSettings.settings.defaultModelSelection ?? stickyModelSelection,
    );
    if (modelSelection === null) {
      throw new Error("No provider is available to start a thread.");
    }
    const runtimeMode = projectSettings.settings.defaultRuntimeMode;
    const interactionMode = DEFAULT_PROVIDER_INTERACTION_MODE;
    const title = truncate(input.text.replace(/\s+/g, " "));
    const threadId = newThreadId();
    const result = await startThreadTurn({
      environmentId: input.environmentId,
      input: {
        threadId,
        message,
        modelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        bootstrap: {
          createThread: {
            projectId: input.projectId,
            title,
            modelSelection,
            runtimeMode,
            interactionMode,
            branch: null,
            worktreePath: null,
            createdAt,
          },
        },
        createdAt,
      },
    });
    if (result._tag === "Failure") {
      throw squashAtomCommandFailure(result);
    }
    return threadId;
  };

  const stagePrompt = async (input: DesktopAppPromptInput) => {
    const draftStore = useComposerDraftStore.getState();
    if (input.threadId !== null) {
      draftStore.setPrompt(scopeThreadRef(input.environmentId, input.threadId), input.text);
      return input.threadId;
    }
    const opened = await handleNewThread({
      environmentId: input.environmentId,
      projectId: input.projectId,
    });
    if (opened === null) return null;
    draftStore.setPrompt(opened.draftId, input.text);
    return opened.threadId;
  };

  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) => {
    const response = await handleDesktopAppActivationRequest(request, {
      getTarget: () => {
        if (
          primaryEnvironment?.connection.phase !== "connected" ||
          primaryEnvironment.serverConfig === null
        ) {
          return null;
        }
        return {
          environmentId: primaryEnvironment.environmentId,
          platform: primaryEnvironment.serverConfig.environment.platform.os,
        };
      },
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: (projectRef) => handleNewThread(projectRef),
      resolveEnvironment: (environmentId) => {
        const target = environmentId ?? primaryEnvironment?.environmentId ?? null;
        return target !== null && readServerConfig(target) !== null ? target : null;
      },
      findThread: (threadRef) => readThreadShell(threadRef),
      resolveDefaultProject: (environmentId) => {
        const contextRef = resolveThreadActionProjectRef({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        if (contextRef?.environmentId === environmentId) return contextRef.projectId;
        return (
          readProjects().find((project) => project.environmentId === environmentId)?.id ?? null
        );
      },
      startTurn: startPromptTurn,
      stagePrompt,
    });
    // Only a link that asked for focus gets to move the user to the new thread.
    if (request.type === "submit-prompt" && request.submit && request.focus && response.ok) {
      const environmentId = request.environmentId ?? primaryEnvironment?.environmentId ?? null;
      if (environmentId !== null) {
        await waitForStartedServerThread(scopeThreadRef(environmentId, response.threadId));
        await router
          .navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: response.threadId },
          })
          .catch(() => undefined);
      }
    }
    return response;
  });

  useEffect(() => {
    if (!ready || activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
    });
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (subscribed) void activation.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation, ready]);

  return null;
}
