import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!threadColumns.some((column) => column.name === "yolo_run_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN yolo_run_json TEXT
    `;
  }

  if (!messageColumns.some((column) => column.name === "origin")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN origin TEXT NOT NULL DEFAULT 'human'
    `;
  }
});
