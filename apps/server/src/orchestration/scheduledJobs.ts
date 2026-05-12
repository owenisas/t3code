// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import type { ScheduledJobSchedule } from "@t3tools/contracts";

export function computeNextScheduledJobRunAt(
  schedule: ScheduledJobSchedule,
  fromIso: string,
): string {
  const fromMs = Date.parse(fromIso);
  const intervalMs = schedule.intervalMinutes * 60_000;
  return new Date(fromMs + intervalMs).toISOString();
}

export function formatScheduledJobThreadTitle(title: string, startedAt: string): string {
  const compact = startedAt.slice(0, 16).replace("T", " ");
  return `${title} · ${compact}`;
}
