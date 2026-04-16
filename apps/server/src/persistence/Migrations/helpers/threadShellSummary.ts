import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { rebuildProjectionPendingApprovals } from "./pendingApprovals.ts";

export const ensureProjectionThreadShellSummaryColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN latest_user_message_at TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0
  `.pipe(Effect.catch(() => Effect.void));
});

export const backfillProjectionThreadShellSummary = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* rebuildProjectionPendingApprovals;

  yield* sql`
    UPDATE projection_threads
    SET
      latest_user_message_at = (
        SELECT MAX(message.created_at)
        FROM projection_thread_messages AS message
        WHERE message.thread_id = projection_threads.thread_id
          AND message.role = 'user'
      ),
      pending_approval_count = COALESCE((
        SELECT COUNT(*)
        FROM projection_pending_approvals
        WHERE projection_pending_approvals.thread_id = projection_threads.thread_id
          AND projection_pending_approvals.status = 'pending'
      ), 0),
      pending_user_input_count = COALESCE((
        WITH latest_user_input_states AS (
          SELECT
            latest.request_id,
            latest.kind,
            latest.detail
          FROM (
            SELECT
              json_extract(activity.payload_json, '$.requestId') AS request_id,
              activity.kind,
              lower(COALESCE(json_extract(activity.payload_json, '$.detail'), '')) AS detail,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(activity.payload_json, '$.requestId')
                ORDER BY activity.created_at DESC, activity.activity_id DESC
              ) AS row_number
            FROM projection_thread_activities AS activity
            WHERE activity.thread_id = projection_threads.thread_id
              AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
              AND activity.kind IN (
                'user-input.requested',
                'user-input.resolved',
                'provider.user-input.respond.failed'
              )
          ) AS latest
          WHERE latest.row_number = 1
        )
        SELECT COUNT(*)
        FROM latest_user_input_states
        WHERE latest_user_input_states.kind = 'user-input.requested'
          OR (
            latest_user_input_states.kind = 'provider.user-input.respond.failed'
            AND latest_user_input_states.detail NOT LIKE '%stale pending user-input request%'
            AND latest_user_input_states.detail NOT LIKE '%unknown pending user-input request%'
          )
      ), 0),
      has_actionable_proposed_plan = COALESCE((
        SELECT CASE
          WHEN projection_threads.latest_turn_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM projection_thread_proposed_plans AS latest_turn_plan_exists
              WHERE latest_turn_plan_exists.thread_id = projection_threads.thread_id
                AND latest_turn_plan_exists.turn_id = projection_threads.latest_turn_id
            )
            THEN CASE
              WHEN (
                SELECT latest_turn_plan.implemented_at
                FROM projection_thread_proposed_plans AS latest_turn_plan
                WHERE latest_turn_plan.thread_id = projection_threads.thread_id
                  AND latest_turn_plan.turn_id = projection_threads.latest_turn_id
                ORDER BY latest_turn_plan.updated_at DESC, latest_turn_plan.plan_id DESC
                LIMIT 1
              ) IS NULL
                THEN 1
                ELSE 0
              END
          WHEN EXISTS (
            SELECT 1
            FROM projection_thread_proposed_plans AS any_plan
            WHERE any_plan.thread_id = projection_threads.thread_id
          )
            THEN CASE
              WHEN (
                SELECT latest_plan.implemented_at
                FROM projection_thread_proposed_plans AS latest_plan
                WHERE latest_plan.thread_id = projection_threads.thread_id
                ORDER BY latest_plan.updated_at DESC, latest_plan.plan_id DESC
                LIMIT 1
              ) IS NULL
                THEN 1
                ELSE 0
              END
          ELSE 0
        END
      ), 0)
  `;
});
