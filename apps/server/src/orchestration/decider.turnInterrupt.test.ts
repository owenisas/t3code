// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const threadId = ThreadId.make("thread-interrupt");
const turnId = TurnId.make("turn-interrupt");

async function createReadModelWithRunningTurn(now: string) {
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-interrupt"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-project-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-interrupt"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  const withThread = await Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: asEventId("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-thread-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId,
        projectId: asProjectId("project-interrupt"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "default",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  return Effect.runPromise(
    projectEvent(withThread, {
      sequence: 3,
      eventId: asEventId("evt-session-set"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.session-set",
      occurredAt: now,
      commandId: CommandId.make("cmd-session-set"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-session-set"),
      metadata: {},
      payload: {
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "cursor",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
      },
    }),
  );
}

describe("decideOrchestrationCommand thread.turn.interrupt", () => {
  it("defaults the interrupt event to the active session turn id", async () => {
    const now = new Date().toISOString();
    const readModel = await createReadModelWithRunningTurn(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-turn-interrupt"),
          threadId,
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(result).toMatchObject({
      type: "thread.turn-interrupt-requested",
      payload: {
        threadId,
        turnId,
      },
    });
  });
});
