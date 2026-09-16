import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses";
import { responseWithDeferredRequestLog } from "../../src/server/relay";
import { addFinalRequestLog, clearRequestLogsForTests, httpStatusForRequestLogTerminal, type RequestLogContext } from "../../src/server/request-log";
import { readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";

for (const { effort, stream, stripped } of [
  { effort: "xhigh" }, { effort: "minimal" }, { effort: "ultra" }, {},
  { effort: "xhigh", stream: true }, { effort: "xhigh", stripped: true },
] as Array<{ effort?: string; stream?: boolean; stripped?: boolean }>) {
  test(`Zen Responses persists its actual wire effort (${effort ?? "absent"}, stream=${!!stream}, stripped=${!!stripped})`, async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-zen-effort-"));
    process.env.OPENCODEX_HOME = home;
    const model = "muse-spark-1.3-contributor-free";
    const provider = providerConfigSeed(getProviderRegistryEntry("opencode-zen")!);
    if (stripped) provider.modelReasoningEfforts = { [model]: [] };
    const config = { providers: { "opencode-zen": { ...provider, apiKey: "test-key" } } } as OcxConfig;
    const captured: Array<{ reasoning?: { effort?: string } }> = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://opencode.ai/zen/v1/responses");
      captured.push(JSON.parse(String(init?.body)));
      const response = {
        id: "resp_zen_effort", object: "response", status: "completed", model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      };
      return stream
        ? new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
        : Response.json(response);
    });
    try {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const requestId = `zen-${effort ?? "absent"}`;
      const start = Date.now();
      const terminalLogged = Promise.withResolvers<void>();
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json", "thread-id": "zen-effort-fixture" },
        body: JSON.stringify({
          model: `opencode-zen/${model}`, input: "private-prompt-marker", stream: !!stream,
          ...(effort ? { reasoning: { effort } } : {}),
        }),
      }), config, logCtx, stream ? {
        onNativePassthroughTerminal: status => {
          addFinalRequestLog(requestId, start, logCtx, httpStatusForRequestLogTerminal(status, logCtx), {
            terminalStatus: status, closeReason: "terminal",
          });
          terminalLogged.resolve();
        },
      } : {});
      const loggedResponse = responseWithDeferredRequestLog(response, requestId, start, logCtx);
      expect(loggedResponse.status).toBe(200);
      await loggedResponse.text();
      if (stream) await terminalLogged.promise;
      expect(captured).toHaveLength(1);
      const wireEffort = stripped ? undefined : effort === "ultra" ? "xhigh" : effort;
      expect(captured[0]?.reasoning?.effort).toBe(wireEffort);
      const rows = readUsageEntries();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attempts).toHaveLength(1);
      for (const row of [rows[0], rows[0]?.attempts?.[0]]) {
        expect(row?.requestedEffort).toBe(effort === "ultra" ? "max" : effort);
        expect(row?.effectiveEffort).toBe(wireEffort);
        expect(row?.reasoningWireField).toBe(wireEffort ? "reasoning.effort" : undefined);
        expect(row?.reasoningWireValue).toBe(wireEffort);
      }
      expect(JSON.stringify(rows)).not.toContain("private-prompt-marker");
    } finally {
      fetchSpy.mockRestore();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      removeTreeWithRetry(home);
    }
  });
}
