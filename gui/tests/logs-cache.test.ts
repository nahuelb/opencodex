import { expect, test } from "bun:test";
import { cacheResult, summarizeCache, type CacheLogEntry } from "../src/pages/logs-cache";
import { filterLogs, DEFAULT_LOG_FILTER_STATE, hasActiveLogFilters } from "../src/pages/logs-filter";

const row = (read: number, input = 100): CacheLogEntry => ({ usageStatus: "reported", usage: { inputTokens: input, cacheReadInputTokens: read } });

test("reported reads classify partial hits, full hits, and explicit misses", () => {
  expect(cacheResult(row(75))).toMatchObject({ outcome: "hit", read: 75, ratio: 0.75, uncached: 25 });
  expect(cacheResult(row(100)).ratio).toBe(1);
  expect(cacheResult(row(0))).toMatchObject({ outcome: "miss", ratio: 0 });
});

test("unknown usage never becomes a miss", () => {
  for (const entry of [
    {}, { usage: { inputTokens: 100 } }, { ...row(0), usageStatus: "estimated" },
    { ...row(0), usageStatus: "unsupported" }, { ...row(0), usageStatus: "unreported" },
    { usage: { ...row(5).usage!, estimated: true } }, row(0, 0),
    row(NaN), row(Infinity), row(-1), row(101), row(1.5), row(10, NaN),
    { usage: { inputTokens: 100, cacheCreationInputTokens: 50 } },
    { usage: { inputTokens: 100, cacheReadInputTokens: 80, cacheCreationInputTokens: 30 } },
    { usage: { inputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: -1 } },
  ]) expect(cacheResult(entry).outcome).toBe("unknown");
});

test("legacy combined reads and writes are split; writes alone cannot imply a hit", () => {
  expect(cacheResult({ usage: { inputTokens: 100, cachedInputTokens: 60, cacheCreationInputTokens: 20 } }))
    .toMatchObject({ outcome: "hit", read: 40, write: 20, uncached: 60 });
  expect(cacheResult({ usage: { inputTokens: 100, cachedInputTokens: 20, cacheCreationInputTokens: 20 } }).outcome).toBe("miss");
  expect(cacheResult({ usage: { inputTokens: 100, cachedInputTokens: 10, cacheCreationInputTokens: 20 } }).outcome).toBe("unknown");
  expect(cacheResult({ usage: { inputTokens: 100, cachedInputTokens: 60, cacheReadInputTokens: 50, cacheCreationInputTokens: 20 } }).read).toBe(50);
  expect(cacheResult({ usage: { inputTokens: 100, cachedInputTokens: 50 } }).read).toBe(50);
});

test("summary excludes unknowns and weights reuse by input rather than averaging percentages", () => {
  const logs = [row(90), row(0, 900), { ...row(10000, 10000), usageStatus: "estimated" }];
  expect(summarizeCache(logs)).toEqual({ hits: 1, misses: 1, unknown: 1, input: 1000, read: 90, hitRate: 0.5, reuseRate: 0.09 });
  expect(summarizeCache([{}])).toMatchObject({ unknown: 1, hitRate: undefined, reuseRate: undefined });
  expect(summarizeCache([])).toMatchObject({ hits: 0, unknown: 0, hitRate: undefined, reuseRate: undefined });
});

test("cache filters intersect provider filters and summaries use the filtered snapshot", () => {
  const logs = [{ ...row(50), provider: "openai" }, { ...row(0), provider: "openai" }, { provider: "openai" }, { ...row(80), provider: "other" }];
  for (const cache of ["hit", "miss", "unknown"] as const) {
    const filters = { ...DEFAULT_LOG_FILTER_STATE, cache, provider: "openai" };
    expect(hasActiveLogFilters(filters)).toBe(true);
    const filtered = filterLogs(logs, filters);
    expect(filtered).toHaveLength(1);
    expect(cacheResult(filtered[0]).outcome).toBe(cache);
    expect(summarizeCache(filtered)[cache === "hit" ? "hits" : cache === "miss" ? "misses" : "unknown"]).toBe(1);
  }
  expect(filterLogs(logs, DEFAULT_LOG_FILTER_STATE)).toHaveLength(4);
});

