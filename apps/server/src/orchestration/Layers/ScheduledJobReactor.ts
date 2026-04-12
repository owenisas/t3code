import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  ScheduledJobRunId,
  ThreadId,
} from "@t3tools/contracts";
import { Duration, Effect, Layer, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ScheduledJobReactor,
  type ScheduledJobReactorShape,
} from "../Services/ScheduledJobReactor.ts";

type CompletionEvent = Extract<
  OrchestrationEvent,
  {
    type: "thread.turn-diff-completed" | "thread.session-set";
  }
>;

type ScheduledJobTask =
  | { readonly type: "reconcile" }
  | { readonly type: "scan" }
  | { readonly type: "completion-event"; readonly event: CompletionEvent };

const POLL_INTERVAL = Duration.seconds(30);

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

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

  const worker = yield* makeDrainableWorker((task: ScheduledJobTask) => {
    switch (task.type) {
      case "reconcile":
        return reconcileActiveRuns();
      case "scan":
        return triggerDueJobs();
      case "completion-event":
        return handleCompletionEvent(task.event);
    }
  });

  const start: ScheduledJobReactorShape["start"] = Effect.fn("start")(function* () {
    yield* worker.enqueue({ type: "reconcile" });
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

    yield* Effect.forever(
      Effect.sleep(POLL_INTERVAL).pipe(
        Effect.flatMap(() => worker.enqueue({ type: "reconcile" })),
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
