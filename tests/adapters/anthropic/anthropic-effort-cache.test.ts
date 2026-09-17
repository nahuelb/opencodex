import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_PER_MESSAGE_EFFORT_BETA, applyAnthropicEffortCache, supportsAnthropicPerMessageEffort } from "../../../src/adapters/anthropic-effort-cache";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { ANTHROPIC_OAUTH_BETA } from "../../../src/oauth/anthropic";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

let directory: string;
let oldHome: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "anthropic-effort-"));
  oldHome = process.env["OPENCODEX_HOME"];
  process.env["OPENCODEX_HOME"] = directory;
});
afterEach(() => {
  if (oldHome === undefined) delete process.env["OPENCODEX_HOME"]; else process.env["OPENCODEX_HOME"] = oldHome;
  rmSync(directory, { recursive: true, force: true });
});

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "abcdefghijklmnopqrstuvwxyz0123456789" }, { type: "text", text }] });
const update = (effort: string) => ({ role: "system", content: [], output_config: { effort } });
const first = [user("Synthetic first turn")];
const second = [...first, assistant("OK"), user("Synthetic second turn")];
const third = [...second, assistant("OK"), user("Synthetic third turn")];
function body(messages: unknown[], effort = "medium", extra: Record<string, unknown> = {}) {
  return { model: "claude-fable-5-1", system: [{ type: "text", text: "sys" }], tools: [{ name: "t", input_schema: { type: "object" } }],
    thinking: { type: "adaptive" }, output_config: { effort }, max_tokens: 1000, messages, stream: true, ...extra };
}
function run(messages: unknown[], effort = "medium", thread: string | undefined = "thread-a", extra: Record<string, unknown> = {}) {
  return applyAnthropicEffortCache(body(messages, effort, extra), { thread }, ["https://api.anthropic.com"], join(directory, "state"));
}

describe("Anthropic per-message effort history", () => {
  test("gates per-message effort to the documented models", () => {
    expect(supportsAnthropicPerMessageEffort("claude-fable-5-1")).toBe(true);
    expect(supportsAnthropicPerMessageEffort("claude-opus-5")).toBe(true);
    expect(supportsAnthropicPerMessageEffort("claude-opus-5-20260901")).toBe(true);
    expect(supportsAnthropicPerMessageEffort("claude-fable-5")).toBe(false);
    expect(supportsAnthropicPerMessageEffort("claude-sonnet-5")).toBe(false);
    expect(supportsAnthropicPerMessageEffort("claude-opus-5-1")).toBe(false);
  });

  test("pins the baseline, inserts the change before the new user turn, and replays it", () => {
    const baseline = run(first);
    expect(baseline).toMatchObject({ status: "baseline_reset", baseline: "medium", effective: "medium", headers: {} });
    expect(baseline.body).toEqual(body(first));
    const low = run(second, "low");
    expect(low).toMatchObject({ status: "updated", baseline: "medium", effective: "low", headers: { "anthropic-beta": ANTHROPIC_PER_MESSAGE_EFFORT_BETA } });
    expect(low.body).toEqual({ ...body(second, "medium"), messages: [...first, assistant("OK"), update("low"), user("Synthetic second turn")] });
    expect(low.metrics).toMatchObject({ status: "updated", stateOutcome: "committed", inputItems: 3, updateCount: 1 });
    const replay = run(third, "low");
    expect(replay).toMatchObject({ status: "replay", baseline: "medium", effective: "low" });
    expect((replay.body.messages as unknown[])).toEqual([...first, assistant("OK"), update("low"), user("Synthetic second turn"), assistant("OK"), user("Synthetic third turn")]);
    expect((replay.body.output_config as { effort: string }).effort).toBe("medium");
    const high = run([...third, assistant("OK"), user("Synthetic fourth turn")], "high");
    expect(high).toMatchObject({ status: "updated", baseline: "medium", effective: "high" });
    expect((high.body.messages as unknown[]).filter(m => (m as { role: string }).role === "system")).toEqual([update("low"), update("high")]);
  });

  test("keeps the wire unchanged when the effort never changes", () => {
    run(first);
    const replay = run(second);
    expect(replay).toMatchObject({ status: "replay", headers: {} });
    expect(replay.body).toEqual(body(second));
  });

  test("leaves a same-length retry with a different effort alone", () => {
    run(first);
    const retry = run(first, "high");
    expect(retry).toMatchObject({ status: "conflicting_retry", headers: {} });
    expect(retry.body).toEqual(body(first, "high"));
  });

  test("resets the baseline when the prefix ahead of the messages changes", () => {
    run(first);
    const changed = run(second, "low", "thread-a", { system: [{ type: "text", text: "other" }] });
    expect(changed).toMatchObject({ status: "baseline_reset", baseline: "low", headers: {} });
  });

  test("separates threads and reports missing identity", () => {
    run(first);
    expect(run(second, "low", "thread-b")).toMatchObject({ status: "baseline_reset", baseline: "low" });
    expect(applyAnthropicEffortCache(body(second, "low"), {}, [], join(directory, "state"))).toMatchObject({ status: "missing_thread_identity" });
  });

  test("a side conversation seeds its history from the parent thread", () => {
    run(first);
    run(second, "low");
    const child = applyAnthropicEffortCache(body([...second, assistant("OK"), user("side question")], "low"), { thread: "child", parent: "thread-a" }, ["https://api.anthropic.com"], join(directory, "state"));
    expect(child).toMatchObject({ status: "replay", baseline: "medium", effective: "low" });
    expect((child.body.messages as unknown[])).toEqual([...first, assistant("OK"), update("low"), user("Synthetic second turn"), assistant("OK"), user("side question")]);
    expect(applyAnthropicEffortCache(body([...second, assistant("OK"), user("side question")], "low"), { thread: "child" }, ["https://api.anthropic.com"], join(directory, "state")).status).toBe("replay");
  });

  test("skips unsupported models and non-adaptive thinking", () => {
    expect(run(first, "medium", "thread-a", { model: "claude-fable-5" }).status).toBe("unsupported_model");
    expect(run(first, "medium", "thread-a", { thinking: { type: "enabled", budget_tokens: 2048 } }).status).toBe("unsupported_mode");
  });
});

