import { expect, test } from "bun:test";
import { startCacheProxy } from "../helpers/side-chat-cache-proxy";
import { SIDE_CHAT_BOUNDARY } from "../../src/codex/side-chat-cache";
import { readRecentUsageEntries } from "../../src/usage/log";
import { summarizeCacheFeatures } from "../../scripts/cache-features-report";
import { normalizeLogConversationId } from "../../src/server/request-log-conversation";

test("both cache features retain independent diagnostics on the same real proxy request", async () => {
  const fixture = await startCacheProxy(true);
  const input = [{ role: "developer", content: "Synthetic rules" }, { role: "user", content: "Parent" }];
  const body = (thread: string, history: unknown[], parent?: string) => ({ model: "gpt-6-astra", reasoning: { effort: "medium" },
    instructions: "Synthetic", input: history, stream: true, store: false, prompt_cache_key: thread,
    client_metadata: { thread_id: thread, session_id: thread, ...(parent ? { forked_from_thread_id: parent } : {}) } });
  try {
    const parent = await fixture.http(body("parent", input), "parent");
    await fixture.http(body("child", [...input, ...parent.output, { role: "user", content: SIDE_CHAT_BOUNDARY }, { role: "user", content: "Side" }], "parent"), "child", false, "parent");
    const rows = readRecentUsageEntries(10, fixture.home);
    const child = rows.find(row => row.sideChatCache?.threadIdHash === normalizeLogConversationId("child"));
    expect(child?.astraEffortCache).toMatchObject({ stateOutcome: "committed", status: "baseline_reset" });
    expect(child?.sideChatCache).toMatchObject({ phase: "unbound-side", snapshotOutcome: "stored" });
    expect(child?.attempts?.at(-1)?.sideChatCache).toEqual(child?.sideChatCache);
    expect(child?.attempts?.at(-1)?.astraEffortCache).toEqual(child?.astraEffortCache);
    const report = summarizeCacheFeatures(rows);
    expect(report.astraEffortCache.samples).toBe(2);
    expect(report.sideChatCache.samples).toBe(2);
  } finally { await fixture.stop(); }
});
