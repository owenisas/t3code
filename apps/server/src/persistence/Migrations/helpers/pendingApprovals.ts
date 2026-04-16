import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const rebuildProjectionPendingApprovals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM projection_pending_approvals
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_pending_approvals (
      request_id,
      thread_id,
      turn_id,
      status,
      decision,
      created_at,
      resolved_at
    )
    SELECT
      requested.request_id,
      requested.thread_id,
      requested.turn_id,
      'pending',
      NULL,
      requested.created_at,
      NULL
    FROM (
      SELECT
        json_extract(payload_json, '$.requestId') AS request_id,
        thread_id,
        turn_id,
        created_at,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(payload_json, '$.requestId')
          ORDER BY created_at ASC, activity_id ASC
        ) AS row_number
      FROM projection_thread_activities
      WHERE kind = 'approval.requested'
        AND json_extract(payload_json, '$.requestId') IS NOT NULL
    ) AS requested
    WHERE requested.row_number = 1
  `;

  yield* sql`
    WITH latest_resolutions AS (
      SELECT
        resolved.request_id,
        resolved.resolved_at,
        resolved.decision
      FROM (
        SELECT
          json_extract(payload_json, '$.requestId') AS request_id,
          created_at AS resolved_at,
          CASE
            WHEN json_extract(payload_json, '$.decision') IN (
              'accept',
              'acceptForSession',
              'decline',
              'cancel'
            )
            THEN json_extract(payload_json, '$.decision')
            ELSE NULL
          END AS decision,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(payload_json, '$.requestId')
            ORDER BY created_at DESC, activity_id DESC
          ) AS row_number
        FROM projection_thread_activities
        WHERE kind = 'approval.resolved'
          AND json_extract(payload_json, '$.requestId') IS NOT NULL
      ) AS resolved
      WHERE resolved.row_number = 1
    )
    UPDATE projection_pending_approvals
    SET
      status = 'resolved',
      decision = (
        SELECT latest_resolutions.decision
        FROM latest_resolutions
        WHERE latest_resolutions.request_id = projection_pending_approvals.request_id
      ),
      resolved_at = (
        SELECT latest_resolutions.resolved_at
        FROM latest_resolutions
        WHERE latest_resolutions.request_id = projection_pending_approvals.request_id
      )
    WHERE EXISTS (
      SELECT 1
      FROM latest_resolutions
      WHERE latest_resolutions.request_id = projection_pending_approvals.request_id
    )
  `;

  yield* sql`
    WITH latest_response_events AS (
      SELECT
        response.request_id,
        response.resolved_at,
        response.decision
      FROM (
        SELECT
          json_extract(payload_json, '$.requestId') AS request_id,
          occurred_at AS resolved_at,
          CASE
            WHEN json_extract(payload_json, '$.decision') IN (
              'accept',
              'acceptForSession',
              'decline',
              'cancel'
            )
            THEN json_extract(payload_json, '$.decision')
            ELSE NULL
          END AS decision,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(payload_json, '$.requestId')
            ORDER BY occurred_at DESC, sequence DESC
          ) AS row_number
        FROM orchestration_events
        WHERE event_type = 'thread.approval-response-requested'
          AND json_extract(payload_json, '$.requestId') IS NOT NULL
      ) AS response
      WHERE response.row_number = 1
    )
    UPDATE projection_pending_approvals
    SET
      status = 'resolved',
      decision = (
        SELECT latest_response_events.decision
        FROM latest_response_events
        WHERE latest_response_events.request_id = projection_pending_approvals.request_id
      ),
      resolved_at = (
        SELECT latest_response_events.resolved_at
        FROM latest_response_events
        WHERE latest_response_events.request_id = projection_pending_approvals.request_id
      )
    WHERE EXISTS (
      SELECT 1
      FROM latest_response_events
      WHERE latest_response_events.request_id = projection_pending_approvals.request_id
    )
  `;

  yield* sql`
    WITH latest_stale_failures AS (
      SELECT
        failure.request_id,
        failure.resolved_at
      FROM (
        SELECT
          json_extract(payload_json, '$.requestId') AS request_id,
          created_at AS resolved_at,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(payload_json, '$.requestId')
            ORDER BY created_at DESC, activity_id DESC
          ) AS row_number
        FROM projection_thread_activities
        WHERE kind = 'provider.approval.respond.failed'
          AND json_extract(payload_json, '$.requestId') IS NOT NULL
          AND (
            lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
              LIKE '%stale pending approval request%'
            OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
              LIKE '%unknown pending approval request%'
            OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
              LIKE '%unknown pending permission request%'
          )
      ) AS failure
      WHERE failure.row_number = 1
    )
    UPDATE projection_pending_approvals
    SET
      status = 'resolved',
      decision = NULL,
      resolved_at = (
        SELECT latest_stale_failures.resolved_at
        FROM latest_stale_failures
        WHERE latest_stale_failures.request_id = projection_pending_approvals.request_id
      )
    WHERE status = 'pending'
      AND EXISTS (
        SELECT 1
        FROM latest_stale_failures
        WHERE latest_stale_failures.request_id = projection_pending_approvals.request_id
      )
  `;
});

export const refreshProjectionThreadPendingApprovalCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET pending_approval_count = COALESCE((
      SELECT COUNT(*)
      FROM projection_pending_approvals
      WHERE projection_pending_approvals.thread_id = projection_threads.thread_id
        AND projection_pending_approvals.status = 'pending'
    ), 0)
  `;
});
