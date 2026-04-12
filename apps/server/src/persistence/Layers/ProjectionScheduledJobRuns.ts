import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionScheduledJobRunInput,
  ListProjectionScheduledJobRunsByJobInput,
  ListProjectionScheduledJobRunsByThreadInput,
  ProjectionScheduledJobRun,
  ProjectionScheduledJobRunRepository,
  type ProjectionScheduledJobRunRepositoryShape,
} from "../Services/ProjectionScheduledJobRuns.ts";

const makeProjectionScheduledJobRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionScheduledJobRun,
    execute: (row) =>
      sql`
        INSERT INTO projection_scheduled_job_runs (
          run_id,
          job_id,
          thread_id,
          trigger,
          started_at,
          completed_at,
          outcome,
          error
        )
        VALUES (
          ${row.runId},
          ${row.jobId},
          ${row.threadId},
          ${row.trigger},
          ${row.startedAt},
          ${row.completedAt},
          ${row.outcome},
          ${row.error}
        )
        ON CONFLICT (run_id)
        DO UPDATE SET
          job_id = excluded.job_id,
          thread_id = excluded.thread_id,
          trigger = excluded.trigger,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          outcome = excluded.outcome,
          error = excluded.error
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionScheduledJobRunInput,
    Result: ProjectionScheduledJobRun,
    execute: ({ runId }) =>
      sql`
        SELECT
          run_id AS "runId",
          job_id AS "jobId",
          thread_id AS "threadId",
          trigger,
          started_at AS "startedAt",
          completed_at AS "completedAt",
          outcome,
          error
        FROM projection_scheduled_job_runs
        WHERE run_id = ${runId}
      `,
  });

  const listByJobRows = SqlSchema.findAll({
    Request: ListProjectionScheduledJobRunsByJobInput,
    Result: ProjectionScheduledJobRun,
    execute: ({ jobId }) =>
      sql`
        SELECT
          run_id AS "runId",
          job_id AS "jobId",
          thread_id AS "threadId",
          trigger,
          started_at AS "startedAt",
          completed_at AS "completedAt",
          outcome,
          error
        FROM projection_scheduled_job_runs
        WHERE job_id = ${jobId}
        ORDER BY started_at DESC, run_id DESC
      `,
  });

  const listByThreadRows = SqlSchema.findAll({
    Request: ListProjectionScheduledJobRunsByThreadInput,
    Result: ProjectionScheduledJobRun,
    execute: ({ threadId }) =>
      sql`
        SELECT
          run_id AS "runId",
          job_id AS "jobId",
          thread_id AS "threadId",
          trigger,
          started_at AS "startedAt",
          completed_at AS "completedAt",
          outcome,
          error
        FROM projection_scheduled_job_runs
        WHERE thread_id = ${threadId}
        ORDER BY started_at DESC, run_id DESC
      `,
  });

  const deleteRow = SqlSchema.void({
    Request: GetProjectionScheduledJobRunInput,
    execute: ({ runId }) =>
      sql`
        DELETE FROM projection_scheduled_job_runs
        WHERE run_id = ${runId}
      `,
  });

  return {
    upsert: (row) =>
      upsertRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionScheduledJobRunRepository.upsert:query")),
      ),
    getById: (input) =>
      getRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionScheduledJobRunRepository.getById:query")),
      ),
    listByJobId: (input) =>
      listByJobRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionScheduledJobRunRepository.listByJobId:query"),
        ),
      ),
    listByThreadId: (input) =>
      listByThreadRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionScheduledJobRunRepository.listByThreadId:query"),
        ),
      ),
    deleteById: (input) =>
      deleteRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionScheduledJobRunRepository.deleteById:query"),
        ),
      ),
  } satisfies ProjectionScheduledJobRunRepositoryShape;
});

export const ProjectionScheduledJobRunRepositoryLive = Layer.effect(
  ProjectionScheduledJobRunRepository,
  makeProjectionScheduledJobRunRepository,
);
