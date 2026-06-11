// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  YoloRunId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const threadId = ThreadId.make("thread-yolo");
const runId = YoloRunId.make("run-yolo");

async function createReadModelWithActiveYolo(now: string) {
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-yolo"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-project-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-yolo"),
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
        projectId: asProjectId("project-yolo"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
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
      eventId: asEventId("evt-yolo-start"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.yolo-started",
      occurredAt: now,
      commandId: CommandId.make("cmd-yolo-start"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-yolo-start"),
      metadata: {},
      payload: {
        threadId,
        run: {
          id: runId,
          threadId,
          goal: "Ship the feature",
          status: "active",
          maxIterations: 10,
          triggerDelaySeconds: 0,
          iteration: 0,
          lastReview: null,
          reviews: [],
          lastError: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      },
    }),
  );
}

describe("decider Goal interruption", () => {
  it("stops active Goal before a human turn starts", async () => {
    const now = new Date().toISOString();
    const readModel = await createReadModelWithActiveYolo(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId,
          message: {
            messageId: asMessageId("message-user"),
            role: "user",
            text: "switch to normal mode and do this",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.yolo-stopped",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(events[0]).toMatchObject({
      type: "thread.yolo-stopped",
      payload: {
        threadId,
        runId,
        reason: "Interrupted by user message.",
      },
    });
  });

  it("keeps active Goal when the reviewer dispatches its own follow-up", async () => {
    const now = new Date().toISOString();
    const readModel = await createReadModelWithActiveYolo(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-yolo-follow-up"),
          threadId,
          message: {
            messageId: asMessageId("message-yolo"),
            role: "user",
            text: "Goal reviewer follow-up.",
            attachments: [],
            origin: "yolo-reviewer",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });
});
