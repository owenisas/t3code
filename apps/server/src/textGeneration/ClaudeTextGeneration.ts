/**
 * ClaudeTextGeneration – Text generation layer using the Claude CLI.
 *
 * Implements the same TextGenerationShape contract as CodexTextGeneration but
 * delegates to the `claude` CLI (`claude -p`) with structured JSON output
 * instead of the `codex exec` CLI.
 *
 * @module ClaudeTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type ClaudeSettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { TextGenerationError } from "@t3tools/contracts";
import { type TextGenerationShape, type YoloReviewGenerationResult } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildYoloReviewPrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  getClaudeModelCapabilities,
  isClaudeUltracodeEffort,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
} from "../provider/Layers/ClaudeProvider.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";

const CLAUDE_TIMEOUT_MS = 180_000;

/**
 * Schema for the wrapper JSON returned by `claude -p --output-format json`.
 * We only care about `structured_output`.
 */
const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});

const ClaudePlainOutputEnvelope = Schema.Struct({
  result: Schema.String,
});

function isClaudeStructuredOutputRetryFailure(error: TextGenerationError): boolean {
  return (
    error.detail.includes("error_max_structured_output_retries") ||
    error.detail.includes("Failed to provide valid structured output")
  );
}

function extractJsonObjectText(value: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
  const candidate = fenced?.[1]?.trim() ?? value.trim();
  const start = candidate.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parsePlainYoloReviewResult(
  result: string,
): Effect.Effect<YoloReviewGenerationResult, TextGenerationError> {
  const jsonText = extractJsonObjectText(result);
  if (!jsonText) {
    return Effect.fail(
      new TextGenerationError({
        operation: "generateYoloReview",
        detail: "Claude Goal fallback did not return a JSON object.",
      }),
    );
  }

  return decodeUnknownJsonString(jsonText).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: "generateYoloReview",
          detail: "Claude Goal fallback returned invalid JSON.",
          cause,
        }),
    ),
    Effect.flatMap(normalizeYoloReviewStructuredOutput),
  );
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "no") return false;
  return null;
}

function normalizeString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(normalizeString).filter(Boolean);
}

function normalizeYoloReviewStructuredOutput(
  raw: unknown,
): Effect.Effect<YoloReviewGenerationResult, TextGenerationError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Effect.fail(
      new TextGenerationError({
        operation: "generateYoloReview",
        detail: "Claude Goal review returned non-object structured output.",
      }),
    );
  }

  const record = raw as Record<string, unknown>;
  const goalReached = normalizeBoolean(record.goalReached);
  if (goalReached === null) {
    return Effect.fail(
      new TextGenerationError({
        operation: "generateYoloReview",
        detail: "Claude Goal review returned missing or invalid goalReached.",
      }),
    );
  }

  const confidenceValue =
    typeof record.confidence === "number"
      ? record.confidence
      : Number(normalizeString(record.confidence));
  const confidence = Number.isFinite(confidenceValue) ? confidenceValue : 0;

  return Effect.succeed({
    goalReached,
    confidence: Math.max(0, Math.min(100, Math.round(confidence))),
    missing: normalizeStringList(record.missing),
    nextPrompt: normalizeString(record.nextPrompt),
    reviewNote: normalizeString(record.reviewNote),
  });
}

