import { describe, expect, test } from "bun:test";
import { projectStaleContextWindows, STALE_CONTEXT_WINDOWS } from "../../src/providers/stale-context-window-migration";
import type { OcxConfig } from "../../src/types";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { runModelRenameStartupMigration } from "../../src/providers/model-rename-startup";
import { buildCatalogEntries } from "../../src/codex/catalog/build-entries";

function devinConfig(windows: Record<string, number>, adapter = "devin"): OcxConfig {
  return {
    providers: {
      devin: { adapter, baseUrl: "https://server.codeium.com", modelContextWindows: { ...windows } },
    },
  } as unknown as OcxConfig;
}

describe("stale context window migration", () => {
  test("startup repair publishes the corrected Codex context and compaction threshold", () => {
    const config = {
      providers: {
        cursor: { adapter: "cursor", modelContextWindows: { "grok-4.6": 500_000 } },
      },
    } as unknown as OcxConfig;
    let saved: OcxConfig | undefined;
    runModelRenameStartupMigration(config, {
      project: projectStaleContextWindows,
      save: value => { saved = value; },
    });
    expect(saved?.providers!.cursor!.modelContextWindows!["grok-4.6"]).toBe(256_000);
    const entries = buildCatalogEntries(null, [], [{
      provider: "cursor",
      id: "grok-4.6",
      contextWindow: config.providers!.cursor!.modelContextWindows!["grok-4.6"],
    }]);
    expect(entries.find(entry => entry.slug === "cursor/grok-4.6")).toMatchObject({
      context_window: 256_000,
      max_context_window: 256_000,
      auto_compact_token_limit: 230_400,
    });
  });

  test("repairs Cursor Grok defaults and preserves custom windows and other providers", () => {
    const config = {
      providers: {
        cursor: {
          adapter: "cursor",
          modelContextWindows: {
            "grok-4.5": 500_000,
            "grok-4.5-fast": 500_000,
            "grok-4.6": 500_000,
            "grok-4.6-fast": 500_000,
            "gpt-5.5": 500_000,
          },
        },
        xai: { adapter: "openai-chat", modelContextWindows: { "grok-4.6": 500_000 } },
      },
    } as unknown as OcxConfig;
    expect(projectStaleContextWindows(config).changed).toBe(true);
    expect(config.providers!.cursor!.modelContextWindows).toEqual({
      "grok-4.5": 256_000,
      "grok-4.5-fast": 256_000,
      "grok-4.6": 256_000,
      "grok-4.6-fast": 256_000,
      "gpt-5.5": 500_000,
    });
    expect(config.providers!.xai!.modelContextWindows!["grok-4.6"]).toBe(500_000);
    expect(projectStaleContextWindows(config).changed).toBe(false);
    config.providers!.cursor!.modelContextWindows!["grok-4.6"] = 200_000;
    expect(projectStaleContextWindows(config).changed).toBe(false);
    expect(config.providers!.cursor!.modelContextWindows!["grok-4.6"]).toBe(200_000);
    config.providers!.cursor!.modelContextWindows!["grok-4.6"] = 500_000;
    config.providers!.cursor!.adapter = "openai-chat";
    expect(projectStaleContextWindows(config).changed).toBe(false);
    expect(config.providers!.cursor!.modelContextWindows!["grok-4.6"]).toBe(500_000);
  });

  test("repairs a window the config inherited from the wrong registry seed", () => {
    // `enrichProviderFromRegistry` is fill-only, so a config saved while the
    // registry shipped 256k for Grok keeps reporting 256k forever. Correcting
    // the registry fixes new installs only; this is what reaches the old ones.
    const config = devinConfig({ "grok-4-5": 256_000, "claude-sonnet-5": 200_000 });
    const projection = projectStaleContextWindows(config);
    expect(projection.changed).toBe(true);
    expect(projection.config.providers!.devin!.modelContextWindows).toMatchObject({
      "grok-4-5": 500_000,
      "claude-sonnet-5": 1_000_000,
    });
    expect(projection.warnings.join(" ")).toContain("grok-4-5 256000 -> 500000");
  });

  test("leaves a value the user chose alone", () => {
    // The guard is an exact match on the wrong number. Anything else is a
    // deliberate override and outranks this migration.
    const config = devinConfig({ "grok-4-5": 300_000 });
    const projection = projectStaleContextWindows(config);
    expect(projection.changed).toBe(false);
    expect(projection.config.providers!.devin!.modelContextWindows!["grok-4-5"]).toBe(300_000);
  });

  test("skips a row that no longer carries the registry adapter", () => {
    // A `devin` row retargeted at another transport is not the provider these
    // numbers describe, so rewriting its windows would be a guess.
    const projection = projectStaleContextWindows(devinConfig({ "grok-4-5": 256_000 }, "openai-chat"));
    expect(projection.changed).toBe(false);
  });

  test("is a no-op on a config with no such provider", () => {
    const projection = projectStaleContextWindows({ providers: {} } as unknown as OcxConfig);
    expect(projection.changed).toBe(false);
    expect(projection.warnings).toEqual([]);
  });

  test("every entry names a real correction", () => {
    for (const entry of STALE_CONTEXT_WINDOWS) {
      expect(entry.from).not.toBe(entry.to);
      expect(PROVIDER_REGISTRY.some(provider => provider.id === entry.provider)).toBe(true);
    }
  });
});
