import { ProjectId, ScheduledJobId, type ScheduledJob } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  manifestTargetCommandFingerprint,
  resolveManifestScheduledJobTarget,
} from "./ScheduledJobReactor.ts";
import { scheduledJobIdForManifest } from "../jobManifests.ts";

const projectId = ProjectId.make("project-1");
const manifestJobId = scheduledJobIdForManifest(projectId, "social-loop");

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: ScheduledJobId.make("job-1"),
    projectId,
    title: "Social loop",
    prompt: "Run social engagement.",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    status: "active",
    schedule: {
      type: "interval",
      intervalMinutes: 360,
    },
    lastRunAt: null,
    nextRunAt: "2026-04-18T12:00:00.000Z",
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

describe("resolveManifestScheduledJobTarget", () => {
  it("targets an active manifest-backed job directly", () => {
    const manifestJob = makeJob({ id: manifestJobId });

    expect(
      resolveManifestScheduledJobTarget({
        scheduledJobs: [manifestJob],
        projectId,
        manifestJobId,
        manifestTitle: "Social loop",
      }),
    ).toBe(manifestJob);
  });

  it("maps a deleted manifest entry to the active UI-created job with the same title", () => {
    const deletedManifestJob = makeJob({
      id: manifestJobId,
      deletedAt: "2026-04-17T00:00:00.000Z",
      nextRunAt: null,
    });
    const uiJob = makeJob({
      id: ScheduledJobId.make("ui-created-job"),
      schedule: {
        type: "interval",
        intervalMinutes: 240,
      },
    });

    expect(
      resolveManifestScheduledJobTarget({
        scheduledJobs: [deletedManifestJob, uiJob],
        projectId,
        manifestJobId,
        manifestTitle: "Social loop",
      }),
    ).toBe(uiJob);
  });

  it("does not target deleted manifest entries without an active matching replacement", () => {
    const deletedManifestJob = makeJob({
      id: manifestJobId,
      deletedAt: "2026-04-17T00:00:00.000Z",
      nextRunAt: null,
    });

    expect(
      resolveManifestScheduledJobTarget({
        scheduledJobs: [deletedManifestJob],
        projectId,
        manifestJobId,
        manifestTitle: "Social loop",
      }),
    ).toBeNull();
  });
});

describe("manifestTargetCommandFingerprint", () => {
  it("changes when the target job changes so manifest reassertions are not idempotently ignored", () => {
    const first = manifestTargetCommandFingerprint({
      manifestFingerprint: "manifest-fingerprint",
      targetJobId: "job-1",
      targetUpdatedAt: "2026-04-18T00:00:00.000Z",
    });
    const second = manifestTargetCommandFingerprint({
      manifestFingerprint: "manifest-fingerprint",
      targetJobId: "job-1",
      targetUpdatedAt: "2026-04-18T01:00:00.000Z",
    });

    expect(first).not.toBe(second);
  });
});