const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);
const decodeUnknownJsonString = Schema.decodeEffect(Schema.UnknownFromJsonString);
const decodeClaudeOutputEnvelope = Schema.decodeEffect(Schema.fromJsonString(ClaudeOutputEnvelope));
const decodeClaudePlainOutputEnvelope = Schema.decodeEffect(
  Schema.fromJsonString(ClaudePlainOutputEnvelope),
);

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  const encodeJsonForOperation = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateYoloReview",
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  /**
   * Spawn the Claude CLI with structured JSON output and return the parsed,
   * schema-validated result.
   */
  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateYoloReview";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
      "Failed to encode structured output schema.",
    );
    const caps = getClaudeModelCapabilities(modelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: modelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(modelSelection, "effort");
    const resolvedEffort = resolveClaudeEffort(caps, rawEffortSelection);
    const cliEffort = normalizeClaudeCliEffort(resolvedEffort, modelSelection.model);
    const ultracode = isClaudeUltracodeEffort(resolvedEffort);
    const thinkingDescriptor = findDescriptor("thinking");
    const fastModeDescriptor = findDescriptor("fastMode");
    const thinking =
      thinkingDescriptor?.type === "boolean" ? thinkingDescriptor.currentValue : undefined;
    const fastMode =
      fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
    const settings = {
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
      ...(ultracode ? { ultracode: true } : {}),
    };
    const settingsJson =
      Object.keys(settings).length > 0
        ? yield* encodeJsonForOperation(
            operation,
            settings,
            "Failed to encode Claude CLI settings.",
          )
        : undefined;

    const safeReviewArgs =
      operation === "generateYoloReview"
        ? ([
            "--permission-mode",
            "plan",
            "--tools",
            "Read,Grep,Glob,LS,WebSearch,WebFetch",
            "--allowedTools",
            "Read,Grep,Glob,LS,WebSearch,WebFetch",
          ] as const)
        : [];
    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* () {
      const command = ChildProcess.make(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveClaudeApiModelId(modelSelection),
          ...(cliEffort ? ["--effort", cliEffort] : []),
          ...(settingsJson ? ["--settings", settingsJson] : []),
          ...safeReviewArgs,
          ...(operation === "generateYoloReview" ? [] : ["--dangerously-skip-permissions"]),
        ],
        {
          env: claudeEnvironment,
          cwd,
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.encodeText(Stream.make(prompt)),
          },
        },
      );

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runClaudeCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const envelope = yield* decodeClaudeOutputEnvelope(rawStdout).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude CLI returned unexpected output format.",
            cause,
          }),
        ),
      ),
    );

    if (operation === "generateYoloReview") {
      return envelope.structured_output as S["Type"];
    }

    return yield* Schema.decodeEffect(outputSchemaJson)(envelope.structured_output).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const runClaudePlainJson = Effect.fn("runClaudePlainJson")(function* ({
    operation,
    cwd,
    prompt,
    modelSelection,
  }: {
    operation: "generateYoloReview";
    cwd: string;
    prompt: string;
    modelSelection: ModelSelection;
  }) {
    const caps = getClaudeModelCapabilities(modelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: modelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(modelSelection, "effort");
    const resolvedEffort = resolveClaudeEffort(caps, rawEffortSelection);
    const cliEffort = normalizeClaudeCliEffort(resolvedEffort, modelSelection.model);
    const thinkingDescriptor = findDescriptor("thinking");
    const fastModeDescriptor = findDescriptor("fastMode");
    const thinking =
      thinkingDescriptor?.type === "boolean" ? thinkingDescriptor.currentValue : undefined;
    const fastMode =
      fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
    const settings = {
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
    };
    const settingsJson =
      Object.keys(settings).length > 0
        ? yield* encodeJsonForOperation(
            operation,
            settings,
            "Failed to encode Claude CLI settings.",
          )
        : undefined;
    const command = ChildProcess.make(
      claudeSettings.binaryPath || "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--model",
        resolveClaudeApiModelId(modelSelection),
        ...(cliEffort ? ["--effort", cliEffort] : []),
        ...(settingsJson ? ["--settings", settingsJson] : []),
        "--permission-mode",
        "plan",
        "--tools",
        "Read,Grep,Glob,LS,WebSearch,WebFetch",
        "--allowedTools",
        "Read,Grep,Glob,LS,WebSearch,WebFetch",
      ],
      {
        env: claudeEnvironment,
        cwd,
        shell: process.platform === "win32",
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      },
    );

    const stdout = yield* Effect.gen(function* () {
      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Claude CLI fallback command failed: ${detail}`
              : `Claude CLI fallback command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Claude CLI fallback request timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const envelope = yield* decodeClaudePlainOutputEnvelope(stdout).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude CLI fallback returned unexpected output format.",
            cause,
          }),
        ),
      ),
    );

    return yield* parsePlainYoloReviewResult(envelope.result);
  });

  // ---------------------------------------------------------------------------
  // TextGenerationShape methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "ClaudeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    const generated = yield* runClaudeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "ClaudeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const generated = yield* runClaudeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "ClaudeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runClaudeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "ClaudeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runClaudeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  const generateYoloReview: TextGenerationShape["generateYoloReview"] = Effect.fn(
    "ClaudeTextGeneration.generateYoloReview",
  )(function* (input) {
    const { prompt, outputSchema } = buildYoloReviewPrompt(input);
    const modelSelection = input.modelSelection;

    const generated = yield* runClaudeJson({
      operation: "generateYoloReview",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection,
    }).pipe(
      Effect.catch((error) => {
        if (!isClaudeStructuredOutputRetryFailure(error)) {
          return Effect.fail(error);
        }

        return runClaudePlainJson({
          operation: "generateYoloReview",
          cwd: input.cwd,
          prompt: [
            prompt,
            "",
            "Fallback output mode:",
            "Return ONLY one compact JSON object with keys goalReached, confidence, missing, nextPrompt, reviewNote.",
            "Do not wrap the JSON in markdown.",
          ].join("\n"),
          modelSelection,
        });
      }),
    );

    return yield* normalizeYoloReviewStructuredOutput(generated);
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateYoloReview,
  } satisfies TextGenerationShape;
});
