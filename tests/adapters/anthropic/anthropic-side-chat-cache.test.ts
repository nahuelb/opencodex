import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicSideChatCache, codexSideChatIdentity, resetAnthropicSideChatCache } from "../../../src/adapters/anthropic-side-chat-cache";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { SIDE_CHAT_BOUNDARY, SIDE_CHAT_RULES } from "../../../src/codex/side-chat-cache";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

let directory: string;
let oldHome: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "anthropic-side-chat-"));
  oldHome = process.env["OPENCODEX_HOME"];
  process.env["OPENCODEX_HOME"] = directory;
  resetAnthropicSideChatCache();
});
afterEach(() => {
  if (oldHome === undefined) delete process.env["OPENCODEX_HOME"]; else process.env["OPENCODEX_HOME"] = oldHome;
  rmSync(directory, { recursive: true, force: true });
  resetAnthropicSideChatCache();
});

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolA = { name: "alpha", input_schema: { type: "object", properties: {} } };
const toolB = { name: "beta", input_schema: { type: "object", properties: {} } };
const history = [user("first"), assistant("one"), user("second"), assistant("two")];
const parentBody = { system: [{ type: "text", text: "Base instructions" }], tools: [toolA, toolB], messages: [...history, user("third")] };
const sideBody = {
  system: [{ type: "text", text: `Base instructions\n\n${SIDE_CHAT_RULES}` }],
  tools: [toolB, toolA],
  messages: [...history, user(SIDE_CHAT_BOUNDARY), user("side question")],
};
const scope = "https://api.anthropic.com|claude-fable-5-1";

