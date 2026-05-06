import { describe, expect, it } from "vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";

import {
  applyScheduledJobManifestPatch,
  parseScheduledJobManifest,
  parseScheduledJobManifestId,
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
          instanceId: ProviderInstanceId.make("claudeAgent"),
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
      { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    );

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
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
    expect(parseScheduledJobManifestId("manifest:project-1:repo-health")).toEqual({
      projectId: "project-1",
      localId: "repo-health",
    });
    expect(parseScheduledJobManifestId("user-created-job")).toBeNull();
    expect(T3_JOB_MANIFEST_RELATIVE_PATH).toBe(".t3/jobs.json");
  });
});

describe("applyScheduledJobManifestPatch", () => {
  it("writes edited fields back to object manifests", () => {
    const result = applyScheduledJobManifestPatch(
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "repo-health",
            title: "Repo health",
            intervalHours: 6,
            prompt: "Check the repo.",
            provider: "codex",
            model: "gpt-5.4",
            runtimeMode: "approval-required",
            interactionMode: "default",
            keepMe: true,
          },
        ],
      }),
      "repo-health",
      {
        type: "update",
        title: "Updated repo health",
        prompt: "Check CI and lint.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        schedule: {
          type: "interval",
          intervalMinutes: 180,
        },
      },
    );

    expect(result.errors).toEqual([]);
    expect(result.changed).toBe(true);
    expect(JSON.parse(result.rawJson)).toEqual({
      version: 1,
      jobs: [
        {
          id: "repo-health",
          title: "Updated repo health",
          intervalMinutes: 180,
          prompt: "Check CI and lint.",
          instanceId: "claudeAgent",
          model: "claude-sonnet-4-6",
          runtimeMode: "full-access",
          interactionMode: "plan",
          keepMe: true,
        },
      ],
    });
  });

  it("writes status changes and deletes top-level array entries", () => {
    const paused = applyScheduledJobManifestPatch(
      JSON.stringify([
        {
          id: "repo-health",
          title: "Repo health",
          intervalHours: 6,
          prompt: "Check the repo.",
        },
        {
          id: "second",
          title: "Second",
          intervalHours: 12,
          prompt: "Check another repo.",
        },
      ]),
      "repo-health",
      {
        type: "status",
        status: "paused",
      },
    );

    expect(paused.errors).toEqual([]);
    expect(JSON.parse(paused.rawJson)[0].status).toBe("paused");

    const deleted = applyScheduledJobManifestPatch(paused.rawJson, "repo-health", {
      type: "delete",
    });

    expect(deleted.errors).toEqual([]);
    expect(JSON.parse(deleted.rawJson)).toEqual([
      {
        id: "second",
        title: "Second",
        intervalHours: 12,
        prompt: "Check another repo.",
      },
    ]);
  });

  it("does not rewrite missing entries or invalid manifests", () => {
    expect(
      applyScheduledJobManifestPatch(JSON.stringify({ jobs: [] }), "missing", { type: "delete" }),
    ).toEqual({
      rawJson: JSON.stringify({ jobs: [] }),
      changed: false,
      errors: [],
    });

    const invalid = applyScheduledJobManifestPatch("{", "repo-health", { type: "delete" });
    expect(invalid.changed).toBe(false);
    expect(invalid.errors).toHaveLength(1);
  });
});
