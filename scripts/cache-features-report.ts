import { readRecentUsageEntries, type PersistedUsageEntry } from "../src/usage/log";
import { summarizeAstraEffortCache } from "./astra-effort-cache-report";
import { summarizeSideChatCache } from "./side-chat-cache-report";

export function summarizeCacheFeatures(rows: PersistedUsageEntry[]) {
  return { astraEffortCache: summarizeAstraEffortCache(rows), sideChatCache: summarizeSideChatCache(rows) };
}

if (import.meta.main) {
  const [limitArg = "1000", requestId] = process.argv.slice(2);
  const limit = Number(limitArg);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Usage: bun scripts/cache-features-report.ts [1..10000 recent rows] [request-id]");
  const rows = readRecentUsageEntries(limit);
  console.log(JSON.stringify(summarizeCacheFeatures(requestId ? rows.filter(row => row.requestId === requestId) : rows), null, 2));
}