test("nested attempts do not change request totals or substitute for missing request usage", () => {
  const logs = [{ ...row(10), attempts: [row(90), row(50)] }, { attempts: [row(100)] }];
  expect(summarizeCache(logs)).toMatchObject({ hits: 1, unknown: 1, read: 10, input: 100 });
});

const mixedCombo: CacheLogEntry = {
  provider: "combo", usageStatus: "reported",
  usage: { inputTokens: 200, cachedInputTokens: 90, cacheReadInputTokens: 0, cacheCreationInputTokens: 20 },
  attempts: [
    { provider: "openai", usageStatus: "reported", usage: { inputTokens: 100, cachedInputTokens: 90 } },
    { provider: "anthropic", usageStatus: "reported", usage: { inputTokens: 100, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 20 } },
  ],
};

test("mixed-adapter combo normalizes attempt reads before combining optional fields", () => {
  expect(cacheResult(mixedCombo)).toEqual({ outcome: "hit", input: 200, read: 90, write: undefined, uncached: 110, ratio: 0.45 });
  expect(filterLogs([mixedCombo], { ...DEFAULT_LOG_FILTER_STATE, cache: "hit" })).toEqual([mixedCombo]);
  expect(filterLogs([mixedCombo], { ...DEFAULT_LOG_FILTER_STATE, cache: "miss" })).toEqual([]);
  expect(summarizeCache([mixedCombo])).toMatchObject({ hits: 1, misses: 0, input: 200, read: 90, reuseRate: 0.45 });
});

test("combo requires complete reported cache-read coverage even when parent fields suggest a miss", () => {
  for (const attempt of [
    { usageStatus: "reported", usage: { inputTokens: 100 } },
    { ...row(0), usageStatus: "estimated" }, { ...row(0), usageStatus: "unreported" },
    { ...row(0), usageStatus: "unsupported" }, row(-1), null, "bad", {}, [],
  ]) {
    const combo = { ...mixedCombo, attempts: [row(0), attempt] };
    expect(cacheResult(combo).outcome).toBe("unknown");
    expect(summarizeCache([combo])).toMatchObject({ hits: 0, misses: 0, unknown: 1, input: 0, read: 0 });
    expect(cacheResult({ ...combo, attempts: [row(90), attempt] }).outcome).toBe("unknown");
  }
});

test("combo rejects incomplete attempts and preserves unknown parent usage", () => {
  for (const attempts of [undefined, [], [row(0)], [row(0), row(0), row(0)]]) {
    expect(cacheResult({ ...mixedCombo, attempts }).outcome).toBe("unknown");
  }
  expect(cacheResult({ ...mixedCombo, usage: undefined }).outcome).toBe("unknown");
  expect(cacheResult({ ...mixedCombo, usageStatus: "estimated" }).outcome).toBe("unknown");
  expect(cacheResult({ ...mixedCombo, usage: { ...mixedCombo.usage!, estimated: true } }).outcome).toBe("unknown");
});

test("combo sums complete writes and handles legacy fields within their own attempt", () => {
  const combo = {
    ...mixedCombo,
    attempts: [
      { usage: { inputTokens: 100, cachedInputTokens: 70, cacheCreationInputTokens: 20 } },
      { usage: { inputTokens: 100, cacheReadInputTokens: 20, cacheCreationInputTokens: 30 } },
    ],
  };
  expect(cacheResult(combo)).toMatchObject({ outcome: "hit", read: 70, write: 50, ratio: 0.35, uncached: 130 });
  expect(cacheResult({ ...mixedCombo, attempts: [row(0), row(0)] })).toMatchObject({ outcome: "miss", read: 0, ratio: 0 });
});
