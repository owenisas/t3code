// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  type ScheduledJob,
  ScheduledJobId,
  ScheduledJobRunId,
  ThreadId,
} from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { createHash } from "node:crypto";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ScheduledJobReactor,
  type ScheduledJobReactorShape,
} from "../Services/ScheduledJobReactor.ts";
import {
  applyScheduledJobManifestPatch,
  parseScheduledJobManifest,
  parseScheduledJobManifestId,
  scheduledJobIdForManifest,
  type ScheduledJobManifestEntry,
  type ScheduledJobManifestPatch,
  T3_JOB_MANIFEST_RELATIVE_PATH,
} from "../jobManifests.ts";

type CompletionEvent = Extract<
  OrchestrationEvent,
  {
    type: "thread.turn-diff-completed" | "thread.session-set";
  }
>;

type ManifestWritableJobEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "scheduled-job.updated"
      | "scheduled-job.paused"
      | "scheduled-job.resumed"
      | "scheduled-job.deleted";
  }
>;

type ScheduledJobTask =
  | { readonly type: "reconcile" }
  | { readonly type: "scan" }
  | { readonly type: "manifest-scan" }
  | { readonly type: "completion-event"; readonly event: CompletionEvent }
  | { readonly type: "manifest-write-back"; readonly event: ManifestWritableJobEvent };

const POLL_INTERVAL = Duration.seconds(30);
const MANIFEST_COMMAND_PREFIX = "server:job-manifest:";

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const manifestCommandId = (tag: string, projectId: string, localId: string, fingerprint: string) =>
  CommandId.make(`server:job-manifest:${tag}:${projectId}:${localId}:${fingerprint}`);

const fingerprintJson = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

export const manifestTargetCommandFingerprint = (input: {
  readonly manifestFingerprint: string;
  readonly targetJobId: string;
  readonly targetUpdatedAt: string;
}) => fingerprintJson(input);

const isManifestCommandId = (commandId: CommandId | null): boolean =>
  commandId !== null && String(commandId).startsWith(MANIFEST_COMMAND_PREFIX);

const normalizeManifestMatchTitle = (title: string): string => title.trim().toLocaleLowerCase();

export function resolveManifestScheduledJobTarget(input: {
  readonly scheduledJobs: ReadonlyArray<ScheduledJob>;
  readonly projectId: ProjectId;
  readonly manifestJobId: ScheduledJobId;
  readonly manifestTitle: string;
}): ScheduledJob | null {
  const manifestJob = input.scheduledJobs.find((job) => job.id === input.manifestJobId) ?? null;
  if (manifestJob && manifestJob.deletedAt === null) {
    return manifestJob;
  }

  const titleCandidates = new Set<string>([
    normalizeManifestMatchTitle(input.manifestTitle),
    ...(manifestJob ? [normalizeManifestMatchTitle(manifestJob.title)] : []),
  ]);

  return (
    input.scheduledJobs.find(
      (job) =>
        job.projectId === input.projectId &&
        job.deletedAt === null &&
        parseScheduledJobManifestId(job.id) === null &&
        titleCandidates.has(normalizeManifestMatchTitle(job.title)),
    ) ?? null
  );
}

export function resolveManifestWritableJobLocalId(input: {
  readonly scheduledJobs: ReadonlyArray<ScheduledJob>;
  readonly projectId: ProjectId;
  readonly jobId: ScheduledJobId;
  readonly manifestJobs: ReadonlyArray<ScheduledJobManifestEntry>;
}): string | null {
  const directManifestId = parseScheduledJobManifestId(input.jobId);
  if (directManifestId && directManifestId.projectId === input.projectId) {
    return directManifestId.localId;
  }

  const targetJob = input.scheduledJobs.find((job) => job.id === input.jobId) ?? null;
  if (
    !targetJob ||
    targetJob.projectId !== input.projectId ||
    parseScheduledJobManifestId(targetJob.id) !== null
  ) {
    return null;
  }

  for (const manifestJob of input.manifestJobs) {
    const manifestJobId = scheduledJobIdForManifest(input.projectId, manifestJob.localId);
    const deletedManifestJob =
      input.scheduledJobs.find((job) => job.id === manifestJobId && job.deletedAt !== null) ?? null;
    if (!deletedManifestJob) {
      continue;
    }

    const titleCandidates = new Set([
      normalizeManifestMatchTitle(manifestJob.title),
      normalizeManifestMatchTitle(deletedManifestJob.title),
    ]);
    if (titleCandidates.has(normalizeManifestMatchTitle(targetJob.title))) {
      return manifestJob.localId;
    }
  }

  return null;
}

