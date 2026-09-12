export type CacheOutcome = "hit" | "miss" | "unknown";
export type CacheFilter = "all" | CacheOutcome;

export interface CacheLogEntry {
  provider?: unknown;
  attempts?: unknown;
  usageStatus?: string;
  usage?: {
    inputTokens: number;
    cachedInputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    estimated?: boolean;
  };
}

export interface CacheResult {
  outcome: CacheOutcome;
  input?: number;
  read?: number;
  write?: number;
  uncached?: number;
  ratio?: number;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function singleCacheResult(entry: CacheLogEntry): CacheResult {
  const u = entry.usage;
  if (!u || (entry.usageStatus !== undefined && entry.usageStatus !== "reported") || u.estimated) return { outcome: "unknown" };
  if (!count(u.inputTokens) || u.inputTokens === 0) return { outcome: "unknown" };
  const write = u.cacheCreationInputTokens;
  if (write !== undefined && !count(write)) return { outcome: "unknown" };
  const read = u.cacheReadInputTokens ?? (u.cachedInputTokens !== undefined
    ? u.cachedInputTokens - (write ?? 0) : undefined);
  if (!count(read) || read + (write ?? 0) > u.inputTokens) return { outcome: "unknown" };
  return {
    outcome: read > 0 ? "hit" : "miss", input: u.inputTokens, read, write,
    uncached: u.inputTokens - read, ratio: read / u.inputTokens,
  };
}

export function cacheResult(entry: CacheLogEntry): CacheResult {
  if (entry.provider !== "combo") return singleCacheResult(entry);
  const u = entry.usage;
  if (!u || (entry.usageStatus !== undefined && entry.usageStatus !== "reported") || u.estimated
    || !count(u.inputTokens) || u.inputTokens === 0
    || !Array.isArray(entry.attempts) || entry.attempts.length === 0) return { outcome: "unknown" };
  let input = 0, read = 0, write = 0;
  let writesKnown = true;
  for (const attempt of entry.attempts) {
    if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return { outcome: "unknown" };
    const cache = singleCacheResult(attempt);
    if (cache.outcome === "unknown") return { outcome: "unknown" };
    input += cache.input!;
    read += cache.read!;
    if (cache.write === undefined) writesKnown = false;
    else write += cache.write;
  }
  if (input !== u.inputTokens || !count(input) || !count(read) || !count(write)) return { outcome: "unknown" };
  return {
    outcome: read > 0 ? "hit" : "miss", input, read, write: writesKnown ? write : undefined,
    uncached: input - read, ratio: read / input,
  };
}

export function summarizeCache(logs: readonly CacheLogEntry[]) {
  let hits = 0, misses = 0, unknown = 0, input = 0, read = 0;
  for (const log of logs) {
    const cache = cacheResult(log);
    if (cache.outcome === "unknown") { unknown++; continue; }
    if (cache.outcome === "hit") hits++; else misses++;
    input += cache.input!;
    read += cache.read!;
  }
  return {
    hits, misses, unknown, input, read,
    hitRate: hits + misses > 0 ? hits / (hits + misses) : undefined,
    reuseRate: input > 0 ? read / input : undefined,
  };
}

export function formatCachePercent(ratio: number | undefined, locale?: string): string {
  return ratio === undefined ? "—" : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(ratio);
}
