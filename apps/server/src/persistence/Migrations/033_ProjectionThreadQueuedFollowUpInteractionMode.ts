import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_queued_follow_ups)
  `;

  if (!columns.some((column) => column.name === "interaction_mode")) {
    yield* sql`
      ALTER TABLE projection_thread_queued_follow_ups
      ADD COLUMN interaction_mode TEXT
    `;
  }
});
