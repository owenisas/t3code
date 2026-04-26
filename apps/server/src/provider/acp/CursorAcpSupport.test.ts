import { Effect } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vitest";

import { applyCursorAcpModelSelection, buildCursorAcpSpawnInput } from "./CursorAcpSupport.ts";

const parameterizedGpt54ConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.4",
    options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select",
    currentValue: "272k",
    options: [
      { value: "272k", name: "272K" },
      { value: "1m", name: "1M" },
    ],
  },
  {
    id: "fast",
    name: "Fast",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  },
];

describe("buildCursorAcpSpawnInput", () => {
  it("builds the default Cursor ACP command", () => {
    expect(buildCursorAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "agent",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("includes the configured api endpoint when present", () => {
    expect(
      buildCursorAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/agent",
          apiEndpoint: "http://localhost:3000",
        },
        "/tmp/project",
      ),
    ).toEqual({
      command: "/usr/local/bin/agent",
      args: ["-e", "http://localhost:3000", "acp"],
      cwd: "/tmp/project",
    });
  });

  it("passes a Cursor CLI launch model override before acp", () => {
    expect(
      buildCursorAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/agent",
          apiEndpoint: "http://localhost:3000",
        },
        "/tmp/project",
        "gpt-5.3-codex-spark-preview",
      ),
    ).toEqual({
      command: "/usr/local/bin/agent",
      args: ["-e", "http://localhost:3000", "--model", "gpt-5.3-codex-spark-preview", "acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("applyCursorAcpModelSelection", () => {
  it("sets the base model before applying separate config options", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed(parameterizedGpt54ConfigOptions),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.4-medium-fast[reasoning=medium,context=272k]",
        selections: [
          { id: "reasoning", value: "xhigh" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
        mapError: ({ step, configId, cause }) =>
          new Error(
            step === "set-config-option"
              ? `failed to set config option ${configId}: ${cause.message}`
              : `failed to set model: ${cause.message}`,
          ),
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "gpt-5.4" },
      { type: "config", configId: "reasoning", value: "extra-high" },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });

  it("normalizes legacy Cursor auto and launch-style model ids before setModel", async () => {
    const calls: Array<{ readonly type: "model"; readonly value: string }> = [];

    const runtime = {
      getConfigOptions: Effect.succeed([] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: () => Effect.void,
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "auto",
        selections: undefined,
        mapError: ({ step, cause }) => new Error(`${step}: ${cause.message}`),
      }),
    );
    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "claude-opus-4-7-thinking-high",
        selections: undefined,
        mapError: ({ step, cause }) => new Error(`${step}: ${cause.message}`),
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "default" },
      { type: "model", value: "claude-opus-4-7" },
    ]);
  });

  it("allows launch-only Cursor aliases when ACP already reports the alias as current", async () => {
    const calls: Array<{ readonly type: "model"; readonly value: string }> = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.3-codex-spark",
          options: [
            { value: "composer-2", name: "Composer 2" },
            { value: "gpt-5.3-codex-spark", name: "Codex 5.3 Spark" },
          ],
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: () => Effect.void,
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.3-codex-spark",
        selections: undefined,
        mapError: ({ step, cause }) => new Error(`${step}: ${cause.message}`),
      }),
    );

    expect(calls).toEqual([{ type: "model", value: "gpt-5.3-codex-spark" }]);
  });

  it("rejects switching to launch-only Cursor aliases in an existing ACP session", async () => {
    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "composer-2",
          options: [
            { value: "composer-2", name: "Composer 2" },
            { value: "gpt-5.3-codex-spark", name: "Codex 5.3 Spark" },
          ],
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setModel: () => Effect.void,
      setConfigOption: () => Effect.void,
    };

    await expect(
      Effect.runPromise(
        applyCursorAcpModelSelection({
          runtime,
          model: "gpt-5.3-codex-spark",
          selections: undefined,
          mapError: ({ step, cause }) => new Error(`${step}: ${cause.message}`),
        }),
      ),
    ).rejects.toThrow("must be selected when the ACP process starts");
  });
});
