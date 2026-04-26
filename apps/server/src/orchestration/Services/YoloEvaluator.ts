import { Context, Effect } from "effect";
import type { ModelSelection, TextGenerationError } from "@t3tools/contracts";

export interface YoloEvaluatorInput {
  readonly cwd: string;
  readonly goal: string;
  readonly transcript: string;
  readonly latestAssistantText: string;
  readonly checkpointSummary: string;
  readonly iteration: number;
  readonly maxIterations: number | null;
  readonly modelSelection: ModelSelection;
}

export interface YoloEvaluatorResult {
  readonly goalReached: boolean;
  readonly confidence: number;
  readonly missing: ReadonlyArray<string>;
  readonly nextPrompt: string;
  readonly reviewNote: string;
}

export interface YoloEvaluatorShape {
  readonly evaluate: (
    input: YoloEvaluatorInput,
  ) => Effect.Effect<YoloEvaluatorResult, TextGenerationError>;
}

export class YoloEvaluator extends Context.Service<YoloEvaluator, YoloEvaluatorShape>()(
  "t3/orchestration/Services/YoloEvaluator",
) {}
