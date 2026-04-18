import {
  EventId,
  MessageId,
  ProjectId,
  type OrchestrationEvent,
  type ScheduledJob,
  ScheduledJobId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { applyScheduledJobShellEventOverlay, isThreadDetailEvent } from "./ws.ts";

function eventBase(type: OrchestrationEvent["type"]): Omit<OrchestrationEvent, "type" | "payload"> {
  return {
    sequence: 1,
    eventId: EventId.make(`event-${type}`),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-04-18T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

function makeScheduledJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: ScheduledJobId.make("job-1"),
    projectId: ProjectId.make("project-1"),
    title: "Old job",
    prompt: "Old prompt",
    modelSelection: {
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    status: "active",
    schedule: {
      type: "interval",
      intervalMinutes: 360,
    },
    lastRunAt: null,
    nextRunAt: "2026-04-18T06:00:00.000Z",
    lastOutcome: null,
    lastThreadId: null,
    lastError: null,
    activeRun: null,
    runs: [],
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("isThreadDetailEvent", () => {
  it("includes queued follow-up events so active composer state receives queue updates", () => {
    const event: OrchestrationEvent = {
      ...eventBase("thread.follow-up-queued"),
      type: "thread.follow-up-queued",
      payload: {
        threadId: ThreadId.make("thread-1"),
        followUp: {
          id: "follow-up-1",
          messageId: MessageId.make("message-1"),
          text: "Run this after the current turn.",
          attachments: [],
          modelSelection: null,
          queuedAt: "2026-04-18T00:00:00.000Z",
        },
        updatedAt: "2026-04-18T00:00:00.000Z",
      },
    };

    expect(isThreadDetailEvent(event)).toBe(true);
  });

  it("excludes shell-only project events", () => {
    const event: OrchestrationEvent = {
      ...eventBase("project.created"),
      aggregateKind: "project",
      aggregateId: ProjectId.make("project-1"),
      type: "project.created",
      payload: {
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
      },
    };

    expect(isThreadDetailEvent(event)).toBe(false);
  });
});

describe("applyScheduledJobShellEventOverlay", () => {
  it("overlays scheduled-job.updated payload fields onto a stale projection row", () => {
    const staleJob = makeScheduledJob();
    const event: OrchestrationEvent = {
      ...eventBase("scheduled-job.updated"),
      aggregateKind: "scheduled-job",
      aggregateId: staleJob.id,
      type: "scheduled-job.updated",
      payload: {
        jobId: staleJob.id,
        prompt: "New prompt with ERROR RESILIENCE",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        schedule: {
          type: "interval",
          intervalMinutes: 240,
        },
        nextRunAt: "2026-04-18T08:00:00.000Z",
        updatedAt: "2026-04-18T04:00:00.000Z",
      },
    };

    const overlaid = applyScheduledJobShellEventOverlay(staleJob, event);

    expect(overlaid.prompt).toBe("New prompt with ERROR RESILIENCE");
    expect(overlaid.modelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.4",
    });
    expect(overlaid.schedule.intervalMinutes).toBe(240);
    expect(overlaid.updatedAt).toBe("2026-04-18T04:00:00.000Z");
  });
});
