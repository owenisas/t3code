import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_scheduled_jobs (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      last_run_at TEXT,
      next_run_at TEXT,
      last_outcome TEXT,
      last_thread_id TEXT,
      last_error TEXT,
      active_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_scheduled_job_runs (
      run_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      outcome TEXT,
      error TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_scheduled_jobs_project_status_next
    ON projection_scheduled_jobs(project_id, status, next_run_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_scheduled_jobs_active_run
    ON projection_scheduled_jobs(active_run_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_scheduled_job_runs_job_started
    ON projection_scheduled_job_runs(job_id, started_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_scheduled_job_runs_thread_id
    ON projection_scheduled_job_runs(thread_id)
  `;
});
