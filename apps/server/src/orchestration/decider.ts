import {
  EventId,
  type MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireScheduledJob,
  requireScheduledJobAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { computeNextScheduledJobRunAt, formatScheduledJobThreadTitle } from "./scheduledJobs.ts";
import { projectEvent } from "./projector.ts";

const DEFAULT_FORK_THREAD_TITLE_SUFFIX = " (fork)";
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function isThreadTurnRunning(thread: OrchestrationReadModel["threads"][number]): boolean {
  return thread.session?.status === "running" && thread.session.activeTurnId !== null;
}

function buildForkThreadTitle(sourceTitle: string, explicitTitle?: string): string {
  const normalizedExplicitTitle = explicitTitle?.trim();
  if (normalizedExplicitTitle && normalizedExplicitTitle.length > 0) {
    return normalizedExplicitTitle;
  }
  const normalizedSourceTitle = sourceTitle.trim();
  if (normalizedSourceTitle.endsWith(DEFAULT_FORK_THREAD_TITLE_SUFFIX)) {
    return normalizedSourceTitle;
  }
  return `${normalizedSourceTitle}${DEFAULT_FORK_THREAD_TITLE_SUFFIX}`;
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

function buildYoloInterruptedByUserMessageEvent(input: {
  readonly thread: OrchestrationReadModel["threads"][number];
  readonly command: Pick<OrchestrationCommand, "commandId"> & {
    readonly threadId: OrchestrationReadModel["threads"][number]["id"];
    readonly createdAt: string;
  };
  readonly messageOrigin: "human" | "yolo-reviewer" | undefined;
}): PlannedOrchestrationEvent | null {
  if (input.messageOrigin === "yolo-reviewer") return null;
  const activeRun = input.thread.yoloRun?.status === "active" ? input.thread.yoloRun : null;
  if (!activeRun) return null;
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.command.threadId,
      occurredAt: input.command.createdAt,
      commandId: input.command.commandId,
    }),
    type: "thread.yolo-stopped",
    payload: {
      threadId: input.command.threadId,
      runId: activeRun.id,
      reason: "Interrupted by user message.",
      stoppedAt: input.command.createdAt,
      updatedAt: input.command.createdAt,
    },
  };
}

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "scheduled-job.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireScheduledJobAbsent({
        readModel,
        command,
        jobId: command.jobId,
      });
      return {
        ...withEventBase({
          aggregateKind: "scheduled-job",
          aggregateId: command.jobId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "scheduled-job.created",
        payload: {
          job: {
            id: command.jobId,
            projectId: command.projectId,
            title: command.title,
            prompt: command.prompt,
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            status: "active",
            schedule: command.schedule,
            lastRunAt: null,
            nextRunAt: computeNextScheduledJobRunAt(command.schedule, command.createdAt),
            lastOutcome: null,
            lastThreadId: null,
            lastError: null,
            activeRun: null,
            runs: [],
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
            deletedAt: null,
          },
        },
      };
    }

    case "scheduled-job.update": {
      const existingJob = yield* requireScheduledJob({
        readModel,
        command,
        jobId: command.jobId,
      });
      const updatedAt = command.createdAt;
      const nextSchedule = command.schedule ?? existingJob.schedule;
      return {
        ...withEventBase({
          aggregateKind: "scheduled-job",
          aggregateId: command.jobId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        }),
        type: "scheduled-job.updated",
        payload: {
          jobId: command.jobId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.prompt !== undefined ? { prompt: command.prompt } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.runtimeMode !== undefined ? { runtimeMode: command.runtimeMode } : {}),
          ...(command.interactionMode !== undefined
            ? { interactionMode: command.interactionMode }
            : {}),
          ...(command.schedule !== undefined ? { schedule: command.schedule } : {}),
          nextRunAt:
            existingJob.status === "active"
              ? computeNextScheduledJobRunAt(nextSchedule, updatedAt)
              : null,
          updatedAt,
        },
      };
    }

    case "scheduled-job.pause": {
      const job = yield* requireScheduledJob({
        readModel,
        command,
        jobId: command.jobId,
      });
      if (job.status === "paused") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Scheduled job '${command.jobId}' is already paused.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "scheduled-job",
          aggregateId: command.jobId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "scheduled-job.paused",
        payload: {
          jobId: command.jobId,
          updatedAt: command.createdAt,
        },
      };
    }

    case "scheduled-job.resume": {
      const job = yield* requireScheduledJob({
        readModel,
        command,
        jobId: command.jobId,
      });
      if (job.status === "active") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Scheduled job '${command.jobId}' is already active.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "scheduled-job",
          aggregateId: command.jobId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "scheduled-job.resumed",
        payload: {
          jobId: command.jobId,
          nextRunAt: computeNextScheduledJobRunAt(job.schedule, command.createdAt),
          updatedAt: command.createdAt,
        },
      };
    }

    case "scheduled-job.delete": {
      yield* requireScheduledJob({
        readModel,
        command,
        jobId: command.jobId,
      });
      return {
        ...withEventBase({
          aggregateKind: "scheduled-job",
          aggregateId: command.jobId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "scheduled-job.deleted",
        payload: {
          jobId: command.jobId,
          deletedAt: command.createdAt,
        },
      };
    }

    case "scheduled-job.run.trigger": {
      const job = yield* requireScheduledJob({
        readModel,
        command,
        jobId: command.jobId,
      });
      yield* requireProject({
        readModel,
        command,
        projectId: job.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (job.activeRun !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Scheduled job '${command.jobId}' already has an active run.`,
        });
      }
      if (job.status !== "active" && command.trigger !== "manual") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Paused scheduled job '${command.jobId}' cannot be triggered by the scheduler.`,
        });
      }

      const threadCreatedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: job.projectId,
          title: formatScheduledJobThreadTitle(job.title, command.createdAt),
          modelSelection: job.modelSelection,
          runtimeMode: job.runtimeMode,
          interactionMode: job.interactionMode,
          branch: null,
          worktreePath: null,
          forkOrigin: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const messageSentEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: threadCreatedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "user",
          text: job.prompt,
          attachments: [],
          origin: "human",
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: messageSentEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          modelSelection: job.modelSelection,
          titleSeed: job.title,
          runtimeMode: job.runtimeMode,
          interactionMode: job.interactionMode,
          createdAt: command.createdAt,
        },
      };
      const runStartedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "scheduled-job",
          aggregateId: command.jobId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: turnRequestedEvent.eventId,
        type: "scheduled-job.run-started",
        payload: {
          jobId: command.jobId,
          run: {
            id: command.runId,
            jobId: command.jobId,
            threadId: command.threadId,
            trigger: command.trigger,
            startedAt: command.createdAt,
            completedAt: null,
            outcome: null,
            error: null,
          },
          nextRunAt:
            job.status === "active"
              ? computeNextScheduledJobRunAt(job.schedule, command.createdAt)
              : null,
          updatedAt: command.createdAt,
        },
      };
      return [threadCreatedEvent, messageSentEvent, turnRequestedEvent, runStartedEvent];
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          forkOrigin: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.fork": {
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });

      const sourceMessageIndex = sourceThread.messages.findIndex(
        (message) => message.id === command.sourceMessageId,
      );
      if (sourceMessageIndex < 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.sourceMessageId}' was not found on thread '${command.sourceThreadId}'.`,
        });
      }

      const sourceMessage = sourceThread.messages[sourceMessageIndex];
      if (!sourceMessage || (sourceMessage.role !== "user" && sourceMessage.role !== "assistant")) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Only user and assistant messages can be used as fork points.",
        });
      }
      if (sourceMessage.role === "assistant" && sourceMessage.streaming) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Streaming assistant messages cannot be used as fork points.",
        });
      }

      const threadCreatedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: sourceThread.projectId,
          title: buildForkThreadTitle(sourceThread.title, command.title),
          modelSelection: sourceThread.modelSelection,
          runtimeMode: sourceThread.runtimeMode,
          interactionMode: sourceThread.interactionMode,
          branch: sourceThread.branch,
          worktreePath: sourceThread.worktreePath,
          forkOrigin: {
            sourceThreadId: command.sourceThreadId,
            sourceMessageId: command.sourceMessageId,
            hydratedAt: null,
          },
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      const copyEndIndex =
        sourceMessage.role === "assistant" ? sourceMessageIndex + 1 : sourceMessageIndex;
      const copiedMessageEvents: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> =
        sourceThread.messages.slice(0, copyEndIndex).map((message, index) => {
          const event = Object.assign(
            withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: message.createdAt,
              commandId: command.commandId,
            }),
            index === 0 ? { causationEventId: threadCreatedEvent.eventId } : {},
            {
              type: "thread.message-sent" as const,
              payload: {
                threadId: command.threadId,
                messageId: crypto.randomUUID() as MessageId,
                role: message.role,
                text: message.text,
                origin: message.origin,
                turnId: null,
                streaming: false,
                createdAt: message.createdAt,
                updatedAt: message.updatedAt,
              },
            },
          );
          if (message.attachments !== undefined) {
            Object.assign(event.payload, { attachments: message.attachments });
          }
          return event;
        });

      return [threadCreatedEvent, ...copiedMessageEvents];
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.starredAt !== undefined ? { starredAt: command.starredAt } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          origin: command.message.origin ?? "human",
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      const yoloInterruptedEvent = buildYoloInterruptedByUserMessageEvent({
        thread: targetThread,
        command,
        messageOrigin: command.message.origin,
      });
      return yoloInterruptedEvent
        ? [yoloInterruptedEvent, userMessageEvent, turnStartRequestedEvent]
        : [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.steer": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (!isThreadTurnRunning(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' does not have an active running turn to steer.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          origin: command.message.origin ?? "human",
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const steerRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-steer-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          createdAt: command.createdAt,
        },
      };
      const yoloInterruptedEvent = buildYoloInterruptedByUserMessageEvent({
        thread,
        command,
        messageOrigin: command.message.origin,
      });
      return yoloInterruptedEvent
        ? [yoloInterruptedEvent, userMessageEvent, steerRequestedEvent]
        : [userMessageEvent, steerRequestedEvent];
    }

    case "thread.follow-up.queue": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (!isThreadTurnRunning(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' does not have an active running turn to queue behind.`,
        });
      }
      const followUpQueuedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.follow-up-queued",
        payload: {
          threadId: command.threadId,
          followUp: {
            id: command.followUpId,
            messageId: command.message.messageId,
            text: command.message.text,
            attachments: command.message.attachments,
            modelSelection: command.modelSelection ?? null,
            interactionMode: command.interactionMode ?? thread.interactionMode,
            queuedAt: command.createdAt,
          },
          updatedAt: command.createdAt,
        },
      };
      const yoloInterruptedEvent = buildYoloInterruptedByUserMessageEvent({
        thread,
        command,
        messageOrigin: command.message.origin,
      });
      return yoloInterruptedEvent
        ? [yoloInterruptedEvent, followUpQueuedEvent]
        : followUpQueuedEvent;
    }

    case "thread.follow-up.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingFollowUp = thread.queuedFollowUps.find(
        (followUp) => followUp.id === command.followUpId,
      );
      if (!existingFollowUp) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued follow-up '${command.followUpId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "thread.follow-up-updated",
        payload: {
          threadId: command.threadId,
          followUp: {
            ...existingFollowUp,
            text: command.text,
          },
          updatedAt: command.updatedAt,
        },
      };
    }

    case "thread.follow-up.delete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingFollowUp = thread.queuedFollowUps.find(
        (followUp) => followUp.id === command.followUpId,
      );
      if (!existingFollowUp) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued follow-up '${command.followUpId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.deletedAt,
          commandId: command.commandId,
        }),
        type: "thread.follow-up-deleted",
        payload: {
          threadId: command.threadId,
          followUpId: command.followUpId,
          deletedAt: command.deletedAt,
        },
      };
    }

    case "thread.turn.interrupt": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const activeTurnId =
        command.turnId ??
        (thread.session?.activeTurnId === null ? undefined : thread.session?.activeTurnId);
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.yolo.start": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.yoloRun?.status === "active") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has an active YOLO run.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.yolo-started",
        payload: {
          threadId: command.threadId,
          run: {
            id: command.runId,
            threadId: command.threadId,
            goal: command.goal,
            status: "active",
            maxIterations: command.maxIterations,
            triggerDelaySeconds: command.triggerDelaySeconds,
            iteration: 0,
            lastReview: null,
            reviews: [],
            lastError: null,
            startedAt: command.createdAt,
            completedAt: null,
            updatedAt: command.createdAt,
          },
        },
      };
    }

    case "thread.yolo.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const activeRun = thread.yoloRun?.status === "active" ? thread.yoloRun : null;
      if (!activeRun) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' does not have an active YOLO run.`,
        });
      }
      if (command.runId !== undefined && activeRun.id !== command.runId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `YOLO run '${command.runId}' is not active on thread '${command.threadId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.yolo-stopped",
        payload: {
          threadId: command.threadId,
          runId: activeRun.id,
          reason: command.reason ?? null,
          stoppedAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.yolo.review.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const activeRun = thread.yoloRun?.status === "active" ? thread.yoloRun : null;
      if (!activeRun || activeRun.id !== command.review.runId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `YOLO run '${command.review.runId}' is not active on thread '${command.threadId}'.`,
        });
      }
      const status = command.completedStatus ?? activeRun.status;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "thread.yolo-review-completed",
        payload: {
          threadId: command.threadId,
          runId: activeRun.id,
          review: command.review,
          status,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    case "thread.fork-context.hydrate": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.hydratedAt,
          commandId: command.commandId,
        }),
        type: "thread.fork-context-hydrated",
        payload: {
          threadId: command.threadId,
          hydratedAt: command.hydratedAt,
          updatedAt: command.hydratedAt,
        },
      };
    }

    case "scheduled-job.run.complete": {
      const job = yield* requireScheduledJob({
        readModel,
        command,
        jobId: command.jobId,
      });
      if (job.activeRun === null || job.activeRun.id !== command.runId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Scheduled job '${command.jobId}' does not have active run '${command.runId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "scheduled-job",
          aggregateId: command.jobId,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        }),
        type: "scheduled-job.run-completed",
        payload: {
          jobId: command.jobId,
          runId: command.runId,
          outcome: command.outcome,
          error: command.error ?? null,
          completedAt: command.completedAt,
          updatedAt: command.completedAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