describe("Anthropic side-chat prefix reuse", () => {
  test("observes the parent and restores its tools order and system text for the fork", () => {
    const cache = new AnthropicSideChatCache();
    const parent = cache.prepare(parentBody, { thread: "parent", scope });
    expect(parent).toMatchObject({ reason: "parent-observed", matchedItems: 0 });
    expect(parent.metrics).toMatchObject({ phase: "parent", snapshotOutcome: "stored", inputItems: 5 });
    const side = cache.prepare(sideBody, { thread: "child", parent: "parent", scope });
    expect(side).toMatchObject({ reason: "inherited-with-tail-rules", matchedItems: 4 });
    expect(side.metrics).toMatchObject({ phase: "unbound-side", parentCandidates: 1, matchedItems: 4 });
    expect(side.body.tools).toEqual([toolA, toolB]);
    expect(side.body.system).toEqual(parentBody.system);
    expect(side.body.messages).toEqual([...history, user(SIDE_CHAT_RULES), user(SIDE_CHAT_BOUNDARY), user("side question")]);
    const followUp = cache.prepare({ ...sideBody, messages: [...sideBody.messages, assistant("answer"), user("more")] }, { thread: "child", parent: "parent", scope });
    expect(followUp.reason).toBe("inherited-with-tail-rules");
    expect(followUp.metrics.phase).toBe("bound-side");
    expect(followUp.body.messages).toEqual([...history, user(SIDE_CHAT_RULES), user(SIDE_CHAT_BOUNDARY), user("side question"), assistant("answer"), user("more")]);
  });

  test("a fork keeps its established wire shape after the parent snapshot expires", () => {
    let now = 0;
    const cache = new AnthropicSideChatCache(() => now, 64, 1000);
    cache.prepare(parentBody, { thread: "parent", scope });
    now = 600;
    const side = cache.prepare(sideBody, { thread: "child", parent: "parent", scope });
    expect(side.reason).toBe("inherited-with-tail-rules");
    now = 1200;
    const later = cache.prepare({ ...sideBody, messages: [...sideBody.messages, assistant("answer"), user("more")] }, { thread: "child", parent: "parent", scope });
    expect(later).toMatchObject({ reason: "inherited-with-tail-rules", matchedItems: 4 });
    expect(later.metrics).toMatchObject({ phase: "bound-side", expiredEntries: 1 });
    expect(later.body.tools).toEqual([toolA, toolB]);
    expect(cache.parentToolOrder({ thread: "child", parent: "parent", scope }, [toolB, toolA])).toEqual(["alpha", "beta"]);
    expect(cache.parentToolOrder({ thread: "child", parent: "parent", scope }, [toolB, { ...toolA, description: "changed" }])).toBeUndefined();
  });

  test("a bound fork keeps its established shape when its own prefix changes", () => {
    const cache = new AnthropicSideChatCache();
    cache.prepare(parentBody, { thread: "parent", scope });
    expect(cache.prepare(sideBody, { thread: "child", parent: "parent", scope }).reason).toBe("inherited-with-tail-rules");
    const compacted = cache.prepare({ ...sideBody, messages: [user("summary"), assistant("ok"), user(SIDE_CHAT_BOUNDARY), user("again")] }, { thread: "child", parent: "parent", scope });
    expect(compacted).toMatchObject({ reason: "inherited-with-tail-rules", metrics: { phase: "bound-side" } });
    expect(compacted.body.system).toEqual(parentBody.system);
    expect(compacted.body.messages).toEqual([user("summary"), assistant("ok"), user(SIDE_CHAT_RULES), user(SIDE_CHAT_BOUNDARY), user("again")]);
  });

  test("leaves the request alone without a parent snapshot or with a diverged prefix", () => {
    const cache = new AnthropicSideChatCache();
    const missing = cache.prepare(sideBody, { thread: "child", parent: "parent", scope });
    expect(missing).toMatchObject({ reason: "missing-parent", body: sideBody });
    cache.prepare(parentBody, { thread: "parent", scope });
    const diverged = cache.prepare({ ...sideBody, messages: [user("other"), ...sideBody.messages.slice(1)] }, { thread: "child-2", parent: "parent", scope });
    expect(diverged).toMatchObject({ reason: "input-prefix-change", matchedItems: 0, body: { tools: sideBody.tools } });
    const otherTools = cache.prepare({ ...sideBody, tools: [toolA] }, { thread: "child-3", parent: "parent", scope });
    expect(otherTools).toMatchObject({ reason: "settings-change", body: { tools: [toolA] } });
    const otherScope = cache.prepare(sideBody, { thread: "child-4", parent: "parent", scope: "other" });
    expect(otherScope.reason).toBe("account-or-header-change");
    const untransformed = cache.prepare({ ...sideBody, messages: [...sideBody.messages, assistant("a"), user("b")] }, { thread: "child", parent: "parent", scope });
    expect(untransformed).toMatchObject({ reason: "instructions-change", metrics: { phase: "bound-side" } });
  });

  test("keeps a rules-only developer message that Codex sent as a message", () => {
    const cache = new AnthropicSideChatCache();
    cache.prepare(parentBody, { thread: "parent", scope });
    const side = cache.prepare({ ...sideBody, system: parentBody.system, messages: [user(SIDE_CHAT_RULES), ...history, user(SIDE_CHAT_BOUNDARY), user("q")] },
      { thread: "child", parent: "parent", scope });
    expect(side.reason).toBe("inherited-with-tail-rules");
    expect(side.body.messages).toEqual([...history, user(SIDE_CHAT_RULES), user(SIDE_CHAT_BOUNDARY), user("q")]);
  });

  test("reads Desktop fork identity from headers and client metadata", () => {
    const headers = new Headers({ "thread-id": "child", "x-codex-turn-metadata": JSON.stringify({ forked_from_thread_id: "parent" }) });
    expect(codexSideChatIdentity({}, headers, scope)).toEqual({ thread: "child", parent: "parent", scope });
    expect(codexSideChatIdentity({ client_metadata: { thread_id: "child", forked_from_thread_id: "parent" } }, undefined, scope))
      .toEqual({ thread: "child", parent: "parent", scope });
    expect(codexSideChatIdentity({ client_metadata: { thread_id: "solo" } }, undefined, scope)).toEqual({ thread: "solo", scope });
    const conflicting = new Headers({ "thread-id": "child", "x-codex-turn-metadata": JSON.stringify({ forked_from_thread_id: "other" }) });
    expect(codexSideChatIdentity({ client_metadata: { forked_from_thread_id: "parent" } }, conflicting, scope)).toEqual({ thread: "child", scope });
  });
});

