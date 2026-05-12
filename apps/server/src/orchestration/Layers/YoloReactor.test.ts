// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  YoloRunId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Ref, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { YoloEvaluator, type YoloEvaluatorInput } from "../Services/YoloEvaluator.ts";
import { YoloReactor } from "../Services/YoloReactor.ts";
import {
  computeYoloReviewRemainingDelayMs,
  detectYoloTerminalProviderBlocker,
  YoloReactorLive,
} from "./YoloReactor.ts";

const projectId = ProjectId.make("project-yolo");

type ReactorHarness = {
  readonly runtime: ManagedRuntime.ManagedRuntime<YoloReactor, unknown>;
  readonly scope: Scope.Closeable;
  readonly publish: (event: OrchestrationEvent) => Promise<void>;
  readonly getCommands: () => Promise<ReadonlyArray<OrchestrationCommand>>;
  readonly getEvaluatorInputs: () => Promise<ReadonlyArray<YoloEvaluatorInput>>;
};

function makeProject(now: string) {
  return {
    id: projectId,
    title: "Project",
    workspaceRoot: "/tmp/t3-yolo",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  } satisfies OrchestrationReadModel["projects"][number];
}

function makeThread(input: {
  readonly threadId: ThreadId;
  readonly runId: YoloRunId;
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly triggerDelaySeconds: number;
  readonly modelSelection?: OrchestrationThread["modelSelection"];
}): OrchestrationThread {
  const assistantMessageId = MessageId.make(`assistant-${input.threadId}`);

  return {
    id: input.threadId,
    projectId,
    title: `Thread ${input.threadId}`,
    modelSelection: input.modelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: input.turnId,
      state: "completed",
      requestedAt: input.startedAt,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      assistantMessageId,
    },
    queuedFollowUps: [],
    yoloRun: {
      id: input.runId,
      threadId: input.threadId,
      goal: "Ship the feature",
      status: "active",
      maxIterations: 10,
      triggerDelaySeconds: input.triggerDelaySeconds,
      iteration: 0,
      lastReview: null,
      reviews: [],
      lastError: null,
      startedAt: input.startedAt,
      completedAt: null,
      updatedAt: input.startedAt,
    },
    forkOrigin: null,
    createdAt: input.startedAt,
    updatedAt: input.startedAt,
    archivedAt: null,
    deletedAt: null,
    messages: [
      {
        id: assistantMessageId,
        role: "assistant",
        text: "The current work is done.",
        attachments: [],
        origin: "human",
        turnId: input.turnId,
        streaming: false,
        createdAt: input.completedAt,
        updatedAt: input.completedAt,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly aggregateKind: OrchestrationEvent["aggregateKind"];
  readonly aggregateId: ThreadId | ProjectId;
  readonly occurredAt: string;
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}-${input.type}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`cmd-${input.sequence}-${input.type}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const value = await read();
  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(value, null, 2)}`);
}

async function createHarness(input: {
  readonly readModel: OrchestrationReadModel;
  readonly evaluate?: (input: YoloEvaluatorInput) => Effect.Effect<{
    readonly goalReached: boolean;
    readonly confidence: number;
    readonly missing: ReadonlyArray<string>;
    readonly nextPrompt: string;
    readonly reviewNote: string;
  }>;
}): Promise<ReactorHarness> {
  const commandsRef = Effect.runSync(Ref.make<ReadonlyArray<OrchestrationCommand>>([]));
  const evaluatorInputsRef = Effect.runSync(Ref.make<ReadonlyArray<YoloEvaluatorInput>>([]));
  const readModelRef = Effect.runSync(Ref.make(input.readModel));
  const eventPubSub = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () => Ref.get(readModelRef),
    readEvents: () => Stream.empty,
    dispatch: (command: OrchestrationCommand) =>
      Ref.update(commandsRef, (commands) => [...commands, command]).pipe(
        Effect.as({ sequence: 1 }),
      ),
    streamDomainEvents: Stream.fromPubSub(eventPubSub),
  });

  const evaluatorLayer = Layer.succeed(YoloEvaluator, {
    evaluate: (evaluateInput: YoloEvaluatorInput) =>
      Ref.update(evaluatorInputsRef, (inputs) => [...inputs, evaluateInput]).pipe(
        Effect.flatMap(
          () =>
            input.evaluate?.(evaluateInput) ??
            Effect.succeed({
              goalReached: true,
              confidence: 8,
              missing: [],
              nextPrompt: "",
              reviewNote: "Done.",
            }),
        ),
      ),
  });

  const runtime = ManagedRuntime.make(
    YoloReactorLive.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(evaluatorLayer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
    ),
  );
  const reactor = await runtime.runPromise(Effect.service(YoloReactor));
  const scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    runtime,
    scope,
    publish: (event) => Effect.runPromise(PubSub.publish(eventPubSub, event).pipe(Effect.asVoid)),
    getCommands: () => Effect.runPromise(Ref.get(commandsRef)),
    getEvaluatorInputs: () => Effect.runPromise(Ref.get(evaluatorInputsRef)),
  };
}

