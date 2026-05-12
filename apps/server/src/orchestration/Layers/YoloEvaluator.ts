// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import { Effect, Layer } from "effect";

import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { YoloEvaluator, type YoloEvaluatorShape } from "../Services/YoloEvaluator.ts";

const makeYoloEvaluator = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration;

  const evaluate: YoloEvaluatorShape["evaluate"] = Effect.fn("YoloEvaluator.evaluate")(
    function* (input) {
      return yield* textGeneration.generateYoloReview(input);
    },
  );

  return {
    evaluate,
  } satisfies YoloEvaluatorShape;
});

export const YoloEvaluatorLive = Layer.effect(YoloEvaluator, makeYoloEvaluator);
