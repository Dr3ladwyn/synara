import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { buildMuseSpawnInput, configureMuse, museModels } from "./MuseAcpSupport.ts";

describe("Muse ACP configuration", () => {
  it("applies effort on every turn and restores default after Plan", async () => {
    const calls: string[] = [];
    const runtime = {
      setModel: (model: string) =>
        Effect.sync(() => {
          calls.push(`model:${model}`);
        }),
      setMode: (mode: string) =>
        Effect.sync(() => {
          calls.push(`mode:${mode}`);
          return {};
        }),
      setConfigOption: (key: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push(`${key}:${value}`);
          return { configOptions: [] };
        }),
    };
    await Effect.runPromise(
      configureMuse(runtime, "muse-spark-1.3", { reasoningEffort: "max" }, true),
    );
    await Effect.runPromise(configureMuse(runtime, "default", undefined, false));
    expect(calls).toEqual([
      "model:muse-spark-1.3",
      "reasoning_effort:max",
      "mode:plan",
      "approval_mode:promptUnmatched",
      "auto_review:off",
      "reasoning_effort:default",
      "mode:default",
      "approval_mode:promptUnmatched",
      "auto_review:off",
    ]);
  });
  it("launches the bridge without Copilot flags and retains the approval boundary", () => {
    const spawn = buildMuseSpawnInput(
      { binaryPath: "/tools/muse-acp", environment: { MUSE_CLI: "/tools/muse" } },
      "/project",
    );
    expect(spawn.command).toBe("/tools/muse-acp");
    expect(spawn.args).toEqual([]);
    expect(spawn.providerEnvironment?.environment).toEqual({ MUSE_CLI: "/tools/muse" });
    expect(spawn.env).toEqual({
      MUSE_APPROVAL_MODE: "promptUnmatched",
      MUSE_ALLOW_UNSCOPED_READS: "false",
    });
  });

  it("does not claim the selected model's reasoning tiers apply to all models", () => {
    const result = museModels([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "muse-spark-1.3",
        options: [
          { value: "muse-spark-1.3", name: "Spark 1.3" },
          { value: "muse-spark-1.2", name: "Spark 1.2" },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Effort",
        type: "select",
        currentValue: "default",
        options: [
          { value: "default", name: "Muse default" },
          { value: "max", name: "Max" },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        slug: "muse-spark-1.3",
        name: "Spark 1.3",
        supportedReasoningEfforts: [
          { value: "default", label: "Muse default" },
          { value: "max", label: "Max" },
        ],
        defaultReasoningEffort: "default",
      },
      { slug: "muse-spark-1.2", name: "Spark 1.2" },
    ]);
  });
});