describe("detectYoloTerminalProviderBlocker", () => {
  it("detects Claude image dimension continuation blockers", () => {
    const message =
      "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.";

    expect(detectYoloTerminalProviderBlocker(message)).toBe(message);
  });

  it("detects missing provider session blockers", () => {
    const message = "Claude Code returned an error result: No conversation found with session ID.";

    expect(detectYoloTerminalProviderBlocker(message)).toBe(message);
  });

  it("does not block ordinary assistant output", () => {
    expect(detectYoloTerminalProviderBlocker("I posted the next Instagram draft.")).toBeNull();
  });
});

describe("computeYoloReviewRemainingDelayMs", () => {
  it("returns only the remaining delay", () => {
    expect(
      computeYoloReviewRemainingDelayMs({
        completedAt: "2026-04-25T10:00:00.000Z",
        triggerDelaySeconds: 60,
        nowMs: Date.parse("2026-04-25T10:00:20.000Z"),
      }),
    ).toBe(40_000);
  });

  it("clamps overdue reviews to zero delay", () => {
    expect(
      computeYoloReviewRemainingDelayMs({
        completedAt: "2026-04-25T10:00:00.000Z",
        triggerDelaySeconds: 60,
        nowMs: Date.parse("2026-04-25T10:02:00.000Z"),
      }),
    ).toBe(0);
  });
});

