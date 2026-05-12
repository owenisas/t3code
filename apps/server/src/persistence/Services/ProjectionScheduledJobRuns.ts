// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import {
  IsoDateTime,
  ScheduledJobId,
  ScheduledJobRunId,
  ScheduledJobRunOutcome,
  ScheduledJobRunTrigger,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionScheduledJobRun = Schema.Struct({
  runId: ScheduledJobRunId,
  jobId: ScheduledJobId,
  threadId: ThreadId,
  trigger: ScheduledJobRunTrigger,
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  outcome: Schema.NullOr(ScheduledJobRunOutcome),
  error: Schema.NullOr(Schema.String),
});
export type ProjectionScheduledJobRun = typeof ProjectionScheduledJobRun.Type;

export const GetProjectionScheduledJobRunInput = Schema.Struct({
  runId: ScheduledJobRunId,
});
export type GetProjectionScheduledJobRunInput = typeof GetProjectionScheduledJobRunInput.Type;

export const ListProjectionScheduledJobRunsByJobInput = Schema.Struct({
  jobId: ScheduledJobId,
});
export type ListProjectionScheduledJobRunsByJobInput =
  typeof ListProjectionScheduledJobRunsByJobInput.Type;

export const ListProjectionScheduledJobRunsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionScheduledJobRunsByThreadInput =
  typeof ListProjectionScheduledJobRunsByThreadInput.Type;

export interface ProjectionScheduledJobRunRepositoryShape {
  readonly upsert: (
    row: ProjectionScheduledJobRun,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionScheduledJobRunInput,
  ) => Effect.Effect<Option.Option<ProjectionScheduledJobRun>, ProjectionRepositoryError>;
  readonly listByJobId: (
    input: ListProjectionScheduledJobRunsByJobInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionScheduledJobRun>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionScheduledJobRunsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionScheduledJobRun>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: GetProjectionScheduledJobRunInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionScheduledJobRunRepository extends Context.Service<
  ProjectionScheduledJobRunRepository,
  ProjectionScheduledJobRunRepositoryShape
>()("t3/persistence/Services/ProjectionScheduledJobRuns/ProjectionScheduledJobRunRepository") {}
