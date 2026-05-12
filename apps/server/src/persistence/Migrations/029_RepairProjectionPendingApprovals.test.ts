// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("030_RepairProjectionPendingApprovals", (it) => {
  it.effect("removes user-input rows from pending approvals and refreshes thread counts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 29 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES
          (
            'thread-user-input',
            'project-1',
            'Thread user input',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'approval-required',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:00:00.000Z',
            '2026-02-24T00:00:00.000Z',
            NULL,
            NULL,
            1,
            1,
            0,
            NULL
          ),
          (
            'thread-approval',
            'project-1',
            'Thread approval',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'approval-required',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:00:00.000Z',
            '2026-02-24T00:00:00.000Z',
            NULL,
            NULL,
            1,
            0,
            0,
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-user-input-requested',
            'thread-user-input',
            NULL,
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"user-input-request-1"}',
            NULL,
            '2026-02-24T00:01:00.000Z'
          ),
          (
            'activity-user-input-resolved',
            'thread-user-input',
            NULL,
            'info',
            'user-input.resolved',
            'User input submitted',
            '{"requestId":"user-input-request-1"}',
            NULL,
            '2026-02-24T00:02:00.000Z'
          ),
          (
            'activity-approval-requested',
            'thread-approval',
            NULL,
            'approval',
            'approval.requested',
            'Command approval requested',
            '{"requestId":"approval-request-1","requestKind":"command"}',
            NULL,
            '2026-02-24T00:03:00.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at
        )
        VALUES
          (
            'user-input-request-1',
            'thread-user-input',
            NULL,
            'pending',
            NULL,
            '2026-02-24T00:01:00.000Z',
            NULL
          ),
          (
            'approval-request-1',
            'thread-approval',
            NULL,
            'pending',
            NULL,
            '2026-02-24T00:03:00.000Z',
            NULL
          )
      `;

      yield* runMigrations();

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly threadId: string;
        readonly status: string;
      }>`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          status
        FROM projection_pending_approvals
        ORDER BY request_id
      `;
      assert.deepStrictEqual(approvalRows, [
        {
          requestId: "approval-request-1",
          threadId: "thread-approval",
          status: "pending",
        },
      ]);

      const threadRows = yield* sql<{
        readonly threadId: string;
        readonly pendingApprovalCount: number;
      }>`
        SELECT
          thread_id AS "threadId",
          pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id IN ('thread-user-input', 'thread-approval')
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(threadRows, [
        {
          threadId: "thread-approval",
          pendingApprovalCount: 1,
        },
        {
          threadId: "thread-user-input",
          pendingApprovalCount: 0,
        },
      ]);
    }),
  );
});
