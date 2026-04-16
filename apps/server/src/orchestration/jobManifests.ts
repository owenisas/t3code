import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type ProviderKind,
  ScheduledJobId,
  type RuntimeMode,
} from "@t3tools/contracts";

export const T3_JOB_MANIFEST_RELATIVE_PATH = ".t3/jobs.json";

export interface ScheduledJobManifestEntry {
  readonly localId: string;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly status: "active" | "paused";
  readonly intervalMinutes: number;
}

export interface ScheduledJobManifestParseResult {
  readonly jobs: ReadonlyArray<ScheduledJobManifestEntry>;
  readonly errors: ReadonlyArray<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProviderKind = (value: unknown): value is ProviderKind =>
  value === "codex" || value === "claudeAgent";

const isRuntimeMode = (value: unknown): value is RuntimeMode =>
  value === "approval-required" || value === "auto-accept-edits" || value === "full-access";

const isInteractionMode = (value: unknown): value is ProviderInteractionMode =>
  value === "default" || value === "plan";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readIntervalMinutes(job: Record<string, unknown>): number | null {
  const directMinutes = readPositiveInteger(job.intervalMinutes);
  if (directMinutes !== null) {
    return directMinutes;
  }

  const directHours = readPositiveInteger(job.intervalHours);
  if (directHours !== null) {
    return directHours * 60;
  }

  const schedule = isRecord(job.schedule) ? job.schedule : null;
  if (!schedule) {
    return null;
  }

  const scheduleMinutes = readPositiveInteger(schedule.intervalMinutes);
  if (scheduleMinutes !== null) {
    return scheduleMinutes;
  }

  const scheduleHours = readPositiveInteger(schedule.intervalHours);
  return scheduleHours === null ? null : scheduleHours * 60;
}

function readManifestJobs(value: unknown): ReadonlyArray<unknown> | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.jobs)) {
    return value.jobs;
  }
  return null;
}

export function scheduledJobIdForManifest(projectId: ProjectId, localId: string): ScheduledJobId {
  return ScheduledJobId.make(`manifest:${projectId}:${localId}`);
}

export function parseScheduledJobManifest(
  rawJson: string,
  defaultModelSelection: ModelSelection | null | undefined,
): ScheduledJobManifestParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawJson);
  } catch (error) {
    return {
      jobs: [],
      errors: [error instanceof Error ? error.message : "Invalid JSON."],
    };
  }

  const rawJobs = readManifestJobs(decoded);
  if (!rawJobs) {
    return {
      jobs: [],
      errors: ["Expected a JSON object with a jobs array, or a top-level jobs array."],
    };
  }

  const jobs: ScheduledJobManifestEntry[] = [];
  const errors: string[] = [];
  rawJobs.forEach((rawJob, index) => {
    const prefix = `jobs[${index}]`;
    if (!isRecord(rawJob)) {
      errors.push(`${prefix}: expected an object.`);
      return;
    }

    const localId = readNonEmptyString(rawJob.id);
    if (!localId || !/^[a-z0-9._-]+$/i.test(localId)) {
      errors.push(
        `${prefix}.id: expected a stable id using letters, numbers, dots, underscores, or dashes.`,
      );
      return;
    }

    const title = readNonEmptyString(rawJob.title);
    if (!title) {
      errors.push(`${prefix}.title: expected a non-empty string.`);
      return;
    }

    const prompt = readNonEmptyString(rawJob.prompt);
    if (!prompt) {
      errors.push(`${prefix}.prompt: expected a non-empty string.`);
      return;
    }

    const intervalMinutes = readIntervalMinutes(rawJob);
    if (
      intervalMinutes === null ||
      intervalMinutes < 60 ||
      intervalMinutes > 7 * 24 * 60 ||
      intervalMinutes % 60 !== 0
    ) {
      errors.push(`${prefix}: expected an hourly interval from 1 hour through 7 days.`);
      return;
    }

    const defaultProvider = defaultModelSelection?.provider ?? "codex";
    const provider = isProviderKind(rawJob.provider) ? rawJob.provider : defaultProvider;
    const model =
      readNonEmptyString(rawJob.model) ??
      (defaultModelSelection?.provider === provider ? defaultModelSelection.model : null) ??
      DEFAULT_MODEL_BY_PROVIDER[provider];

    jobs.push({
      localId,
      title,
      prompt,
      modelSelection: {
        provider,
        model,
      },
      runtimeMode: isRuntimeMode(rawJob.runtimeMode) ? rawJob.runtimeMode : "full-access",
      interactionMode: isInteractionMode(rawJob.interactionMode)
        ? rawJob.interactionMode
        : "default",
      status: rawJob.status === "paused" ? "paused" : "active",
      intervalMinutes,
    });
  });

  return { jobs, errors };
}
