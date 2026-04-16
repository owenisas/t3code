import {
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  ScheduledJobId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";

import { randomUUID } from "./lib/utils";
import { newCommandId } from "./lib/utils";

export const SCHEDULE_SLASH_COMMAND_USAGE =
  "Use /schedule every 6h Prompt, or /schedule every 6h Title :: Prompt.";

type ScheduleSlashCommandUnit = "hour" | "day";

export type ScheduleSlashCommandParseResult =
  | {
      kind: "match";
      intervalHours: number;
      title: string;
      prompt: string;
    }
  | {
      kind: "error";
      error: string;
    }
  | null;

function normalizeScheduleCommandUnit(raw: string): ScheduleSlashCommandUnit | null {
  const normalized = raw.toLowerCase();
  if (["h", "hr", "hrs", "hour", "hours"].includes(normalized)) {
    return "hour";
  }
  if (["d", "day", "days"].includes(normalized)) {
    return "day";
  }
  return null;
}

export function deriveScheduledJobTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return truncate(firstLine ?? "Scheduled job");
}

export function parseScheduleSlashCommand(input: string): ScheduleSlashCommandParseResult {
  const trimmed = input.trim();
  if (!/^\/schedule\b/i.test(trimmed)) {
    return null;
  }

  const body = trimmed.replace(/^\/schedule\b/i, "").trim();
  if (body.length === 0) {
    return { kind: "error", error: SCHEDULE_SLASH_COMMAND_USAGE };
  }

  const match = /^(?:every\s+)?(\d+)\s*(h|hr|hrs|hour|hours|d|day|days)\s+([\s\S]+)$/iu.exec(body);
  if (!match) {
    return { kind: "error", error: SCHEDULE_SLASH_COMMAND_USAGE };
  }

  const rawAmount = Number.parseInt(match[1] ?? "", 10);
  const unit = normalizeScheduleCommandUnit(match[2] ?? "");
  const remainder = (match[3] ?? "").trim();
  if (!Number.isInteger(rawAmount) || rawAmount <= 0 || unit === null || remainder.length === 0) {
    return { kind: "error", error: SCHEDULE_SLASH_COMMAND_USAGE };
  }

  const intervalHours = unit === "day" ? rawAmount * 24 : rawAmount;
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) {
    return {
      kind: "error",
      error: "Scheduled jobs currently support intervals between 1 hour and 7 days.",
    };
  }

  const separatorIndex = remainder.indexOf("::");
  const title =
    separatorIndex >= 0
      ? remainder.slice(0, separatorIndex).trim()
      : deriveScheduledJobTitle(remainder);
  const prompt = (separatorIndex >= 0 ? remainder.slice(separatorIndex + 2) : remainder).trim();
  if (prompt.length === 0) {
    return { kind: "error", error: "Enter the scheduled job prompt after the interval." };
  }

  return {
    kind: "match",
    intervalHours,
    title: title.length > 0 ? title : deriveScheduledJobTitle(prompt),
    prompt,
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
