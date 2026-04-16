import { describe, expect, it } from "vitest";
import { ProjectId } from "@t3tools/contracts";

import {
  parseScheduledJobManifest,
  scheduledJobIdForManifest,
  T3_JOB_MANIFEST_RELATIVE_PATH,
} from "./jobManifests.ts";

describe("parseScheduledJobManifest", () => {
  it("parses project-local T3 job manifests", () => {
    const result = parseScheduledJobManifest(
      JSON.stringify({
        jobs: [
          {
            id: "repo-health",
            title: "Repo health",
            intervalHours: 6,
            prompt: "Check the repo for failing builds.",
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
            runtimeMode: "approval-required",
            interactionMode: "plan",
            status: "paused",
          },
        ],
      }),
      null,
    );

    expect(result.errors).toEqual([]);
    expect(result.jobs).toEqual([
      {
        localId: "repo-health",
        title: "Repo health",
        intervalMinutes: 360,
        prompt: "Check the repo for failing builds.",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        status: "paused",
      },
    ]);
  });

  it("uses project defaults and rejects non-hourly intervals", () => {
    const result = parseScheduledJobManifest(
      JSON.stringify({
        jobs: [
          {
            id: "valid",
            title: "Valid",
            intervalHours: 1,
            prompt: "Run checks.",
          },
          {
            id: "bad",
            title: "Bad",
            intervalMinutes: 30,
            prompt: "Run too often.",
          },
        ],
      }),
      { provider: "codex", model: "gpt-5.4" },
    );

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.modelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.4",
    });
    expect(result.errors).toEqual([
      "jobs[1]: expected an hourly interval from 1 hour through 7 days.",
    ]);
  });
});

describe("scheduledJobIdForManifest", () => {
  it("derives stable ids from the project and manifest-local id", () => {
    expect(scheduledJobIdForManifest(ProjectId.make("project-1"), "repo-health")).toBe(
      "manifest:project-1:repo-health",
    );
    expect(T3_JOB_MANIFEST_RELATIVE_PATH).toBe(".t3/jobs.json");
  });
});
