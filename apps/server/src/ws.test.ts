import {
  EventId,
  MessageId,
  ProjectId,
  type OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isThreadDetailEvent } from "./ws.ts";

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
