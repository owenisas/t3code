import { describe, expect, it } from "vite-plus/test";

import {
  clearDiffSearchParams,
  clearSplitDiffSearchParams,
  clearSplitSearchParams,
  parseDiffRouteSearch,
  stripSplitDiffSearchParams,
  stripSplitSearchParams,
} from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("drops file value when turn is not selected", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("parses valid split pane search values", () => {
    const parsed = parseDiffRouteSearch({
      splitEnv: "env-1",
      splitThread: "thread-2",
      focusedPane: "secondary",
      splitDiff: "1",
      splitDiffTurnId: "turn-2",
      splitDiffFilePath: "src/secondary.ts",
    });

    expect(parsed).toEqual({
      splitEnv: "env-1",
      splitThread: "thread-2",
      focusedPane: "secondary",
      splitDiff: "1",
      splitDiffTurnId: "turn-2",
      splitDiffFilePath: "src/secondary.ts",
    });
  });

  it("drops split diff values without a valid secondary thread", () => {
    expect(
      parseDiffRouteSearch({
        focusedPane: "secondary",
        splitDiff: "1",
        splitDiffTurnId: "turn-2",
      }),
    ).toEqual({
      focusedPane: "secondary",
    });
  });

  it("removes split pane params without touching primary diff params", () => {
    expect(
      stripSplitSearchParams({
        diff: "1",
        splitEnv: "env-1",
        splitThread: "thread-2",
        focusedPane: "secondary",
        splitDiff: "1",
      }),
    ).toEqual({ diff: "1" });
  });

  it("clears retained primary diff params explicitly", () => {
    expect(
      clearDiffSearchParams({
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        splitEnv: "env-1",
      }),
    ).toEqual({
      diff: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
      splitEnv: "env-1",
    });
  });

  it("clears retained split pane params explicitly", () => {
    expect(
      clearSplitSearchParams({
        diff: "1",
        splitEnv: "env-1",
        splitThread: "thread-2",
        focusedPane: "secondary",
        splitDiff: "1",
        splitDiffTurnId: "turn-2",
        splitDiffFilePath: "src/secondary.ts",
      }),
    ).toEqual({
      diff: "1",
      splitEnv: undefined,
      splitThread: undefined,
      focusedPane: undefined,
      splitDiff: undefined,
      splitDiffTurnId: undefined,
      splitDiffFilePath: undefined,
    });
  });

  it("removes only secondary diff params", () => {
    expect(
      stripSplitDiffSearchParams({
        splitEnv: "env-1",
        splitThread: "thread-2",
        focusedPane: "secondary",
        splitDiff: "1",
        splitDiffTurnId: "turn-2",
      }),
    ).toEqual({
      splitEnv: "env-1",
      splitThread: "thread-2",
      focusedPane: "secondary",
    });
  });

  it("clears retained secondary diff params explicitly", () => {
    expect(
      clearSplitDiffSearchParams({
        splitEnv: "env-1",
        splitThread: "thread-2",
        focusedPane: "secondary",
        splitDiff: "1",
        splitDiffTurnId: "turn-2",
        splitDiffFilePath: "src/secondary.ts",
      }),
    ).toEqual({
      splitEnv: "env-1",
      splitThread: "thread-2",
      focusedPane: "secondary",
      splitDiff: undefined,
      splitDiffTurnId: undefined,
      splitDiffFilePath: undefined,
    });
  });
});