describe("Anthropic adapter effort wiring", () => {
  const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "oauth" } as unknown as OcxProviderConfig;
  function parsed(reasoning: string, messages: unknown[]): OcxParsedRequest {
    return { modelId: "claude-fable-5-1", stream: true, options: { reasoning },
      context: { systemPrompt: ["sys"], messages } } as unknown as OcxParsedRequest;
  }
  const incoming = (thread: string) => ({ headers: new Headers({ "thread-id": thread }) }) as any;
  const history = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "second" },
  ];

  test("carries an effort change as a per-message update with the beta header and metrics", async () => {
    const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider));
    const initial = await adapter.buildRequest(parsed("medium", history.slice(0, 1)), incoming("thread-x"));
    const initialBody = JSON.parse(initial.body as string);
    expect(initialBody.output_config).toEqual({ effort: "medium" });
    expect(initial.headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
    expect(initial.astraEffortCache).toMatchObject({ status: "baseline_reset", updateCount: 0 });
    const changed = await adapter.buildRequest(parsed("high", history), incoming("thread-x"));
    const changedBody = JSON.parse(changed.body as string);
    expect(changedBody.output_config).toEqual({ effort: "medium" });
    expect(changedBody.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "system", "user"]);
    expect(changedBody.messages[2]).toEqual({ role: "system", content: [], output_config: { effort: "high" } });
    expect(changed.headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA + "," + ANTHROPIC_PER_MESSAGE_EFFORT_BETA);
    expect(changedBody.max_tokens).toBeGreaterThan(initialBody.max_tokens);
    expect(changed.astraEffortCache).toMatchObject({ status: "updated", updateCount: 1 });
    expect(changedBody.cache_control).toEqual({ type: "ephemeral" });
  });

  test("does not touch models without per-message effort", async () => {
    const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider));
    const request = await adapter.buildRequest({ ...parsed("high", history), modelId: "claude-sonnet-5" }, incoming("thread-y"));
    expect(JSON.parse(request.body as string).output_config).toEqual({ effort: "high" });
    expect(request.astraEffortCache).toBeUndefined();
  });
});
