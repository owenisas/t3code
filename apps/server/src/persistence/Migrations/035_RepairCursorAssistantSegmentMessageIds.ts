import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM projection_thread_messages
    WHERE role = 'assistant'
      AND message_id LIKE 'assistant:assistant:%segment:%'
      AND message_id NOT LIKE '%:turn:%'
  `;

  yield* sql`
    CREATE TEMP TABLE IF NOT EXISTS tmp_cursor_assistant_message_events AS
    SELECT
      sequence,
      json_extract(payload_json, '$.messageId') AS old_message_id,
      json_extract(payload_json, '$.threadId') AS thread_id,
      json_extract(payload_json, '$.turnId') AS turn_id,
      json_extract(payload_json, '$.text') AS text,
      CASE json_extract(payload_json, '$.streaming') WHEN 1 THEN 1 ELSE 0 END AS is_streaming,
      COALESCE(json_extract(payload_json, '$.createdAt'), occurred_at) AS created_at,
      COALESCE(json_extract(payload_json, '$.updatedAt'), occurred_at) AS updated_at,
      json_extract(payload_json, '$.attachments') AS attachments_json,
      COALESCE(json_extract(payload_json, '$.origin'), 'human') AS origin
    FROM orchestration_events
    WHERE event_type = 'thread.message-sent'
      AND json_extract(payload_json, '$.role') = 'assistant'
      AND json_extract(payload_json, '$.messageId') LIKE 'assistant:assistant:%segment:%'
      AND json_extract(payload_json, '$.messageId') NOT LIKE '%:turn:%'
      AND json_extract(payload_json, '$.turnId') IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_tmp_cursor_assistant_message_events_group
    ON tmp_cursor_assistant_message_events(old_message_id, thread_id, turn_id, sequence)
  `;

  yield* sql`
    INSERT OR REPLACE INTO projection_thread_messages (
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
    SELECT
      grouped.old_message_id || ':turn:' || grouped.turn_id AS message_id,
      grouped.thread_id,
      grouped.turn_id,
      'assistant' AS role,
      latest.text,
      grouped.is_streaming,
      grouped.created_at,
      grouped.updated_at,
      grouped.attachments_json,
      grouped.origin
    FROM (
      SELECT
        old_message_id,
        thread_id,
        turn_id,
        MIN(created_at) AS created_at,
        MAX(updated_at) AS updated_at,
        CASE WHEN SUM(CASE WHEN is_streaming = 0 THEN 1 ELSE 0 END) > 0 THEN 0 ELSE 1 END AS is_streaming,
        MAX(attachments_json) AS attachments_json,
        MAX(origin) AS origin,
        MAX(CASE WHEN length(text) > 0 THEN sequence ELSE NULL END) AS latest_text_sequence
      FROM tmp_cursor_assistant_message_events
      GROUP BY old_message_id, thread_id, turn_id
    ) grouped
    JOIN tmp_cursor_assistant_message_events latest
      ON latest.sequence = grouped.latest_text_sequence
    WHERE grouped.latest_text_sequence IS NOT NULL
  `;

  yield* sql`
    UPDATE projection_turns
    SET assistant_message_id = assistant_message_id || ':turn:' || turn_id
    WHERE assistant_message_id LIKE 'assistant:assistant:%segment:%'
      AND assistant_message_id NOT LIKE '%:turn:%'
      AND turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM projection_thread_messages message
        WHERE message.message_id = projection_turns.assistant_message_id || ':turn:' || projection_turns.turn_id
      )
  `;

  yield* sql`
    DROP TABLE IF EXISTS tmp_cursor_assistant_message_events
  `;
});
