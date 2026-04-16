import { describe, expect, it } from "vitest";

import { ProjectId } from "@t3tools/contracts";

import {
  buildScheduledJobCreateCommand,
  JOB_SLASH_COMMAND_USAGE,
  parseJobSlashCommand,
} from "./scheduledJobs";

describe("parseJobSlashCommand", () => {
  it("returns null for non-job messages", () => {
    expect(parseJobSlashCommand("hello")).toBeNull();
  });

  it("turns the command body into injected job-creation instructions", () => {
    const parsed = parseJobSlashCommand("/job every 6h Check the repo for build failures");

    expect(parsed?.kind).toBe("match");
    if (parsed?.kind !== "match") {
      throw new Error("expected matching job command");
    }
    expect(parsed.content).toBe("every 6h Check the repo for build failures");
    expect(parsed.injectedPrompt).toContain("T3 Code's /job helper");
    expect(parsed.injectedPrompt).toContain("T3 Code scheduled job rules:");
    expect(parsed.injectedPrompt).toContain("User job content:");
    expect(parsed.injectedPrompt).toContain("every 6h Check the repo for build failures");
  });

  it("preserves the rest of the message as job content without parsing it locally", () => {
    const parsed = parseJobSlashCommand(
      "/job 2 days Dependency watchdog :: Check the project for dependency drift",
    );

    expect(parsed).toMatchObject({
      kind: "match",
      content: "2 days Dependency watchdog :: Check the project for dependency drift",
    });
  });

  it("rejects empty job commands", () => {
    expect(parseJobSlashCommand("/job")).toEqual({
      kind: "error",
      error: JOB_SLASH_COMMAND_USAGE,
    });
  });

  it("does not intercept Claude-native /schedule commands", () => {
    expect(parseJobSlashCommand("/schedule every 6h Check the repo")).toBeNull();
  });
});

describe("buildScheduledJobCreateCommand", () => {
  it("builds a scheduled-job.create command with interval minutes", () => {
    const command = buildScheduledJobCreateCommand({
      projectId: ProjectId.make("project-1"),
      title: "Nightly review",
      prompt: "Review the project for regressions",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      intervalHours: 12,
      createdAt: "2026-04-16T12:00:00.000Z",
    });

    expect(command).toMatchObject({
      type: "scheduled-job.create",
      projectId: ProjectId.make("project-1"),
      title: "Nightly review",
      prompt: "Review the project for regressions",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      schedule: {
        type: "interval",
        intervalMinutes: 720,
      },
      createdAt: "2026-04-16T12:00:00.000Z",
    });
    expect(String(command.commandId).length).toBeGreaterThan(0);
    expect(String(command.jobId).length).toBeGreaterThan(0);
  });
});
