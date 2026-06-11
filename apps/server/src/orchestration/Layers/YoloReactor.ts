// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  ThreadId,
  type TurnId,
  type YoloRunId,
  YoloReviewId,
} from "@t3tools/contracts";
import { randomUUID } from "node:crypto";
import { Cause, Deferred, Duration, Effect, Fiber, Layer, Stream, TxRef } from "effect";
import type { Scope } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { YoloEvaluator } from "../Services/YoloEvaluator.ts";
import { YoloReactor, type YoloReactorShape } from "../Services/YoloReactor.ts";

type YoloTriggerEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.turn-diff-completed"
      | "thread.session-set"
      | "thread.yolo-started"
      | "thread.yolo-stopped";
  }
>;

type PendingReviewTask = {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly runId: YoloRunId;
  readonly turnId: TurnId | null;
  readonly fiber: Fiber.Fiber<void, unknown>;
};

type LatestTurnState = NonNullable<OrchestrationThread["latestTurn"]>["state"];

const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_MESSAGE_CHARS = 10_000;
const reviewTaskKey = (input: { readonly runId: YoloRunId; readonly turnId: TurnId | null }) =>
  `${input.runId}:${input.turnId ?? "no-turn"}`;

const serverCommandId = (tag: string) => CommandId.make(`server:${tag}:${randomUUID()}`);

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n...[truncated]` : value;
}

function summarizeMessage(message: OrchestrationThread["messages"][number]): string {
  const role =
    message.role === "assistant"
      ? "Assistant"
      : message.origin === "yolo-reviewer"
        ? "Goal reviewer"
        : message.role === "system"
          ? "System"
          : "User";
  const text = message.text.trim() || "(empty)";
  return `${role}:\n${truncate(text, MAX_MESSAGE_CHARS)}`;
}

function buildTranscript(messages: ReadonlyArray<OrchestrationThread["messages"][number]>): string {
  const blocks = messages.map(summarizeMessage);
  const kept: string[] = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block) continue;
    const separator = kept.length > 0 ? 2 : 0;
    if (used + block.length + separator > MAX_TRANSCRIPT_CHARS) break;
    kept.unshift(block);
    used += block.length + separator;
  }
  return kept.length === blocks.length
    ? kept.join("\n\n")
    : `[Earlier transcript omitted for length]\n\n${kept.join("\n\n")}`;
}

function latestAssistantTextForTurn(thread: OrchestrationThread, turnId: TurnId | null): string {
  const assistant = thread.messages
    .toReversed()
    .find(
      (message) => message.role === "assistant" && (turnId === null || message.turnId === turnId),
    );
  return assistant?.text.trim() ?? "";
}

export function detectYoloTerminalProviderBlocker(latestAssistantText: string): string | null {
  const normalized = latestAssistantText.trim().toLowerCase();
  if (normalized.length === 0) return null;

  if (
    normalized.includes("image in the conversation exceeds the dimension limit") &&
    normalized.includes("start a new session")
  ) {
    return latestAssistantText.trim();
  }

  if (
    normalized.includes("no conversation found with session id") ||
    normalized.includes("conversation not found")
  ) {
    return latestAssistantText.trim();
  }

  if (
    normalized.includes("no session found") ||
    normalized.includes("session not found") ||
    normalized.includes("invalid session")
  ) {
    return latestAssistantText.trim();
  }

  return null;
}

export function computeYoloReviewRemainingDelayMs(input: {
  readonly completedAt: string;
  readonly triggerDelaySeconds: number;
  readonly nowMs?: number;
}): number {
  if (input.triggerDelaySeconds <= 0) {
    return 0;
  }

  const completedAtMs = Date.parse(input.completedAt);
  if (!Number.isFinite(completedAtMs)) {
    return input.triggerDelaySeconds * 1000;
  }

  const nowMs = input.nowMs ?? Date.now();
  const scheduledAtMs = completedAtMs + input.triggerDelaySeconds * 1000;
  return Math.max(0, scheduledAtMs - nowMs);
}

function checkpointSummary(thread: OrchestrationThread, turnId: TurnId | null): string {
  const checkpoint =
    turnId === null
      ? thread.checkpoints.at(-1)
      : (thread.checkpoints.find((entry) => entry.turnId === turnId) ?? thread.checkpoints.at(-1));
  if (!checkpoint) {
    return "No checkpoint summary is available.";
  }
  const files =
    checkpoint.files.length === 0
      ? "No changed files were reported."
      : checkpoint.files
          .map((file) => `- ${file.path} (${file.kind}, +${file.additions}, -${file.deletions})`)
          .join("\n");
  return [
    `Turn: ${checkpoint.turnId}`,
    `Checkpoint status: ${checkpoint.status}`,
    `Completed at: ${checkpoint.completedAt}`,
    "Changed files:",
    files,
  ].join("\n");
}

function formatReviewerFollowUp(input: {
  readonly goal: string;
  readonly missing: ReadonlyArray<string>;
  readonly nextPrompt: string;
}): string {
  return [
    "Goal reviewer follow-up.",
    "",
    "Ultimate goal:",
    input.goal,
    "",
    "What is still missing:",
    input.missing.length > 0
      ? input.missing.map((entry) => `- ${entry}`).join("\n")
      : "- The reviewer did not list specific gaps; re-check the goal carefully.",
    "",
    "Next steps:",
    input.nextPrompt,
    "",
    "Continue working toward the ultimate goal. Be concrete, verify your changes, and report what remains if anything is still incomplete.",
  ].join("\n");
}

function isReviewableTurnState(
  state: LatestTurnState,
): state is "completed" | "error" | "interrupted" {
  return state === "completed" || state === "error" || state === "interrupted";
}

const makeYoloReactor: Effect.Effect<
  YoloReactorShape,
  never,
  Scope.Scope | OrchestrationEngineService | YoloEvaluator
> = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const evaluator = yield* YoloEvaluator;
  const currentIsoTime = Effect.sync(() => new Date().toISOString());
  const pendingReviewCount = yield* TxRef.make(0);
  const pendingReviewTasks = new Map<string, PendingReviewTask>();

  const waitForPendingReviews = TxRef.get(pendingReviewCount).pipe(
    Effect.tap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
    Effect.tx,
  );

  const releasePendingReviewTask = (key: string) =>
    Effect.sync(() => {
      const task = pendingReviewTasks.get(key);
      if (!task) {
        return false;
      }
      pendingReviewTasks.delete(key);
      return true;
    }).pipe(
      Effect.flatMap((didRelease) =>
        didRelease
          ? TxRef.update(pendingReviewCount, (count) => Math.max(0, count - 1)).pipe(Effect.tx)
          : Effect.void,
      ),
    );

  const cancelPendingReviewsForRun = (input: {
    readonly threadId: ThreadId;
    readonly runId: YoloRunId;
  }) =>
    Effect.forEach(
      Array.from(pendingReviewTasks.values()).filter(
        (task) => task.threadId === input.threadId && task.runId === input.runId,
      ),
      (task) =>
        Effect.sync(() => {
          task.fiber.interruptUnsafe();
        }),
      { discard: true },
    );

  const logTaskFailure = (eventType: YoloTriggerEvent["type"], cause: Cause.Cause<unknown>) => {
    if (Cause.hasInterruptsOnly(cause)) {
      return Effect.void;
    }
    return Effect.logWarning("yolo reactor failed to process event", {
      eventType,
      cause: Cause.pretty(cause),
    });
  };

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly tone: "info" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId(`yolo-${input.kind}`),
      threadId: input.threadId,
      activity: {
        id: EventId.make(randomUUID()),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: { detail: input.detail },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const completeWithFailure = Effect.fn("YoloReactor.completeWithFailure")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const run = input.thread.yoloRun;
    if (!run || run.status !== "active") return;
    const iteration = Math.max(1, run.iteration + 1);
    yield* orchestrationEngine.dispatch({
      type: "thread.yolo.review.complete",
      commandId: serverCommandId("yolo-review-failed"),
      threadId: input.thread.id,
      review: {
        id: YoloReviewId.make(randomUUID()),
        runId: run.id,
        threadId: input.thread.id,
        turnId: input.turnId,
        iteration,
        outcome: "failed",
        confidence: 0,
        missing: [],
        nextPrompt: null,
        reviewNote: input.detail,
        error: input.detail,
        createdAt: input.createdAt,
      },
      completedStatus: "failed",
      updatedAt: input.createdAt,
    });
    yield* appendActivity({
      threadId: input.thread.id,
      tone: "error",
      kind: "yolo.review.failed",
      summary: "Goal review failed",
      detail: input.detail,
      turnId: input.turnId,
      createdAt: input.createdAt,
    });
  });

  const reviewThread = Effect.fn("YoloReactor.reviewThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly runId: YoloRunId;
  }) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread || thread.deletedAt !== null) return;
    const run = thread.yoloRun;
    if (!run || run.status !== "active") return;
    if (run.id !== input.runId) return;
    if (input.turnId !== null && run.lastReview?.turnId === input.turnId) return;
    if (thread.session?.status === "running") return;

    const hasIterationLimit = run.maxIterations !== null;
    if (hasIterationLimit && run.iteration >= run.maxIterations) {
      const createdAt = yield* currentIsoTime;
      yield* completeWithFailure({
        thread,
        turnId: input.turnId,
        detail: `Goal stopped after reaching the ${run.maxIterations}-iteration limit.`,
        createdAt,
      });
      return;
    }

    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      }) ?? process.cwd();
    const iteration = run.iteration + 1;
    const latestAssistantText = latestAssistantTextForTurn(thread, input.turnId);
    const terminalProviderBlocker = detectYoloTerminalProviderBlocker(latestAssistantText);
    if (terminalProviderBlocker !== null) {
      const createdAt = yield* currentIsoTime;
      yield* completeWithFailure({
        thread,
        turnId: input.turnId,
        detail: `Provider returned a terminal continuation blocker: ${terminalProviderBlocker}`,
        createdAt,
      });
      return;
    }

    const result = yield* evaluator
      .evaluate({
        cwd,
        goal: run.goal,
        transcript: buildTranscript(thread.messages),
        latestAssistantText,
        checkpointSummary: checkpointSummary(thread, input.turnId),
        iteration,
        maxIterations: run.maxIterations,
        modelSelection: thread.modelSelection,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const createdAt = yield* currentIsoTime;
            yield* completeWithFailure({
              thread,
              turnId: input.turnId,
              detail: Cause.pretty(cause),
              createdAt,
            });
            return null;
          }),
        ),
      );
    if (result === null) return;

    const latestReadModel = yield* orchestrationEngine.getReadModel();
    const activeThread = latestReadModel.threads.find((entry) => entry.id === input.threadId);
    const activeRun = activeThread?.yoloRun;
    if (!activeThread || activeThread.deletedAt !== null) return;
    if (!activeRun || activeRun.status !== "active" || activeRun.id !== input.runId) return;
    if (input.turnId !== null && activeRun.lastReview?.turnId === input.turnId) return;
    if (activeThread.session?.status === "running") return;

    const reachedGoal = result.goalReached;
    const hitIterationLimit =
      !reachedGoal && activeRun.maxIterations !== null && iteration >= activeRun.maxIterations;
    const completedStatus = reachedGoal ? "completed" : hitIterationLimit ? "failed" : "active";
    const reviewNote =
      result.reviewNote.trim() ||
      (reachedGoal
        ? "Goal reviewer: the ultimate goal appears complete."
        : "Goal reviewer: more work is needed.");
    const nextPrompt = result.nextPrompt.trim();
    const missing = result.missing.map((entry) => entry.trim()).filter(Boolean);
    const failureDetail = hitIterationLimit
      ? `Goal reached the ${activeRun.maxIterations}-iteration limit before the reviewer marked the goal complete.`
      : null;
    const reviewedAt = yield* currentIsoTime;

    yield* orchestrationEngine.dispatch({
      type: "thread.yolo.review.complete",
      commandId: serverCommandId("yolo-review-complete"),
      threadId: activeThread.id,
      review: {
        id: YoloReviewId.make(randomUUID()),
        runId: activeRun.id,
        threadId: activeThread.id,
        turnId: input.turnId,
        iteration,
        outcome: reachedGoal ? "complete" : hitIterationLimit ? "failed" : "continue",
        confidence: result.confidence,
        missing,
        nextPrompt: reachedGoal || hitIterationLimit ? null : nextPrompt,
        reviewNote,
        error: failureDetail,
        createdAt: reviewedAt,
      },
      completedStatus,
      updatedAt: reviewedAt,
    });

    yield* appendActivity({
      threadId: activeThread.id,
      tone: reachedGoal ? "info" : hitIterationLimit ? "error" : "info",
      kind: reachedGoal
        ? "yolo.review.complete"
        : hitIterationLimit
          ? "yolo.iteration-limit"
          : "yolo.review.continue",
      summary: reachedGoal
        ? "Goal reached"
        : hitIterationLimit
          ? "Goal iteration limit reached"
          : "Goal reviewer requested follow-up",
      detail: failureDetail ? `${reviewNote}\n\n${failureDetail}` : reviewNote,
      turnId: input.turnId,
      createdAt: reviewedAt,
    });

    if (reachedGoal || hitIterationLimit) return;
    if (nextPrompt.length === 0) {
      const createdAt = yield* currentIsoTime;
      yield* completeWithFailure({
        thread: activeThread,
        turnId: input.turnId,
        detail: "Goal reviewer requested continuation but returned an empty next prompt.",
        createdAt,
      });
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("yolo-follow-up-dispatch"),
      threadId: activeThread.id,
      message: {
        messageId: MessageId.make(randomUUID()),
        role: "user",
        text: formatReviewerFollowUp({
          goal: activeRun.goal,
          missing,
          nextPrompt,
        }),
        attachments: [],
        origin: "yolo-reviewer",
      },
      modelSelection: activeThread.modelSelection,
      runtimeMode: activeThread.runtimeMode,
      interactionMode: activeThread.interactionMode,
      createdAt: reviewedAt,
    });
  });

  const scheduleReview = Effect.fn("YoloReactor.scheduleReview")(function* (input: {
    readonly eventType: YoloTriggerEvent["type"];
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly runId: YoloRunId;
    readonly triggerDelaySeconds: number;
    readonly completedAt: string;
  }) {
    const key = reviewTaskKey({
      runId: input.runId,
      turnId: input.turnId,
    });
    if (pendingReviewTasks.has(key)) {
      return;
    }

    const remainingDelayMs = computeYoloReviewRemainingDelayMs({
      completedAt: input.completedAt,
      triggerDelaySeconds: input.triggerDelaySeconds,
      nowMs: Date.now(),
    });
    const startSignal = yield* Deferred.make<void>();
    const fiber = yield* Deferred.await(startSignal).pipe(
      Effect.flatMap(() =>
        remainingDelayMs > 0 ? Effect.sleep(Duration.millis(remainingDelayMs)) : Effect.void,
      ),
      Effect.flatMap(() =>
        reviewThread({
          threadId: input.threadId,
          turnId: input.turnId,
          runId: input.runId,
        }),
      ),
      Effect.catchCause((cause) => logTaskFailure(input.eventType, cause)),
      Effect.ensuring(releasePendingReviewTask(key)),
      Effect.forkScoped,
    );

    pendingReviewTasks.set(key, {
      key,
      threadId: input.threadId,
      runId: input.runId,
      turnId: input.turnId,
      fiber,
    });
    yield* TxRef.update(pendingReviewCount, (count) => count + 1).pipe(Effect.tx);
    yield* Deferred.succeed(startSignal, undefined);
  });

  const processEvent = (
    event: YoloTriggerEvent,
  ): Effect.Effect<void, OrchestrationDispatchError, Scope.Scope> => {
    if (event.type === "thread.yolo-started") {
      return Effect.gen(function* () {
        const readModel = yield* orchestrationEngine.getReadModel();
        const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
        const latestTurn = thread?.latestTurn;
        if (!latestTurn || !isReviewableTurnState(latestTurn.state)) {
          return;
        }
        if (!latestTurn.completedAt || latestTurn.completedAt <= event.payload.run.startedAt) {
          return;
        }
        yield* scheduleReview({
          eventType: event.type,
          threadId: event.payload.threadId,
          turnId: latestTurn.turnId,
          runId: event.payload.run.id,
          triggerDelaySeconds: event.payload.run.triggerDelaySeconds,
          completedAt: latestTurn.completedAt,
        });
      });
    }
    if (event.type === "thread.yolo-stopped") {
      return cancelPendingReviewsForRun({
        threadId: event.payload.threadId,
        runId: event.payload.runId,
      });
    }
    if (event.type === "thread.session-set") {
      if (
        event.payload.session.status !== "error" &&
        event.payload.session.status !== "interrupted" &&
        event.payload.session.status !== "stopped"
      ) {
        return Effect.void;
      }
      return Effect.gen(function* () {
        const readModel = yield* orchestrationEngine.getReadModel();
        const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
        if (!thread?.yoloRun || thread.yoloRun.status !== "active") return;
        yield* cancelPendingReviewsForRun({
          threadId: thread.id,
          runId: thread.yoloRun.id,
        });
        yield* completeWithFailure({
          thread,
          turnId: thread.latestTurn?.turnId ?? null,
          detail:
            event.payload.session.lastError ??
            `Provider session ended with status '${event.payload.session.status}'.`,
          createdAt: event.payload.session.updatedAt,
        });
      });
    }
    return Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
      const run = thread?.yoloRun?.status === "active" ? thread.yoloRun : null;
      if (!run) return;
      yield* scheduleReview({
        eventType: event.type,
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        runId: run.id,
        triggerDelaySeconds: run.triggerDelaySeconds,
        completedAt: event.payload.completedAt,
      });
    });
  };

  const worker = yield* makeDrainableWorker((event: YoloTriggerEvent) =>
    processEvent(event).pipe(Effect.catchCause((cause) => logTaskFailure(event.type, cause))),
  );

  const start: YoloReactorShape["start"] = Effect.fn("YoloReactor.start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(
        orchestrationEngine.streamDomainEvents.pipe(
          Stream.filter(
            (event): event is YoloTriggerEvent =>
              event.type === "thread.turn-diff-completed" ||
              event.type === "thread.session-set" ||
              event.type === "thread.yolo-started" ||
              event.type === "thread.yolo-stopped",
          ),
        ),
        worker.enqueue,
      ),
    );

    const readModel = yield* orchestrationEngine.getReadModel();
    const now = new Date().toISOString();
    for (const thread of readModel.threads) {
      if (thread.yoloRun?.status !== "active") continue;
      yield* worker.enqueue({
        type: "thread.yolo-started",
        sequence: readModel.snapshotSequence,
        eventId: EventId.make(`startup-yolo-${thread.id}-${randomUUID()}`),
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: thread.id,
          run: thread.yoloRun,
        },
      });
    }
  });

  return {
    start,
    drain: Effect.all([worker.drain, waitForPendingReviews], { discard: true }),
  } satisfies YoloReactorShape;
});

export const YoloReactorLive = Layer.effect(YoloReactor, makeYoloReactor);
