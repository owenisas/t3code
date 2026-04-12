import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { ModelSelection, ScheduledJobRunId, ScheduledJobSchedule } from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionScheduledJobInput,
  ProjectionScheduledJob,
  ProjectionScheduledJobRepository,
  type ProjectionScheduledJobRepositoryShape,
} from "../Services/ProjectionScheduledJobs.ts";

const ProjectionScheduledJobDbRow = ProjectionScheduledJob.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    schedule: Schema.fromJsonString(ScheduledJobSchedule),
    activeRunId: Schema.NullOr(ScheduledJobRunId),
  }),
);
type ProjectionScheduledJobDbRow = typeof ProjectionScheduledJobDbRow.Type;

const makeProjectionScheduledJobRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionScheduledJob,
    execute: (row) =>
      sql`
        INSERT INTO projection_scheduled_jobs (
          job_id,
          project_id,
          title,
          prompt,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          status,
          schedule_json,
          last_run_at,
          next_run_at,
          last_outcome,
          last_thread_id,
          last_error,
          active_run_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.jobId},
          ${row.projectId},
          ${row.title},
          ${row.prompt},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.status},
          ${JSON.stringify(row.schedule)},
          ${row.lastRunAt},
          ${row.nextRunAt},
          ${row.lastOutcome},
          ${row.lastThreadId},
          ${row.lastError},
          ${row.activeRunId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (job_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          prompt = excluded.prompt,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          status = excluded.status,
          schedule_json = excluded.schedule_json,
          last_run_at = excluded.last_run_at,
          next_run_at = excluded.next_run_at,
          last_outcome = excluded.last_outcome,
          last_thread_id = excluded.last_thread_id,
          last_error = excluded.last_error,
          active_run_id = excluded.active_run_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionScheduledJobInput,
    Result: ProjectionScheduledJobDbRow,
    execute: ({ jobId }) =>
      sql`
        SELECT
          job_id AS "jobId",
          project_id AS "projectId",
          title,
          prompt,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          status,
          schedule_json AS "schedule",
          last_run_at AS "lastRunAt",
          next_run_at AS "nextRunAt",
          last_outcome AS "lastOutcome",
          last_thread_id AS "lastThreadId",
          last_error AS "lastError",
          active_run_id AS "activeRunId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_scheduled_jobs
        WHERE job_id = ${jobId}
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionScheduledJobDbRow,
    execute: () =>
      sql`
        SELECT
          job_id AS "jobId",
          project_id AS "projectId",
          title,
          prompt,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          status,
          schedule_json AS "schedule",
          last_run_at AS "lastRunAt",
          next_run_at AS "nextRunAt",
          last_outcome AS "lastOutcome",
          last_thread_id AS "lastThreadId",
          last_error AS "lastError",
          active_run_id AS "activeRunId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_scheduled_jobs
        ORDER BY created_at ASC, job_id ASC
      `,
  });

  const deleteRow = SqlSchema.void({
    Request: GetProjectionScheduledJobInput,
    execute: ({ jobId }) =>
      sql`
        DELETE FROM projection_scheduled_jobs
        WHERE job_id = ${jobId}
      `,
  });

  return {
    upsert: (row) =>
      upsertRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionScheduledJobRepository.upsert:query")),
      ),
    getById: (input) =>
      getRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionScheduledJobRepository.getById:query")),
      ),
    listAll: () =>
      listRows().pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionScheduledJobRepository.listAll:query")),
      ),
    deleteById: (input) =>
      deleteRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionScheduledJobRepository.deleteById:query")),
      ),
  } satisfies ProjectionScheduledJobRepositoryShape;
});

export const ProjectionScheduledJobRepositoryLive = Layer.effect(
  ProjectionScheduledJobRepository,
  makeProjectionScheduledJobRepository,
);