describe("Anthropic adapter side-chat wiring", () => {
  const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "oauth" } as unknown as OcxProviderConfig;
  const tools = [
    { name: "alpha", description: "a", parameters: { type: "object", properties: {} } },
    { name: "beta", description: "b", parameters: { type: "object", properties: {} } },
  ];
  function parsed(systemPrompt: string, messages: unknown[], toolOrder = tools, thread = "parent", parent?: string): OcxParsedRequest {
    return { modelId: "claude-fable-5-1", stream: true, options: { reasoning: "medium" },
      context: { systemPrompt: [systemPrompt], messages, tools: toolOrder },
      _rawBody: { client_metadata: { thread_id: thread, ...(parent ? { forked_from_thread_id: parent } : {}) } } } as unknown as OcxParsedRequest;
  }
  const parentMessages = [{ role: "user", content: "first" }, { role: "assistant", content: [{ type: "text", text: "one" }] }, { role: "user", content: "second" }];

  test("a forked side conversation reuses the parent's tool order and pinned effort", async () => {
    const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider));
    const meta = { headers: new Headers() } as any;
    const first = await adapter.buildRequest(parsed("Base", parentMessages.slice(0, 1)), meta);
    expect(first.sideChatCache).toMatchObject({ reason: "parent-observed", phase: "parent" });
    const parentRequest = await adapter.buildRequest({ ...parsed("Base", parentMessages), options: { reasoning: "high" } } as OcxParsedRequest, meta);
    const parentBody = JSON.parse(parentRequest.body as string);
    expect(parentBody.output_config).toEqual({ effort: "medium" });
    expect(parentBody.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "system", "user"]);
    const sideMessages = [...parentMessages, { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: SIDE_CHAT_BOUNDARY }, { role: "user", content: "side question" }];
    const sideRequest = await adapter.buildRequest(
      { ...parsed(`Base\n\n${SIDE_CHAT_RULES}`, sideMessages, [tools[1], tools[0]], "child", "parent"), options: { reasoning: "high" } } as OcxParsedRequest, meta);
    const sideBody = JSON.parse(sideRequest.body as string);
    expect(sideRequest.sideChatCache).toMatchObject({ reason: "inherited-with-tail-rules", phase: "unbound-side", matchedItems: 3 });
    expect(sideBody.tools.map((t: { name: string }) => t.name)).toEqual(parentBody.tools.map((t: { name: string }) => t.name));
    expect(sideBody.system).toEqual(parentBody.system);
    expect(sideBody.output_config).toEqual({ effort: "medium" });
    expect(sideBody.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "system", "user", "assistant", "user", "user", "user"]);
    expect(sideBody.messages[5].content[0].text).toBe(SIDE_CHAT_RULES);
    expect(sideBody.messages[6].content[0].text).toBe(SIDE_CHAT_BOUNDARY);
    expect(sideRequest.astraEffortCache).toMatchObject({ status: "replay", updateCount: 1 });
  });

  test("a fork whose tool schemas differ keeps its own order and reports the change", async () => {
    const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider));
    const meta = { headers: new Headers() } as any;
    await adapter.buildRequest(parsed("Base", parentMessages), meta);
    const changedTools = [{ ...tools[1], description: "changed" }, tools[0]];
    const sideMessages = [...parentMessages, { role: "assistant", content: [{ type: "text", text: "two" }] }, { role: "user", content: SIDE_CHAT_BOUNDARY }, { role: "user", content: "q" }];
    const sideRequest = await adapter.buildRequest(parsed(`Base\n\n${SIDE_CHAT_RULES}`, sideMessages, changedTools, "child-b", "parent"), meta);
    const sideBody = JSON.parse(sideRequest.body as string);
    expect(sideRequest.sideChatCache).toMatchObject({ reason: "settings-change" });
    expect(sideBody.tools.map((t: { name: string }) => t.name)).toEqual(["custom_beta", "custom_alpha"]);
    expect(sideBody.system[1].text).toContain(SIDE_CHAT_RULES);
  });
});
