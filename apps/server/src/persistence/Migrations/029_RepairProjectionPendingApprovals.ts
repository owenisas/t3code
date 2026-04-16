import * as Effect from "effect/Effect";

import {
  rebuildProjectionPendingApprovals,
  refreshProjectionThreadPendingApprovalCounts,
} from "./helpers/pendingApprovals.ts";

export default Effect.gen(function* () {
  yield* rebuildProjectionPendingApprovals;
  yield* refreshProjectionThreadPendingApprovalCounts;
});
