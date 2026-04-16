import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 4,
    updatedAt: "2026-04-12T12:00:00.000Z",
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: { provider: "codex", model: "gpt-5.4" },
        scripts: [],
        createdAt: "2026-04-12T12:00:00.000Z",
        updatedAt: "2026-04-12T12:00:00.000Z",
        deletedAt: null,
      },
    ],
    scheduledJobs: [],
    threads: [
      {
        id: ThreadId.make("thread-source"),
        projectId: ProjectId.make("project-1"),
        title: "Investigate auth bug",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/auth-bug",
        worktreePath: "/tmp/project/worktrees/auth-bug",
        latestTurn: null,
        queuedFollowUps: [],
        forkOrigin: null,
        createdAt: "2026-04-12T12:00:00.000Z",
        updatedAt: "2026-04-12T12:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        messages: [
          {
            id: MessageId.make("message-user-1"),
            role: "user",
            text: "Please debug the auth bug.",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-04-12T12:01:00.000Z",
            updatedAt: "2026-04-12T12:01:00.000Z",
          },
          {
            id: MessageId.make("message-assistant-1"),
            role: "assistant",
            text: "I’m checking the login flow now.",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-04-12T12:02:00.000Z",
            updatedAt: "2026-04-12T12:02:00.000Z",
          },
          {
            id: MessageId.make("message-user-2"),
            role: "user",
            text: "Focus on the OAuth callback.",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-04-12T12:03:00.000Z",
            updatedAt: "2026-04-12T12:03:00.000Z",
          },
        ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
  };
}

describe("decideOrchestrationCommand thread.fork", () => {
  it("creates a forked thread and copies messages before the selected user message", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: makeReadModel(),
        command: {
          type: "thread.fork",
          commandId: CommandId.make("cmd-thread-fork"),
          threadId: ThreadId.make("thread-fork"),
          sourceThreadId: ThreadId.make("thread-source"),
          sourceMessageId: MessageId.make("message-user-2"),
          createdAt: "2026-04-12T12:05:00.000Z",
        },
      }),
    );
    expect(Array.isArray(decided)).toBe(true);
    if (!Array.isArray(decided)) {
      throw new Error("Expected thread.fork to emit multiple events.");
    }
    const events = decided;

    expect(events.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.message-sent",
      "thread.message-sent",
    ]);

    const [threadCreated, ...messageEvents] = events;
    expect(threadCreated?.payload).toMatchObject({
      threadId: ThreadId.make("thread-fork"),
      projectId: ProjectId.make("project-1"),
      title: "Investigate auth bug (fork)",
      branch: "feature/auth-bug",
      worktreePath: "/tmp/project/worktrees/auth-bug",
      forkOrigin: {
        sourceThreadId: ThreadId.make("thread-source"),
        sourceMessageId: MessageId.make("message-user-2"),
        hydratedAt: null,
      },
    });

    expect(messageEvents.map((event) => event.payload.role)).toEqual(["user", "assistant"]);
    expect(messageEvents.map((event) => event.payload.text)).toEqual([
      "Please debug the auth bug.",
      "I’m checking the login flow now.",
    ]);
    expect(messageEvents.every((event) => event.payload.turnId === null)).toBe(true);
    expect(messageEvents.every((event) => event.payload.streaming === false)).toBe(true);
  });

  it("rejects assistant messages as fork points", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel(),
          command: {
            type: "thread.fork",
            commandId: CommandId.make("cmd-thread-fork-invalid"),
            threadId: ThreadId.make("thread-fork"),
            sourceThreadId: ThreadId.make("thread-source"),
            sourceMessageId: MessageId.make("message-assistant-1"),
            createdAt: "2026-04-12T12:05:00.000Z",
          },
        }),
      ),
    ).rejects.toThrow("Only user messages can be used as fork points.");
  });
});
