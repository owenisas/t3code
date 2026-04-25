import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface YoloReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class YoloReactor extends Context.Service<YoloReactor, YoloReactorShape>()(
  "t3/orchestration/Services/YoloReactor",
) {}
