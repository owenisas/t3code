import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ScheduledJobId,
  ScheduledJobRunId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ScheduledJob,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-04-16T12:00:00.000Z";
const projectId = ProjectId.make("project-1");
const jobId = ScheduledJobId.make("job-1");
type DecidedEvent = Omit<OrchestrationEvent, "sequence">;

function expectSingleEvent(result: DecidedEvent | ReadonlyArray<DecidedEvent>): DecidedEvent {
  if (Array.isArray(result)) {
    throw new Error("Expected one event.");
  }
  return result as DecidedEvent;
}

function expectEventArray(
  result: DecidedEvent | ReadonlyArray<DecidedEvent>,
): ReadonlyArray<DecidedEvent> {
  if (!Array.isArray(result)) {
    throw new Error("Expected multiple events.");
  }
  return result as ReadonlyArray<DecidedEvent>;
}

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: jobId,
    projectId,
    title: "Daily review",
    prompt: "Review the project.",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    status: "active",
    schedule: {
      type: "interval",
      intervalMinutes: 240,
    },
    lastRunAt: null,
    nextRunAt: "2026-04-16T16:00:00.000Z",
    lastOutcome: null,
    lastThreadId: null,
    lastError: null,
    activeRun: null,
    runs: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makeReadModel(job: ScheduledJob = makeJob()): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/tmp/project",
        repositoryIdentity: null,
        defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    scheduledJobs: [job],
    threads: [],
  };
}

describe("decideOrchestrationCommand scheduled jobs", () => {
  it("preserves Cursor provider selections when creating jobs", async () => {
    const event = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: {
            ...makeReadModel(),
            scheduledJobs: [],
          },
          command: {
            type: "scheduled-job.create",
            commandId: CommandId.make("cmd-job-create-cursor"),
            jobId,
            projectId,
            title: "Cursor review",
            prompt: "Review with Cursor.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "gpt-5.4",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            schedule: {
              type: "interval",
              intervalMinutes: 60,
            },
            createdAt: "2026-04-16T13:00:00.000Z",
          },
        }),
      ),
    );

    if (event.type !== "scheduled-job.created") {
      throw new Error(`Expected scheduled-job.created, got ${event.type}`);
    }
    const payload = event.payload as { readonly job: ScheduledJob };
    expect(payload.job.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("cursor"),
      model: "gpt-5.4",
    });
  });

  it("updates editable job fields and recomputes the next run for active jobs", async () => {
    const event = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel(),
          command: {
            type: "scheduled-job.update",
            commandId: CommandId.make("cmd-job-update"),
            jobId,
            title: "Updated review",
            prompt: "Review build health.",
            schedule: {
              type: "interval",
              intervalMinutes: 60,
            },
            createdAt: "2026-04-16T13:00:00.000Z",
          },
        }),
      ),
    );

    expect(event.type).toBe("scheduled-job.updated");
    expect(event.payload).toMatchObject({
      jobId,
      title: "Updated review",
      prompt: "Review build health.",
      schedule: {
        type: "interval",
        intervalMinutes: 60,
      },
      nextRunAt: "2026-04-16T14:00:00.000Z",
      updatedAt: "2026-04-16T13:00:00.000Z",
    });
  });

  it("preserves Cursor provider selections when updating jobs", async () => {
    const event = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel(),
          command: {
            type: "scheduled-job.update",
            commandId: CommandId.make("cmd-job-update-cursor"),
            jobId,
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "claude-opus-4-7",
            },
            createdAt: "2026-04-16T13:00:00.000Z",
          },
        }),
      ),
    );

    if (event.type !== "scheduled-job.updated") {
      throw new Error(`Expected scheduled-job.updated, got ${event.type}`);
    }
    const payload = event.payload as { readonly modelSelection?: ScheduledJob["modelSelection"] };
    expect(payload.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("cursor"),
      model: "claude-opus-4-7",
    });
  });

  it("pauses and resumes jobs", async () => {
    const paused = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel(),
          command: {
            type: "scheduled-job.pause",
            commandId: CommandId.make("cmd-job-pause"),
            jobId,
            createdAt: "2026-04-16T13:00:00.000Z",
          },
        }),
      ),
    );

    expect(paused.type).toBe("scheduled-job.paused");
    expect(paused.payload).toMatchObject({
      jobId,
      updatedAt: "2026-04-16T13:00:00.000Z",
    });

    const resumed = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel(makeJob({ status: "paused", nextRunAt: null })),
          command: {
            type: "scheduled-job.resume",
            commandId: CommandId.make("cmd-job-resume"),
            jobId,
            createdAt: "2026-04-16T14:00:00.000Z",
          },
        }),
      ),
    );

    expect(resumed.type).toBe("scheduled-job.resumed");
    expect(resumed.payload).toMatchObject({
      jobId,
      nextRunAt: "2026-04-16T18:00:00.000Z",
      updatedAt: "2026-04-16T14:00:00.000Z",
    });
  });

  it("deletes jobs", async () => {
    const event = expectSingleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel(),
          command: {
            type: "scheduled-job.delete",
            commandId: CommandId.make("cmd-job-delete"),
            jobId,
            createdAt: "2026-04-16T13:00:00.000Z",
          },
        }),
      ),
    );

    expect(event.type).toBe("scheduled-job.deleted");
    expect(event.payload).toEqual({
      jobId,
      deletedAt: "2026-04-16T13:00:00.000Z",
    });
  });

  it("manually runs a job by creating an isolated thread and starting a normal turn", async () => {
    const events = expectEventArray(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel(makeJob({ status: "paused", nextRunAt: null })),
          command: {
            type: "scheduled-job.run.trigger",
            commandId: CommandId.make("cmd-job-run-now"),
            jobId,
            runId: ScheduledJobRunId.make("run-1"),
            threadId: ThreadId.make("thread-job-run-1"),
            messageId: MessageId.make("message-job-run-1"),
            trigger: "manual",
            createdAt: "2026-04-16T13:00:00.000Z",
          },
        }),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
      "scheduled-job.run-started",
    ]);
    expect(events[0]?.payload).toMatchObject({
      threadId: ThreadId.make("thread-job-run-1"),
      projectId,
      title: "Daily review · 2026-04-16 13:00",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    expect(events[1]?.payload).toMatchObject({
      threadId: ThreadId.make("thread-job-run-1"),
      messageId: MessageId.make("message-job-run-1"),
      role: "user",
      text: "Review the project.",
    });
    expect(events[3]?.payload).toMatchObject({
      jobId,
      run: {
        id: ScheduledJobRunId.make("run-1"),
        threadId: ThreadId.make("thread-job-run-1"),
        trigger: "manual",
        outcome: null,
      },
      nextRunAt: null,
      updatedAt: "2026-04-16T13:00:00.000Z",
    });
  });
});
