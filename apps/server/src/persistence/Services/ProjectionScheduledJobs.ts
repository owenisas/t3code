// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import {
  IsoDateTime,
  ModelSelection,
  ProjectId,
  ScheduledJobId,
  ScheduledJobRunId,
  ScheduledJobRunOutcome,
  ScheduledJobSchedule,
  ScheduledJobStatus,
  ThreadId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionScheduledJob = Schema.Struct({
  jobId: ScheduledJobId,
  projectId: ProjectId,
  title: Schema.String,
  prompt: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  status: ScheduledJobStatus,
  schedule: ScheduledJobSchedule,
  lastRunAt: Schema.NullOr(IsoDateTime),
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastOutcome: Schema.NullOr(ScheduledJobRunOutcome),
  lastThreadId: Schema.NullOr(ThreadId),
  lastError: Schema.NullOr(Schema.String),
  activeRunId: Schema.NullOr(ScheduledJobRunId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionScheduledJob = typeof ProjectionScheduledJob.Type;

export const GetProjectionScheduledJobInput = Schema.Struct({
  jobId: ScheduledJobId,
});
export type GetProjectionScheduledJobInput = typeof GetProjectionScheduledJobInput.Type;

export interface ProjectionScheduledJobRepositoryShape {
  readonly upsert: (row: ProjectionScheduledJob) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionScheduledJobInput,
  ) => Effect.Effect<Option.Option<ProjectionScheduledJob>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionScheduledJob>,
    ProjectionRepositoryError
  >;
  readonly deleteById: (
    input: GetProjectionScheduledJobInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionScheduledJobRepository extends Context.Service<
  ProjectionScheduledJobRepository,
  ProjectionScheduledJobRepositoryShape
>()("t3/persistence/Services/ProjectionScheduledJobs/ProjectionScheduledJobRepository") {}
