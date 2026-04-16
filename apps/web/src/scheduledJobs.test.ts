import { describe, expect, it } from "vitest";

import { ProjectId } from "@t3tools/contracts";

import {
  buildScheduledJobCreateCommand,
  parseScheduleSlashCommand,
  SCHEDULE_SLASH_COMMAND_USAGE,
} from "./scheduledJobs";

describe("parseScheduleSlashCommand", () => {
  it("returns null for non-schedule messages", () => {
    expect(parseScheduleSlashCommand("hello")).toBeNull();
  });

  it("parses hour-based schedule commands and derives a title from the prompt", () => {
    expect(
      parseScheduleSlashCommand("/schedule every 6h Check the repo for build failures"),
    ).toEqual({
      kind: "match",
      intervalHours: 6,
      title: "Check the repo for build failures",
      prompt: "Check the repo for build failures",
    });
  });

  it("parses explicit titles separated by double colons", () => {
    expect(
      parseScheduleSlashCommand(
        "/schedule 2 days Dependency watchdog :: Check the project for dependency drift",
      ),
    ).toEqual({
      kind: "match",
      intervalHours: 48,
      title: "Dependency watchdog",
      prompt: "Check the project for dependency drift",
    });
  });

  it("rejects missing or malformed schedule details", () => {
    expect(parseScheduleSlashCommand("/schedule")).toEqual({
      kind: "error",
      error: SCHEDULE_SLASH_COMMAND_USAGE,
    });
    expect(parseScheduleSlashCommand("/schedule every 30m Ping")).toEqual({
      kind: "error",
      error: SCHEDULE_SLASH_COMMAND_USAGE,
    });
  });

  it("rejects intervals outside the supported scheduler range", () => {
    expect(parseScheduleSlashCommand("/schedule every 8 days Review the repo")).toEqual({
      kind: "error",
      error: "Scheduled jobs currently support intervals between 1 hour and 7 days.",
    });
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