describe("YoloReactor delayed review handling", () => {
  let harness: ReactorHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await Effect.runPromise(Scope.close(harness.scope, Exit.void));
      await harness.runtime.dispose();
    }
    harness = null;
  });

  it("does not block unrelated failures behind a delayed review", async () => {
    const startedAt = new Date().toISOString();
    const startupCompletedAt = startedAt;
    const delayedThreadId = ThreadId.make("thread-delayed");
    const failureThreadId = ThreadId.make("thread-failure");
    const delayedRunId = YoloRunId.make("run-delayed");
    const failureRunId = YoloRunId.make("run-failure");
    const delayedTurnId = TurnId.make("turn-delayed");
    const failureTurnId = TurnId.make("turn-failure");

    harness = await createHarness({
      readModel: {
        snapshotSequence: 1,
        projects: [makeProject(startedAt)],
        threads: [
          makeThread({
            threadId: delayedThreadId,
            runId: delayedRunId,
            turnId: delayedTurnId,
            startedAt,
            completedAt: startupCompletedAt,
            triggerDelaySeconds: 300,
          }),
          makeThread({
            threadId: failureThreadId,
            runId: failureRunId,
            turnId: failureTurnId,
            startedAt,
            completedAt: startupCompletedAt,
            triggerDelaySeconds: 0,
          }),
        ],
        scheduledJobs: [],
        updatedAt: startedAt,
      },
    });

    const delayedCompletedAt = new Date().toISOString();
    const failureUpdatedAt = new Date().toISOString();
    await harness.publish(
      makeEvent({
        sequence: 2,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: delayedThreadId,
        occurredAt: delayedCompletedAt,
        payload: {
          threadId: delayedThreadId,
          turnId: delayedTurnId,
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-delayed/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-thread-delayed"),
          completedAt: delayedCompletedAt,
        },
      }),
    );
    await harness.publish(
      makeEvent({
        sequence: 3,
        type: "thread.session-set",
        aggregateKind: "thread",
        aggregateId: failureThreadId,
        occurredAt: failureUpdatedAt,
        payload: {
          threadId: failureThreadId,
          session: {
            threadId: failureThreadId,
            status: "error",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "Provider crashed",
            updatedAt: failureUpdatedAt,
          },
        },
      }),
    );

    const commands = await waitFor(harness.getCommands, (entries) =>
      entries.some(
        (command) =>
          command.type === "thread.yolo.review.complete" && command.threadId === failureThreadId,
      ),
    );
    expect(
      commands.some(
        (command) =>
          command.type === "thread.yolo.review.complete" && command.threadId === failureThreadId,
      ),
    ).toBe(true);
    expect(await harness.getEvaluatorInputs()).toHaveLength(0);
  });

  it("replays overdue startup reviews immediately and stamps them with fresh times", async () => {
    const startedAt = "2026-04-25T10:00:00.000Z";
    const completedAt = "2026-04-25T10:10:00.000Z";
    const threadId = ThreadId.make("thread-restart");
    const runId = YoloRunId.make("run-restart");
    const turnId = TurnId.make("turn-restart");

    harness = await createHarness({
      readModel: {
        snapshotSequence: 1,
        projects: [makeProject(startedAt)],
        threads: [
          makeThread({
            threadId,
            runId,
            turnId,
            startedAt,
            completedAt,
            triggerDelaySeconds: 60,
          }),
        ],
        scheduledJobs: [],
        updatedAt: startedAt,
      },
    });

    const commands = await waitFor(harness.getCommands, (entries) =>
      entries.some(
        (command) =>
          command.type === "thread.yolo.review.complete" && command.threadId === threadId,
      ),
    );
    expect(await harness.getEvaluatorInputs()).toHaveLength(1);

    const reviewCommand = commands.find(
      (command) => command.type === "thread.yolo.review.complete" && command.threadId === threadId,
    );
    const activityCommand = commands.find(
      (command) => command.type === "thread.activity.append" && command.threadId === threadId,
    );

    expect(reviewCommand?.type).toBe("thread.yolo.review.complete");
    expect(activityCommand?.type).toBe("thread.activity.append");

    if (reviewCommand?.type !== "thread.yolo.review.complete") {
      throw new Error("Missing review command.");
    }
    if (activityCommand?.type !== "thread.activity.append") {
      throw new Error("Missing activity command.");
    }

    expect(reviewCommand.review.createdAt).not.toBe(completedAt);
    expect(reviewCommand.updatedAt).not.toBe(completedAt);
    expect(Date.parse(reviewCommand.review.createdAt)).toBeGreaterThan(Date.parse(completedAt));
    expect(activityCommand.activity.createdAt).not.toBe(completedAt);
    expect(Date.parse(activityCommand.activity.createdAt)).toBeGreaterThan(Date.parse(completedAt));
  });

  it("reviews with the active thread provider and model instead of the global text-generation setting", async () => {
    const startedAt = "2026-04-25T11:00:00.000Z";
    const completedAt = "2026-04-25T11:10:00.000Z";
    const threadId = ThreadId.make("thread-cursor-review");
    const runId = YoloRunId.make("run-cursor-review");
    const turnId = TurnId.make("turn-cursor-review");
    const cursorModelSelection = {
      instanceId: ProviderInstanceId.make("cursor"),
      model: "composer-2",
    };

    harness = await createHarness({
      readModel: {
        snapshotSequence: 1,
        projects: [makeProject(startedAt)],
        threads: [
          makeThread({
            threadId,
            runId,
            turnId,
            startedAt,
            completedAt,
            triggerDelaySeconds: 0,
            modelSelection: cursorModelSelection,
          }),
        ],
        scheduledJobs: [],
        updatedAt: startedAt,
      },
    });

    const evaluatorInputs = await waitFor(
      harness.getEvaluatorInputs,
      (entries) => entries.length === 1,
    );

    expect(evaluatorInputs[0]?.modelSelection).toEqual(cursorModelSelection);
  });
});
