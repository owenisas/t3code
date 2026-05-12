// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_RepairCursorAssistantSegmentMessageIds", (it) => {
  it.effect("reconstructs turn-scoped Cursor assistant messages from reused ACP segment ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at,
          attachments_json,
          origin
        )
        VALUES (
          'assistant:assistant:session-1:segment:0',
          'thread-1',
          'turn-1',
          'assistant',
          'second answer incorrectly overwrote first row',
          0,
          '2026-05-02T00:00:01.000Z',
          '2026-05-02T00:05:03.000Z',
          NULL,
          'assistant'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-1',
            NULL,
            'assistant:assistant:session-1:segment:0',
            'completed',
            '2026-05-02T00:00:00.000Z',
            '2026-05-02T00:00:00.000Z',
            '2026-05-02T00:00:03.000Z',
            '[]'
          ),
          (
            'thread-1',
            'turn-2',
            NULL,
            'assistant:assistant:session-1:segment:0',
            'completed',
            '2026-05-02T00:05:00.000Z',
            '2026-05-02T00:05:00.000Z',
            '2026-05-02T00:05:03.000Z',
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'event-turn-1-assistant-stream',
            'thread',
            'thread-1',
            1,
            'thread.message-sent',
            '2026-05-02T00:00:02.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"threadId":"thread-1","messageId":"assistant:assistant:session-1:segment:0","role":"assistant","text":"first answer","turnId":"turn-1","streaming":true,"createdAt":"2026-05-02T00:00:02.000Z","updatedAt":"2026-05-02T00:00:02.000Z"}',
            '{}'
          ),
          (
            'event-turn-1-assistant-final',
            'thread',
            'thread-1',
            2,
            'thread.message-sent',
            '2026-05-02T00:00:03.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"threadId":"thread-1","messageId":"assistant:assistant:session-1:segment:0","role":"assistant","text":"","turnId":"turn-1","streaming":false,"createdAt":"2026-05-02T00:00:02.000Z","updatedAt":"2026-05-02T00:00:03.000Z"}',
            '{}'
          ),
          (
            'event-turn-2-assistant-stream',
            'thread',
            'thread-1',
            3,
            'thread.message-sent',
            '2026-05-02T00:05:02.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"threadId":"thread-1","messageId":"assistant:assistant:session-1:segment:0","role":"assistant","text":"second answer","turnId":"turn-2","streaming":true,"createdAt":"2026-05-02T00:05:02.000Z","updatedAt":"2026-05-02T00:05:02.000Z"}',
            '{}'
          ),
          (
            'event-turn-2-assistant-final',
            'thread',
            'thread-1',
            4,
            'thread.message-sent',
            '2026-05-02T00:05:03.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"threadId":"thread-1","messageId":"assistant:assistant:session-1:segment:0","role":"assistant","text":"","turnId":"turn-2","streaming":false,"createdAt":"2026-05-02T00:05:02.000Z","updatedAt":"2026-05-02T00:05:03.000Z"}',
            '{}'
          )
      `;

      yield* runMigrations();

      const messages = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly text: string;
        readonly isStreaming: number;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE thread_id = 'thread-1'
        ORDER BY turn_id
      `;

      assert.deepStrictEqual(messages, [
        {
          messageId: "assistant:assistant:session-1:segment:0:turn:turn-1",
          turnId: "turn-1",
          text: "first answer",
          isStreaming: 0,
        },
        {
          messageId: "assistant:assistant:session-1:segment:0:turn:turn-2",
          turnId: "turn-2",
          text: "second answer",
          isStreaming: 0,
        },
      ]);

      const turns = yield* sql<{
        readonly turnId: string;
        readonly assistantMessageId: string | null;
      }>`
        SELECT
          turn_id AS "turnId",
          assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        WHERE thread_id = 'thread-1'
        ORDER BY turn_id
      `;

      assert.deepStrictEqual(turns, [
        {
          turnId: "turn-1",
          assistantMessageId: "assistant:assistant:session-1:segment:0:turn:turn-1",
        },
        {
          turnId: "turn-2",
          assistantMessageId: "assistant:assistant:session-1:segment:0:turn:turn-2",
        },
      ]);
    }),
  );
});
