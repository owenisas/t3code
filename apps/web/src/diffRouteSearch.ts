import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  splitEnv?: EnvironmentId | undefined;
  splitThread?: ThreadId | undefined;
  focusedPane?: "primary" | "secondary" | undefined;
  splitDiff?: "1" | undefined;
  splitDiffTurnId?: TurnId | undefined;
  splitDiffFilePath?: string | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> {
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath">;
}

export function clearDiffSearchParams<T extends Record<string, unknown>>(params: T): T {
  return {
    ...params,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
  };
}

export function stripSplitSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  "splitEnv" | "splitThread" | "focusedPane" | "splitDiff" | "splitDiffTurnId" | "splitDiffFilePath"
> {
  const {
    splitEnv: _splitEnv,
    splitThread: _splitThread,
    focusedPane: _focusedPane,
    splitDiff: _splitDiff,
    splitDiffTurnId: _splitDiffTurnId,
    splitDiffFilePath: _splitDiffFilePath,
    ...rest
  } = params;
  return rest as Omit<
    T,
    | "splitEnv"
    | "splitThread"
    | "focusedPane"
    | "splitDiff"
    | "splitDiffTurnId"
    | "splitDiffFilePath"
  >;
}

export function clearSplitSearchParams<T extends Record<string, unknown>>(params: T): T {
  return {
    ...params,
    splitEnv: undefined,
    splitThread: undefined,
    focusedPane: undefined,
    splitDiff: undefined,
    splitDiffTurnId: undefined,
    splitDiffFilePath: undefined,
  };
}

export function stripSplitDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "splitDiff" | "splitDiffTurnId" | "splitDiffFilePath"> {
  const {
    splitDiff: _splitDiff,
    splitDiffTurnId: _splitDiffTurnId,
    splitDiffFilePath: _splitDiffFilePath,
    ...rest
  } = params;
  return rest as Omit<T, "splitDiff" | "splitDiffTurnId" | "splitDiffFilePath">;
}

export function clearSplitDiffSearchParams<T extends Record<string, unknown>>(params: T): T {
  return {
    ...params,
    splitDiff: undefined,
    splitDiffTurnId: undefined,
    splitDiffFilePath: undefined,
  };
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const splitEnvRaw = normalizeSearchString(search.splitEnv);
  const splitThreadRaw = normalizeSearchString(search.splitThread);
  const splitEnv = splitEnvRaw ? EnvironmentId.make(splitEnvRaw) : undefined;
  const splitThread = splitThreadRaw ? ThreadId.make(splitThreadRaw) : undefined;
  const focusedPane =
    search.focusedPane === "secondary" || search.focusedPane === "primary"
      ? search.focusedPane
      : splitEnv && splitThread
        ? "secondary"
        : undefined;
  const splitDiff = splitEnv && splitThread && isDiffOpenValue(search.splitDiff) ? "1" : undefined;
  const splitDiffTurnIdRaw = splitDiff ? normalizeSearchString(search.splitDiffTurnId) : undefined;
  const splitDiffTurnId = splitDiffTurnIdRaw ? TurnId.make(splitDiffTurnIdRaw) : undefined;
  const splitDiffFilePath =
    splitDiff && splitDiffTurnId ? normalizeSearchString(search.splitDiffFilePath) : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(splitEnv ? { splitEnv } : {}),
    ...(splitThread ? { splitThread } : {}),
    ...(focusedPane ? { focusedPane } : {}),
    ...(splitDiff ? { splitDiff } : {}),
    ...(splitDiffTurnId ? { splitDiffTurnId } : {}),
    ...(splitDiffFilePath ? { splitDiffFilePath } : {}),
  };
}
