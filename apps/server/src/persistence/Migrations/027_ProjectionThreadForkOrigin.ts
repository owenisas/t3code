import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!threadColumns.some((column) => column.name === "fork_source_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_source_thread_id TEXT
    `;
  }

  if (!threadColumns.some((column) => column.name === "fork_source_message_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_source_message_id TEXT
    `;
  }

  if (!threadColumns.some((column) => column.name === "fork_context_hydrated_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_context_hydrated_at TEXT
    `;
  }
});
