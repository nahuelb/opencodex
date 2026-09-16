/**
 * OpenCode Go Muse Spark 1.2 Contributor context window regression.
 *
 * Muse Spark serves a 1,048,576-token (1M) context window over /responses on Zen Go,
 * matching its 1.1 sibling. The registry declared no modelContextWindows entry, so the
 * catalog fell back to the 128k unknown-window default and the Codex app capped real
 * usable context well below what the model supports. These tests lock the declaration
 * in and prove the catalog advertises the full 1M window for Muse.
 */
import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints } from "../../src/codex/catalog";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../../src/providers/registry";
import { providerConfigSeed } from "../../src/providers/derive";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { OPENCODE_ZEN_MUSE_MODELS } from "../../src/providers/registry/model-seeds";
import { mapRoutedResponsesReasoningEffort } from "../../src/adapters/openai-responses/reasoning";
import { routeModel } from "../../src/router";

for (const provider of ["opencode-zen", "opencode-free", "opencode-go"]) {
  const models = provider === "opencode-go"
    ? ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor"] : OPENCODE_ZEN_MUSE_MODELS;
  for (const model of models) {
    test(`${provider}/${model} declares exact Muse efforts with identity wire values`, () => {
      const entry = getProviderRegistryEntry(provider)!;
      const config = providerConfigSeed(entry);
      const efforts = ["minimal", "low", "medium", "high", "xhigh"];
      expect(entry.modelReasoningEfforts?.[model]).toEqual(efforts);
      expect(config.modelReasoningEfforts?.[model]).toEqual(efforts);
      expect(config.modelReasoningEffortMap?.[model]).toEqual(Object.fromEntries(efforts.map(effort => [effort, effort])));
      expect(config.modelDefaultReasoningEfforts?.[model]).toBeUndefined();
      for (const effort of efforts) {
        const body = { model, reasoning: { effort } };
        expect(mapRoutedResponsesReasoningEffort(body, config, model)).toEqual(body);
      }
      for (const effort of ["max", "ultra"]) {
        expect(mapRoutedResponsesReasoningEffort({ model, reasoning: { effort } }, config, model))
          .toEqual({ model, reasoning: { effort: "xhigh" } });
      }
      delete config.modelReasoningEfforts?.[model];
      delete config.modelReasoningEffortMap?.[model];
      const route = routeModel({ providers: { [provider]: config } } as OcxConfig, `${provider}/${model}`);
      expect(route.provider.modelReasoningEfforts?.[model]).toEqual(efforts);
      expect(mapRoutedResponsesReasoningEffort({ model, reasoning: { effort: "minimal" } }, route.provider, model))
        .toEqual({ model, reasoning: { effort: "minimal" } });
    });
  }
}

const MUSE_MODEL = "muse-spark-1.2-contributor";
const MUSE_13_MODEL = "muse-spark-1.3-contributor";
const MUSE_CONTEXT = 1_048_576;

/** Seeded OpenCode Go provider config for the Muse Spark context assertions. */
function opencodeGo(): OcxProviderConfig {
  const entry = getProviderRegistryEntry("opencode-go");
  if (!entry) throw new Error("missing opencode-go registry fixture");
  return { ...providerConfigSeed(entry), apiKey: "test-key" };
}

describe("OpenCode Go Muse Spark context window", () => {
  test("registry declares the 1M context window for Muse", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-go");
    expect(entry?.modelContextWindows?.[MUSE_MODEL]).toBe(MUSE_CONTEXT);
  });

  test("the registry seed carries the 1M context window for Muse", () => {
    const prov = opencodeGo();
    expect(prov.modelContextWindows?.[MUSE_MODEL]).toBe(MUSE_CONTEXT);
  });

  test("applyProviderConfigHints exposes the 1M context window for Muse", () => {
    const prov = opencodeGo();
    const hinted = applyProviderConfigHints("opencode-go", prov, {
      id: MUSE_MODEL,
      provider: "opencode-go",
    });
    expect(hinted.contextWindow).toBe(MUSE_CONTEXT);
  });

  test("a discovered row with no window inherits the configured 1M window", () => {
    const prov = opencodeGo();
    const hinted = applyProviderConfigHints("opencode-go", prov, {
      id: MUSE_MODEL,
      provider: "opencode-go",
    });
    expect(hinted.contextWindow).toBe(MUSE_CONTEXT);
  });

  // 1.3 is the same-shaped successor on the same Zen Go roster. Without its own
  // entry it would fall back to the 128k unknown-window default — the same
  // regression these tests exist to prevent for 1.2.
  test("Muse Spark 1.3 Contributor declares and exposes the same 1M window", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-go");
    expect(entry?.modelContextWindows?.[MUSE_13_MODEL]).toBe(MUSE_CONTEXT);
    const prov = opencodeGo();
    expect(prov.modelContextWindows?.[MUSE_13_MODEL]).toBe(MUSE_CONTEXT);
    const hinted = applyProviderConfigHints("opencode-go", prov, {
      id: MUSE_13_MODEL,
      provider: "opencode-go",
    });
    expect(hinted.contextWindow).toBe(MUSE_CONTEXT);
  });
});
