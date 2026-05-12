import {
  MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  ScheduledJobId,
  ScheduledJobRunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import { randomUUID } from "./lib/utils";
import { newCommandId } from "./lib/utils";

export const JOB_SLASH_COMMAND_USAGE =
  "Use /job followed by the recurring job you want to create, for example: /job every 6h Check the repo for failing builds.";

export type JobSlashCommandParseResult =
  | {
      kind: "match";
      content: string;
      injectedPrompt: string;
    }
  | {
      kind: "error";
      error: string;
    }
  | null;

export function buildJobCreationInstructionPrompt(content: string): string {
  const trimmedContent = content.trim();
  return [
    "The user invoked T3 Code's /job helper. This is a T3-owned helper, not a provider-native slash command.",
    "",
    "Create or update a T3 Code scheduled job for the current project by editing the project-local manifest file.",
    "",
    "T3 Code scheduled job rules:",
    "- Jobs are project-level recurring agent runs managed by T3 Code.",
    "- Each scheduled run creates a fresh thread in the target project.",
    "- The v1 scheduler supports interval schedules only: every N hours, from 1 hour through 7 days.",
    "- T3 imports jobs from .t3/jobs.json after the turn completes and on future scheduler scans.",
    "- Preserve existing entries in .t3/jobs.json unless the user clearly asks to remove or replace them.",
    "",
    "Manifest path:",
    ".t3/jobs.json",
    "",
    "Manifest shape:",
    JSON.stringify(
      {
        jobs: [
          {
            id: "stable-kebab-case-id",
            title: "Short job title",
            intervalHours: 6,
            prompt: "Self-contained instructions for what the scheduled agent should do each run.",
            provider: "codex",
            model: "gpt-5.4",
            runtimeMode: "full-access",
            interactionMode: "default",
            status: "active",
          },
        ],
      },
      null,
      2,
    ),
    "",
    "Your task:",
    "- Treat the user's text after /job as the intended job content.",
    "- If the content has enough detail, create or update .t3/jobs.json directly using your file-editing tools.",
    "- Use a stable id with letters, numbers, dots, underscores, or dashes only.",
    "- The job prompt must specify what to inspect, what changes are allowed, what verification to run, and what to report when there is nothing to do.",
    "- If critical details are missing, ask only the smallest necessary follow-up questions.",
    "- Do not execute the recurring task now unless the user explicitly asks you to run it immediately.",
    "",
    "User job content:",
    trimmedContent,
  ].join("\n");
}

export function parseJobSlashCommand(input: string): JobSlashCommandParseResult {
  const trimmed = input.trim();
  if (!/^\/job\b/i.test(trimmed)) {
    return null;
  }

  const content = trimmed.replace(/^\/job\b/i, "").trim();
  if (content.length === 0) {
    return { kind: "error", error: JOB_SLASH_COMMAND_USAGE };
  }

  return {
    kind: "match",
    content,
    injectedPrompt: buildJobCreationInstructionPrompt(content),
  };
}

export function buildScheduledJobCreateCommand(input: {
  projectId: ProjectId;
  title: string;
  prompt: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  intervalHours: number;
  createdAt?: string;
}) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    type: "scheduled-job.create" as const,
    commandId: newCommandId(),
    jobId: ScheduledJobId.make(randomUUID()),
    projectId: input.projectId,
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    schedule: {
      type: "interval" as const,
      intervalMinutes: input.intervalHours * 60,
    },
    createdAt,
  };
}

export function buildScheduledJobUpdateCommand(input: {
  jobId: ScheduledJobId;
  title: string;
  prompt: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  intervalHours: number;
  createdAt?: string;
}) {
  return {
    type: "scheduled-job.update" as const,
    commandId: newCommandId(),
    jobId: input.jobId,
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    schedule: {
      type: "interval" as const,
      intervalMinutes: input.intervalHours * 60,
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function buildScheduledJobRunNowCommand(input: {
  jobId: ScheduledJobId;
  createdAt?: string;
}) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    type: "scheduled-job.run.trigger" as const,
    commandId: newCommandId(),
    jobId: input.jobId,
    runId: ScheduledJobRunId.make(randomUUID()),
    threadId: ThreadId.make(randomUUID()),
    messageId: MessageId.make(randomUUID()),
    trigger: "manual" as const,
    createdAt,
  };
}

export function buildScheduledJobPauseCommand(input: {
  jobId: ScheduledJobId;
  createdAt?: string;
}) {
  return {
    type: "scheduled-job.pause" as const,
    commandId: newCommandId(),
    jobId: input.jobId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function buildScheduledJobResumeCommand(input: {
  jobId: ScheduledJobId;
  createdAt?: string;
}) {
  return {
    type: "scheduled-job.resume" as const,
    commandId: newCommandId(),
    jobId: input.jobId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function buildScheduledJobDeleteCommand(input: {
  jobId: ScheduledJobId;
  createdAt?: string;
}) {
  return {
    type: "scheduled-job.delete" as const,
    commandId: newCommandId(),
    jobId: input.jobId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
