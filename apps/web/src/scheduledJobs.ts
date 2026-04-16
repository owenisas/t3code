import {
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  ScheduledJobId,
  type RuntimeMode,
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
    "Help the user turn the request below into a T3 Code scheduled agent job for the current project.",
    "",
    "T3 Code scheduled job rules:",
    "- Jobs are project-level recurring agent runs managed by T3 Code.",
    "- Each scheduled run creates a fresh thread in the target project.",
    "- The v1 scheduler supports interval schedules only: every N hours, from 1 hour through 7 days.",
    "- A useful job definition needs a title, schedule interval, and a self-contained prompt describing what the scheduled agent should do each run.",
    "- The job prompt should specify what to inspect, what changes are allowed, what verification to run, and what to report when there is nothing to do.",
    "",
    "Your task:",
    "- Treat the user's text after /job as the intended job content.",
    "- If the content has enough detail, produce a concise proposed job definition with title, interval, and final job prompt.",
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
