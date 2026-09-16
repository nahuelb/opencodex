import { expect, test } from "bun:test";
import { deriveEntry, mergeCatalogEntriesForSync } from "../../src/codex/catalog/sync";
import { applyProviderConfigHints } from "../../src/codex/catalog";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { OPENCODE_ZEN_MUSE_MODELS } from "../../src/providers/registry/model-seeds";

for (const provider of ["opencode-zen", "opencode-free", "opencode-go"]) {
  const models = provider === "opencode-go"
    ? ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor"] : OPENCODE_ZEN_MUSE_MODELS;
  for (const id of models) {
    test(`${provider}/${id} preserves the registry ladder through catalog sync`, () => {
      const config = providerConfigSeed(getProviderRegistryEntry(provider)!);
      const model = applyProviderConfigHints(provider, config, { provider, id });
      const efforts = ["minimal", "low", "medium", "high", "xhigh"];
      for (const template of [null, { slug: "gpt-6-astra", supported_reasoning_levels: [{ effort: "ultra" }] }]) {
        const muse = deriveEntry(template, `${provider}/${id}`, "Muse", 1, model);
        expect(muse.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual(efforts);
        expect(muse.default_reasoning_level).toBe("medium");
        for (const [disk, fresh] of [[[muse], []], [[], [muse]]]) {
          const entries = mergeCatalogEntriesForSync(disk, fresh, new Map(), [], false);
          const entry = entries.find(e => e.slug === muse.slug)!;
          expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual(efforts);
          expect(entry.default_reasoning_level).toBe("medium");
        }
      }
    });
  }
}

for (const template of [null, { slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "ultra" }] }]) {
  test(`Go preserves exact configured efforts (${template ? "template" : "fallback"})`, () => {
    for (const [id, efforts] of [
      ["glm-5.3", ["high", "max"]],
      ["glm-5.3-flash", ["high", "max"]],
      ["omen-alpha", ["high", "max"]],
      ["deepseek-v4-flash-vision-exp", ["high", "max"]],
      ["muse-spark-1.3-contributor", ["high", "xhigh"]],
    ] as const) {
      const entry = deriveEntry(template, `opencode-go/${id}`, "Go", 1, {
        provider: "opencode-go", id, reasoningEfforts: [...efforts], defaultReasoningEffort: efforts[1],
      });
      expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual([...efforts]);
      expect(entry.default_reasoning_level).toBe(efforts[1]);
    }
  });
}

for (const provider of ["other", "opencode-zen", "opencode-free"]) {
  test(`${provider} retains virtual tiers outside Zen Muse`, () => {
    const entry = deriveEntry(null, `${provider}/model`, "Other", 1, {
      provider, id: "model", reasoningEfforts: ["high"],
    });
    expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual(["high", "max", "ultra"]);
  });
}

test("Muse sync respects alias provenance and legacy rows without provenance", () => {
  const provider = "opencode-zen";
  const id = "muse-spark-1.3-contributor-free";
  const model = applyProviderConfigHints(provider, providerConfigSeed(getProviderRegistryEntry(provider)!), { provider, id });
  const alias = deriveEntry(null, `${provider}/my-muse`, "Muse", 1, model);
  const legacy = deriveEntry(null, `${provider}/${id}`, "Muse", 1, model);
  delete legacy.opencodex_capability_provenance;
  const entries = mergeCatalogEntriesForSync([alias, legacy], [], new Map(), [], false);
  for (const slug of [alias.slug, legacy.slug]) {
    expect(entries.find(entry => entry.slug === slug)?.supported_reasoning_levels.map((level: { effort: string }) => level.effort))
      .toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  }
});

test("sync does not reintroduce max for Muse", () => {
  const muse = deriveEntry(null, "opencode-go/muse-spark-1.3-contributor", "Muse", 1, {
    provider: "opencode-go", id: "muse-spark-1.3-contributor",
    reasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "xhigh",
  });
  for (const [disk, fresh] of [[[muse], []], [[], [muse]]]) {
    const entries = mergeCatalogEntriesForSync(disk, fresh, new Map(), [], false);
    const entry = entries.find(e => e.slug === muse.slug)!;
    expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual(["high", "xhigh"]);
  }
});