function manifestPatchForEvent(event: ManifestWritableJobEvent): ScheduledJobManifestPatch {
  switch (event.type) {
    case "scheduled-job.deleted":
      return { type: "delete" };
    case "scheduled-job.paused":
      return { type: "status", status: "paused" };
    case "scheduled-job.resumed":
      return { type: "status", status: "active" };
    case "scheduled-job.updated": {
      const payload = event.payload;
      return {
        type: "update",
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.prompt !== undefined ? { prompt: payload.prompt } : {}),
        ...(payload.modelSelection !== undefined ? { modelSelection: payload.modelSelection } : {}),
        ...(payload.runtimeMode !== undefined ? { runtimeMode: payload.runtimeMode } : {}),
        ...(payload.interactionMode !== undefined
          ? { interactionMode: payload.interactionMode }
          : {}),
        ...(payload.schedule !== undefined ? { schedule: payload.schedule } : {}),
      };
    }
  }
}

function completionInputForThreadEvent(event: CompletionEvent): {
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly error?: string;
  readonly completedAt: string;
} | null {
  switch (event.type) {
    case "thread.turn-diff-completed":
      return {
        outcome:
          event.payload.status === "ready"
            ? "succeeded"
            : event.payload.status === "missing"
              ? "interrupted"
              : "failed",
        ...(event.payload.status === "ready"
          ? {}
          : {
              error: `Scheduled job run finished with checkpoint status '${event.payload.status}'.`,
            }),
        completedAt: event.payload.completedAt,
      };
    case "thread.session-set":
      switch (event.payload.session.status) {
        case "error":
          return {
            outcome: "failed",
            error: event.payload.session.lastError ?? "Scheduled job session ended with an error.",
            completedAt: event.payload.session.updatedAt,
          };
        case "interrupted":
          return {
            outcome: "interrupted",
            error: event.payload.session.lastError ?? "Scheduled job session was interrupted.",
            completedAt: event.payload.session.updatedAt,
          };
        case "stopped":
          return {
            outcome: "failed",
            error: event.payload.session.lastError ?? "Scheduled job session stopped unexpectedly.",
            completedAt: event.payload.session.updatedAt,
          };
        default:
          return null;
      }
  }
}

const makeScheduledJobReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const triggerDueJobs = Effect.fn("triggerDueJobs")(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    const nowIso = new Date().toISOString();
    const dueJobs = readModel.scheduledJobs.filter(
      (job) =>
        job.deletedAt === null &&
        job.status === "active" &&
        job.activeRun === null &&
        job.nextRunAt !== null &&
        job.nextRunAt <= nowIso,
    );

    for (const job of dueJobs) {
      yield* orchestrationEngine
        .dispatch({
          type: "scheduled-job.run.trigger",
          commandId: serverCommandId("scheduled-job-run-trigger"),
          jobId: job.id,
          runId: ScheduledJobRunId.make(crypto.randomUUID()),
          threadId: ThreadId.make(crypto.randomUUID()),
          messageId: MessageId.make(crypto.randomUUID()),
          trigger: "schedule",
          createdAt: nowIso,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to trigger due scheduled job", {
              jobId: job.id,
              cause,
            }),
          ),
        );
    }
  });

  const reconcileActiveRuns = Effect.fn("reconcileActiveRuns")(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    for (const job of readModel.scheduledJobs) {
      if (job.deletedAt !== null || job.activeRun === null) {
        continue;
      }
      const thread = readModel.threads.find((entry) => entry.id === job.activeRun?.threadId);
      if (!thread) {
        yield* orchestrationEngine
          .dispatch({
            type: "scheduled-job.run.complete",
            commandId: serverCommandId("scheduled-job-run-complete"),
            jobId: job.id,
            runId: job.activeRun.id,
            outcome: "failed",
            error: "Scheduled job run thread is missing from the read model.",
            completedAt: new Date().toISOString(),
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to reconcile missing scheduled job thread", {
                jobId: job.id,
                runId: job.activeRun?.id,
                cause,
              }),
            ),
          );
        continue;
      }

      const latestTurnState = thread.latestTurn?.state ?? null;
      if (
        latestTurnState === "completed" ||
        latestTurnState === "error" ||
        latestTurnState === "interrupted"
      ) {
        yield* orchestrationEngine
          .dispatch({
            type: "scheduled-job.run.complete",
            commandId: serverCommandId("scheduled-job-run-complete"),
            jobId: job.id,
            runId: job.activeRun.id,
            outcome:
              latestTurnState === "completed"
                ? "succeeded"
                : latestTurnState === "interrupted"
                  ? "interrupted"
                  : "failed",
            ...(latestTurnState === "completed"
              ? {}
              : {
                  error:
                    thread.session?.lastError ??
                    `Scheduled job thread ended as '${latestTurnState}'.`,
                }),
            completedAt:
              thread.latestTurn?.completedAt ??
              thread.session?.updatedAt ??
              new Date().toISOString(),
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to reconcile completed scheduled job run", {
                jobId: job.id,
                runId: job.activeRun?.id,
                cause,
              }),
            ),
          );
      }
    }
  });

  const scanJobManifests = Effect.fn("scanJobManifests")(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    const nowIso = new Date().toISOString();
    for (const project of readModel.projects) {
      if (project.deletedAt !== null) {
        continue;
      }

      const manifestPath = path.join(project.workspaceRoot, T3_JOB_MANIFEST_RELATIVE_PATH);
      if (!(yield* fs.exists(manifestPath))) {
        continue;
      }

      const rawManifest = yield* fs.readFileString(manifestPath).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to read T3 scheduled job manifest", {
            projectId: project.id,
            manifestPath,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (rawManifest === null) {
        continue;
      }

      const parsed = parseScheduledJobManifest(rawManifest, project.defaultModelSelection);
      for (const error of parsed.errors) {
        yield* Effect.logWarning("invalid T3 scheduled job manifest entry", {
          projectId: project.id,
          manifestPath,
          error,
        });
      }

      for (const manifestJob of parsed.jobs) {
        const jobId = scheduledJobIdForManifest(project.id, manifestJob.localId);
        const existingJob = resolveManifestScheduledJobTarget({
          scheduledJobs: readModel.scheduledJobs,
          projectId: project.id,
          manifestJobId: jobId,
          manifestTitle: manifestJob.title,
        });
        const deletedManifestJob =
          readModel.scheduledJobs.find((job) => job.id === jobId && job.deletedAt !== null) ?? null;
        if (!existingJob && deletedManifestJob) {
          continue;
        }
        const schedule = {
          type: "interval" as const,
          intervalMinutes: manifestJob.intervalMinutes,
        };
        const fingerprint = fingerprintJson({
          title: manifestJob.title,
          prompt: manifestJob.prompt,
          modelSelection: manifestJob.modelSelection,
          runtimeMode: manifestJob.runtimeMode,
          interactionMode: manifestJob.interactionMode,
          status: manifestJob.status,
          schedule,
        });

        if (!existingJob) {
          yield* orchestrationEngine
            .dispatch({
              type: "scheduled-job.create",
              commandId: manifestCommandId("create", project.id, manifestJob.localId, fingerprint),
              jobId,
              projectId: project.id,
              title: manifestJob.title,
              prompt: manifestJob.prompt,
              modelSelection: manifestJob.modelSelection,
              runtimeMode: manifestJob.runtimeMode,
              interactionMode: manifestJob.interactionMode,
              schedule,
              createdAt: nowIso,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to import T3 scheduled job manifest entry", {
                  projectId: project.id,
                  localId: manifestJob.localId,
                  cause,
                }),
              ),
            );
          if (manifestJob.status === "paused") {
            yield* orchestrationEngine
              .dispatch({
                type: "scheduled-job.pause",
                commandId: manifestCommandId("pause", project.id, manifestJob.localId, fingerprint),
                jobId,
                createdAt: nowIso,
              })
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("failed to pause imported T3 scheduled job manifest entry", {
                    projectId: project.id,
                    localId: manifestJob.localId,
                    cause,
                  }),
                ),
              );
          }
          continue;
        }

        const needsUpdate =
          existingJob.title !== manifestJob.title ||
          existingJob.prompt !== manifestJob.prompt ||
          existingJob.modelSelection.instanceId !== manifestJob.modelSelection.instanceId ||
          existingJob.modelSelection.model !== manifestJob.modelSelection.model ||
          existingJob.runtimeMode !== manifestJob.runtimeMode ||
          existingJob.interactionMode !== manifestJob.interactionMode ||
          existingJob.schedule.intervalMinutes !== manifestJob.intervalMinutes;

        if (needsUpdate) {
          const updateFingerprint = manifestTargetCommandFingerprint({
            manifestFingerprint: fingerprint,
            targetJobId: existingJob.id,
            targetUpdatedAt: existingJob.updatedAt,
          });
          yield* orchestrationEngine
            .dispatch({
              type: "scheduled-job.update",
              commandId: manifestCommandId(
                "update",
                project.id,
                manifestJob.localId,
                updateFingerprint,
              ),
              jobId: existingJob.id,
              title: manifestJob.title,
              prompt: manifestJob.prompt,
              modelSelection: manifestJob.modelSelection,
              runtimeMode: manifestJob.runtimeMode,
              interactionMode: manifestJob.interactionMode,
              schedule,
              createdAt: nowIso,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to update T3 scheduled job manifest entry", {
                  projectId: project.id,
                  localId: manifestJob.localId,
                  cause,
                }),
              ),
            );
        }

        if (existingJob.status !== manifestJob.status) {
          const statusFingerprint = manifestTargetCommandFingerprint({
            manifestFingerprint: fingerprint,
            targetJobId: existingJob.id,
            targetUpdatedAt: existingJob.updatedAt,
          });
          yield* orchestrationEngine
            .dispatch({
              type:
                manifestJob.status === "paused" ? "scheduled-job.pause" : "scheduled-job.resume",
              commandId: manifestCommandId(
                manifestJob.status === "paused" ? "pause" : "resume",
                project.id,
                manifestJob.localId,
                statusFingerprint,
              ),
              jobId: existingJob.id,
              createdAt: nowIso,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to sync T3 scheduled job manifest status", {
                  projectId: project.id,
                  localId: manifestJob.localId,
                  cause,
                }),
              ),
            );
        }
      }
    }
  });

  const handleCompletionEvent = Effect.fn("handleCompletionEvent")(function* (
    event: CompletionEvent,
  ) {
    const completion = completionInputForThreadEvent(event);
    if (!completion) {
      return;
    }
    const readModel = yield* orchestrationEngine.getReadModel();
    const job = readModel.scheduledJobs.find(
      (entry) => entry.activeRun?.threadId === event.payload.threadId,
    );
    if (!job?.activeRun) {
      return;
    }
    yield* orchestrationEngine
      .dispatch({
        type: "scheduled-job.run.complete",
        commandId: serverCommandId("scheduled-job-run-complete"),
        jobId: job.id,
        runId: job.activeRun.id,
        outcome: completion.outcome,
        ...(completion.error ? { error: completion.error } : {}),
        completedAt: completion.completedAt,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to complete scheduled job run from thread event", {
            jobId: job.id,
            runId: job.activeRun?.id,
            eventType: event.type,
            cause,
          }),
        ),
      );
  });

  const handleManifestWriteBack = Effect.fn("handleManifestWriteBack")(function* (
    event: ManifestWritableJobEvent,
  ) {
    if (isManifestCommandId(event.commandId)) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const eventJob = readModel.scheduledJobs.find((job) => job.id === event.payload.jobId) ?? null;
    const directManifestId = parseScheduledJobManifestId(event.payload.jobId);
    const projectId = directManifestId?.projectId ?? eventJob?.projectId ?? null;
    if (!projectId) {
      return;
    }

    const project = readModel.projects.find(
      (entry) => entry.id === projectId && entry.deletedAt === null,
    );
    if (!project) {
      return;
    }

    const manifestPath = path.join(project.workspaceRoot, T3_JOB_MANIFEST_RELATIVE_PATH);
    if (!(yield* fs.exists(manifestPath))) {
      return;
    }

    const rawManifest = yield* fs.readFileString(manifestPath).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to read T3 scheduled job manifest for write-back", {
          projectId: project.id,
          jobId: event.payload.jobId,
          manifestPath,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (rawManifest === null) {
      return;
    }

    const parsed = parseScheduledJobManifest(rawManifest, project.defaultModelSelection);
    const localId = resolveManifestWritableJobLocalId({
      scheduledJobs: readModel.scheduledJobs,
      projectId: project.id,
      jobId: event.payload.jobId,
      manifestJobs: parsed.jobs,
    });
    if (!localId) {
      return;
    }

    const patch = manifestPatchForEvent(event);

    const result = applyScheduledJobManifestPatch(rawManifest, localId, patch);
    for (const error of result.errors) {
      yield* Effect.logWarning("failed to update T3 scheduled job manifest", {
        projectId: project.id,
        localId,
        manifestPath,
        error,
      });
    }
    if (!result.changed || result.errors.length > 0) {
      return;
    }

    yield* fs.writeFileString(manifestPath, result.rawJson).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to write T3 scheduled job manifest", {
          projectId: project.id,
          localId,
          manifestPath,
          cause,
        }),
      ),
    );
  });

  const worker = yield* makeDrainableWorker((task: ScheduledJobTask) =>
    (() => {
      switch (task.type) {
        case "reconcile":
          return reconcileActiveRuns();
        case "scan":
          return triggerDueJobs();
        case "manifest-scan":
          return scanJobManifests();
        case "completion-event":
          return handleCompletionEvent(task.event).pipe(Effect.andThen(scanJobManifests()));
        case "manifest-write-back":
          return handleManifestWriteBack(task.event);
      }
    })().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("scheduled job reactor task failed", {
          taskType: task.type,
          cause,
        }),
      ),
    ),
  );

  const start: ScheduledJobReactorShape["start"] = Effect.fn("start")(function* () {
    yield* worker.enqueue({ type: "reconcile" });
    yield* worker.enqueue({ type: "manifest-scan" });
    yield* worker.enqueue({ type: "scan" });

    yield* Stream.runForEach(
      orchestrationEngine.streamDomainEvents.pipe(
        Stream.filter(
          (event): event is CompletionEvent =>
            event.type === "thread.turn-diff-completed" || event.type === "thread.session-set",
        ),
      ),
      (event) => worker.enqueue({ type: "completion-event", event }),
    ).pipe(Effect.forkScoped);

    yield* Stream.runForEach(
      orchestrationEngine.streamDomainEvents.pipe(
        Stream.filter(
          (event): event is ManifestWritableJobEvent =>
            event.type === "scheduled-job.updated" ||
            event.type === "scheduled-job.paused" ||
            event.type === "scheduled-job.resumed" ||
            event.type === "scheduled-job.deleted",
        ),
      ),
      (event) => worker.enqueue({ type: "manifest-write-back", event }),
    ).pipe(Effect.forkScoped);

    yield* Effect.forever(
      Effect.sleep(POLL_INTERVAL).pipe(
        Effect.flatMap(() => worker.enqueue({ type: "reconcile" })),
        Effect.flatMap(() => worker.enqueue({ type: "manifest-scan" })),
        Effect.flatMap(() => worker.enqueue({ type: "scan" })),
      ),
    ).pipe(Effect.forkScoped);
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ScheduledJobReactorShape;
});

export const ScheduledJobReactorLive = Layer.effect(ScheduledJobReactor, makeScheduledJobReactor);
