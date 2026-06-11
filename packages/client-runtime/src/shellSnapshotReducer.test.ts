import { describe, expect, it } from "vite-plus/test";

import { ProjectId, ProviderInstanceId, ScheduledJobId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

import { applyShellStreamEvent } from "./shellSnapshotReducer.ts";

const baseSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 0,
  projects: [],
  scheduledJobs: [],
  threads: [],
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const stubProject = {
  id: ProjectId.make("project-1"),
  title: "Test Project",
  workspaceRoot: "/workspace/test",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
} as const;

const stubThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
} as const;

const stubScheduledJob = {
  id: ScheduledJobId.make("job-1"),
  projectId: ProjectId.make("project-1"),
  title: "Repo health",
  prompt: "Run repo health checks.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  status: "active" as const,
  schedule: { type: "interval" as const, intervalMinutes: 60 },
  lastRunAt: null,
  nextRunAt: "2026-04-01T01:00:00.000Z",
  lastOutcome: null,
  lastThreadId: null,
  lastError: null,
  activeRun: null,
  runs: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  deletedAt: null,
} as const;

describe("applyShellStreamEvent", () => {
  describe("project-upserted", () => {
    it("adds a new project", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 1,
        project: stubProject,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.id).toBe("project-1");
      expect(next.snapshotSequence).toBe(1);
    });

    it("updates an existing project", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const updatedProject = { ...stubProject, title: "Updated Title" };
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 2,
        project: updatedProject,
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.title).toBe("Updated Title");
      expect(next.snapshotSequence).toBe(2);
    });
  });

  describe("project-removed", () => {
    it("removes a project by id", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "project-removed",
        sequence: 3,
        projectId: ProjectId.make("project-1"),
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(0);
      expect(next.snapshotSequence).toBe(3);
    });
  });

  describe("thread-upserted", () => {
    it("adds a new thread", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 4,
        thread: stubThread,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.id).toBe("thread-1");
      expect(next.snapshotSequence).toBe(4);
    });

    it("updates an existing thread", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const updatedThread = { ...stubThread, title: "Updated Thread" };
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 5,
        thread: updatedThread,
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.title).toBe("Updated Thread");
    });
  });

  describe("scheduled-job-upserted", () => {
    it("adds a new scheduled job", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "scheduled-job-upserted",
        sequence: 6,
        job: stubScheduledJob,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.scheduledJobs).toHaveLength(1);
      expect(next.scheduledJobs[0]?.id).toBe("job-1");
      expect(next.snapshotSequence).toBe(6);
    });

    it("updates an existing scheduled job", () => {
      const snapshotWithJob: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        scheduledJobs: [stubScheduledJob],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "scheduled-job-upserted",
        sequence: 7,
        job: { ...stubScheduledJob, title: "Updated job" },
      };

      const next = applyShellStreamEvent(snapshotWithJob, event);

      expect(next.scheduledJobs).toHaveLength(1);
      expect(next.scheduledJobs[0]?.title).toBe("Updated job");
      expect(next.snapshotSequence).toBe(7);
    });
  });

  describe("scheduled-job-removed", () => {
    it("removes a scheduled job by id", () => {
      const snapshotWithJob: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        scheduledJobs: [stubScheduledJob],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "scheduled-job-removed",
        sequence: 8,
        jobId: ScheduledJobId.make("job-1"),
      };

      const next = applyShellStreamEvent(snapshotWithJob, event);

      expect(next.scheduledJobs).toHaveLength(0);
      expect(next.snapshotSequence).toBe(8);
    });
  });

  describe("thread-removed", () => {
    it("removes a thread by id", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "thread-removed",
        sequence: 6,
        threadId: ThreadId.make("thread-1"),
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(0);
      expect(next.snapshotSequence).toBe(6);
    });
  });

  it("returns original snapshot for unrecognized event kinds", () => {
    const unknownEvent = { kind: "unknown-future-event", sequence: 99 } as any;
    const next = applyShellStreamEvent(baseSnapshot, unknownEvent);
    expect(next).toBe(baseSnapshot);
  });
});
