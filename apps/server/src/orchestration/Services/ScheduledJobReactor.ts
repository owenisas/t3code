import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface ScheduledJobReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ScheduledJobReactor extends Context.Service<
  ScheduledJobReactor,
  ScheduledJobReactorShape
>()("t3/orchestration/Services/ScheduledJobReactor") {}
