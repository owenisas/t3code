import * as Effect from "effect/Effect";

import {
  backfillProjectionThreadShellSummary,
  ensureProjectionThreadShellSummaryColumns,
} from "./helpers/threadShellSummary.ts";

export default Effect.gen(function* () {
  yield* ensureProjectionThreadShellSummaryColumns;
  yield* backfillProjectionThreadShellSummary;
});
