import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  ThreadId,
  type TurnId,
  YoloReviewId,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { YoloEvaluator } from "../Services/YoloEvaluator.ts";
import { YoloReactor, type YoloReactorShape } from "../Services/YoloReactor.ts";

type YoloTriggerEvent = Extract<
  OrchestrationEvent,
  {
    type: "thread.turn-diff-completed" | "thread.session-set" | "thread.yolo-started";
  }
>;

const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_MESSAGE_CHARS = 10_000;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n...[truncated]` : value;
}

function summarizeMessage(message: OrchestrationThread["messages"][number]): string {
  const role =
    message.role === "assistant"
      ? "Assistant"
      : message.origin === "yolo-reviewer"
        ? "YOLO reviewer"
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
    "YOLO reviewer follow-up.",
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

const makeYoloReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const evaluator = yield* YoloEvaluator;
  const serverSettingsService = yield* ServerSettingsService;

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
        id: EventId.make(crypto.randomUUID()),
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
        id: YoloReviewId.make(crypto.randomUUID()),
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
      summary: "YOLO review failed",
      detail: input.detail,
      turnId: input.turnId,
      createdAt: input.createdAt,
    });
  });

  const reviewThread = Effect.fn("YoloReactor.reviewThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
  }) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread || thread.deletedAt !== null) return;
    const run = thread.yoloRun;
    if (!run || run.status !== "active") return;
    if (input.turnId !== null && run.lastReview?.turnId === input.turnId) return;
    if (thread.session?.status === "running") return;

    if (run.iteration >= run.maxIterations) {
      yield* completeWithFailure({
        thread,
        turnId: input.turnId,
        detail: `YOLO stopped after reaching the ${run.maxIterations}-iteration limit.`,
        createdAt: input.createdAt,
      });
      return;
    }

    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      }) ?? process.cwd();
    const settings = yield* serverSettingsService.getSettings;
    const iteration = run.iteration + 1;

    const result = yield* evaluator
      .evaluate({
        cwd,
        goal: run.goal,
        transcript: buildTranscript(thread.messages),
        latestAssistantText: latestAssistantTextForTurn(thread, input.turnId),
        checkpointSummary: checkpointSummary(thread, input.turnId),
        iteration,
        maxIterations: run.maxIterations,
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(
        Effect.catchCause((cause) =>
          completeWithFailure({
            thread,
            turnId: input.turnId,
            detail: Cause.pretty(cause),
            createdAt: input.createdAt,
          }).pipe(Effect.as(null)),
        ),
      );
    if (result === null) return;

    const reachedGoal = result.goalReached;
    const hitIterationLimit = !reachedGoal && iteration >= run.maxIterations;
    const completedStatus = reachedGoal ? "completed" : hitIterationLimit ? "failed" : "active";
    const reviewNote =
      result.reviewNote.trim() ||
      (reachedGoal
        ? "YOLO reviewer: the ultimate goal appears complete."
        : "YOLO reviewer: more work is needed.");
    const nextPrompt = result.nextPrompt.trim();
    const missing = result.missing.map((entry) => entry.trim()).filter(Boolean);
    const failureDetail = hitIterationLimit
      ? `YOLO reached the ${run.maxIterations}-iteration limit before the reviewer marked the goal complete.`
      : null;

    yield* orchestrationEngine.dispatch({
      type: "thread.yolo.review.complete",
      commandId: serverCommandId("yolo-review-complete"),
      threadId: thread.id,
      review: {
        id: YoloReviewId.make(crypto.randomUUID()),
        runId: run.id,
        threadId: thread.id,
        turnId: input.turnId,
        iteration,
        outcome: reachedGoal ? "complete" : hitIterationLimit ? "failed" : "continue",
        confidence: result.confidence,
        missing,
        nextPrompt: reachedGoal || hitIterationLimit ? null : nextPrompt,
        reviewNote,
        error: failureDetail,
        createdAt: input.createdAt,
      },
      completedStatus,
      updatedAt: input.createdAt,
    });

    yield* appendActivity({
      threadId: thread.id,
      tone: reachedGoal ? "info" : hitIterationLimit ? "error" : "info",
      kind: reachedGoal
        ? "yolo.review.complete"
        : hitIterationLimit
          ? "yolo.iteration-limit"
          : "yolo.review.continue",
      summary: reachedGoal
        ? "YOLO goal reached"
        : hitIterationLimit
          ? "YOLO iteration limit reached"
          : "YOLO reviewer requested follow-up",
      detail: failureDetail ? `${reviewNote}\n\n${failureDetail}` : reviewNote,
      turnId: input.turnId,
      createdAt: input.createdAt,
    });

    if (reachedGoal || hitIterationLimit) return;
    if (nextPrompt.length === 0) {
      yield* completeWithFailure({
        thread,
        turnId: input.turnId,
        detail: "YOLO reviewer requested continuation but returned an empty next prompt.",
        createdAt: input.createdAt,
      });
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("yolo-follow-up-dispatch"),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(crypto.randomUUID()),
        role: "user",
        text: formatReviewerFollowUp({
          goal: run.goal,
          missing,
          nextPrompt,
        }),
        attachments: [],
        origin: "yolo-reviewer",
      },
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: input.createdAt,
    });
  });

  const processEvent = (event: YoloTriggerEvent) => {
    if (event.type === "thread.yolo-started") {
      return Effect.gen(function* () {
        const readModel = yield* orchestrationEngine.getReadModel();
        const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
        const latestTurn = thread?.latestTurn;
        if (
          !latestTurn ||
          (latestTurn.state !== "completed" &&
            latestTurn.state !== "error" &&
            latestTurn.state !== "interrupted")
        ) {
          return;
        }
        yield* reviewThread({
          threadId: event.payload.threadId,
          turnId: latestTurn.turnId,
          createdAt: latestTurn.completedAt ?? event.occurredAt,
        });
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
    return reviewThread({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      createdAt: event.payload.completedAt,
    });
  };

  const worker = yield* makeDrainableWorker((event: YoloTriggerEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("yolo reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  const start: YoloReactorShape["start"] = Effect.fn("YoloReactor.start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(
        orchestrationEngine.streamDomainEvents.pipe(
          Stream.filter(
            (event): event is YoloTriggerEvent =>
              event.type === "thread.turn-diff-completed" ||
              event.type === "thread.session-set" ||
              event.type === "thread.yolo-started",
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
        eventId: EventId.make(`startup-yolo-${thread.id}-${crypto.randomUUID()}`),
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
    drain: worker.drain,
  } satisfies YoloReactorShape;
});

export const YoloReactorLive = Layer.effect(YoloReactor, makeYoloReactor);
