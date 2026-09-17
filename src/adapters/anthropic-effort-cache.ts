import { normalizeAstraEffortCacheMetrics, type AstraEffortCacheMetrics, type AstraEffortStoreMeasurement } from "../usage/astra-effort-cache";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { withAstraEffortState } from "./astra-effort-state";

export const ANTHROPIC_PER_MESSAGE_EFFORT_BETA = "mid-conversation-output-config-2026-07-01";
const PER_MESSAGE_EFFORT_MODELS = /^(claude-fable-5-1|claude-mythos-5-1|claude-opus-5)(-\d{8})?$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MAX_SNAPSHOTS = 256;
const MAX_ITEMS = 20_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;

type RecordValue = Record<string, unknown>;
type Update = { position: number; effort: string };
type Snapshot = { prefix: string; length: number; envelope: string; baseline: string; effective: string; updates: Update[] };
type State = { version: 1; snapshots: Snapshot[] };

export interface AnthropicEffortResult {
  body: RecordValue;
  headers: Record<string, string>;
  status: AstraEffortCacheMetrics["status"];
  baseline?: string;
  effective?: string;
  metrics?: AstraEffortCacheMetrics;
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function supportsAnthropicPerMessageEffort(modelId: unknown): boolean {
  return typeof modelId === "string" && PER_MESSAGE_EFFORT_MODELS.test(modelId);
}

function effort(value: unknown): value is string {
  return typeof value === "string" && EFFORTS.has(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validState(value: unknown): value is State {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.snapshots) || value.snapshots.length > MAX_SNAPSHOTS) return false;
  return value.snapshots.every(s => record(s) && typeof s.prefix === "string" && /^[a-f0-9]{64}$/.test(s.prefix)
    && typeof s.envelope === "string" && /^[a-f0-9]{64}$/.test(s.envelope)
    && Number.isSafeInteger(s.length) && Number(s.length) > 0 && Number(s.length) <= MAX_ITEMS
    && effort(s.baseline) && effort(s.effective) && Array.isArray(s.updates) && s.updates.length <= Number(s.length)
    && s.updates.every((u, i, all) => record(u) && Number.isSafeInteger(u.position) && Number(u.position) >= 0
      && Number(u.position) < Number(s.length) && effort(u.effort)
      && (i === 0 || Number(u.position) > Number(all[i - 1].position)))
    && (s.updates.at(-1)?.effort ?? s.baseline) === s.effective);
}

function unsupported(body: RecordValue): AstraEffortCacheMetrics["status"] | undefined {
  if (!supportsAnthropicPerMessageEffort(body.model)) return "unsupported_model";
  if (!record(body.output_config) || !effort(body.output_config.effort)) return "unsupported_effort";
  if (!record(body.thinking) || body.thinking.type !== "adaptive") return "unsupported_mode";
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_ITEMS) return "unsupported_input";
  if (body.messages.some(m => !record(m) || (m.role === "system" && (m.output_config !== undefined || m.clear_at !== undefined)))) return "unsupported_input";
  return undefined;
}

function effortMessage(update: Update): RecordValue {
  return { role: "system", content: [], output_config: { effort: update.effort } };
}

function transform(body: RecordValue, state: State): AnthropicEffortResult & { snapshot?: Snapshot } {
  const messages = body.messages as RecordValue[];
  const outputConfig = body.output_config as RecordValue;
  const requested = outputConfig.effort as string;
  const { effort: _effort, ...outputConfigRest } = outputConfig;
  const envelopeHash = digest(JSON.stringify({ model: body.model, tools: body.tools, system: body.system, thinking: body.thinking, output_config: outputConfigRest }));
  const prefixes = [digest("")];
  for (const item of messages) prefixes.push(digest(prefixes.at(-1)! + JSON.stringify(item)));
  const prefix = prefixes.at(-1)!;
  const candidates = state.snapshots.filter(s => s.envelope === envelopeHash && s.length <= messages.length && prefixes[s.length] === s.prefix);
  const longest = Math.max(0, ...candidates.map(s => s.length));
  const matches = candidates.filter(s => s.length === longest);
  const histories = new Set(matches.map(s => JSON.stringify([s.baseline, s.effective, s.updates])));
  const unchanged = (status: AstraEffortCacheMetrics["status"]) => ({ body, headers: {}, status, effective: requested, baseline: requested });
  if (histories.size > 1) return unchanged("ambiguous_history");
  const prior = matches[0];
  if (prior?.length === messages.length && prior.effective !== requested) return unchanged("conflicting_retry");
  if (prior?.updates.some(u => messages[u.position]?.role !== "user")) return unchanged("invalid_state");
  const baseline = prior?.baseline ?? requested;
  const updates = prior ? prior.updates.map(u => ({ ...u })) : [];
  let status: AstraEffortCacheMetrics["status"] = prior ? "replay" : "baseline_reset";
  if (prior && prior.effective !== requested) {
    const nextUser = messages.findLastIndex((item, i) => i >= prior.length && item.role === "user");
    if (nextUser < 0) return unchanged("missing_user_boundary");
    updates.push({ position: nextUser, effort: requested });
    status = "updated";
  }
  const output: unknown[] = [];
  let updateIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    const update = updates[updateIndex];
    if (update?.position === i) {
      output.push(effortMessage(update));
      updateIndex++;
    }
    output.push(messages[i]);
  }
  const snapshot: Snapshot = { prefix, length: messages.length, envelope: envelopeHash, baseline, effective: requested, updates };
  if (!updates.length) return { body, headers: {}, status, baseline, effective: requested, snapshot };
  return {
    body: { ...body, output_config: { ...outputConfig, effort: baseline }, messages: output },
    headers: { "anthropic-beta": ANTHROPIC_PER_MESSAGE_EFFORT_BETA },
    status, baseline, effective: requested, snapshot,
  };
}

function applyInner(
  body: RecordValue,
  thread: string | undefined,
  parent: string | undefined,
  scopeParts: unknown[],
  directory: string,
  measurement: AstraEffortStoreMeasurement & { historyMs?: number },
): AnthropicEffortResult {
  const requested = record(body.output_config) && effort(body.output_config.effort) ? body.output_config.effort : undefined;
  const fallback = (status: AstraEffortCacheMetrics["status"]): AnthropicEffortResult => ({ body, headers: {}, status, baseline: requested, effective: requested });
  const reason = unsupported(body);
  if (reason) return fallback(reason);
  const identity = thread?.trim() ?? "";
  if (!identity || identity.length > 256) return fallback("missing_thread_identity");
  const scopeOf = (id: string) => digest(JSON.stringify(["anthropic", id, ...scopeParts]));
  const scope = scopeOf(identity);
  try {
    const parentIdentity = parent?.trim() ?? "";
    const inherited = parentIdentity && parentIdentity !== identity && parentIdentity.length <= 256
      ? withAstraEffortState(directory, scopeOf(parentIdentity), state => ({ value: state })) : undefined;
    return withAstraEffortState(directory, scope, serialized => {
      const started = performance.now();
      try {
        let state: State = { version: 1, snapshots: [] };
        const source = serialized ?? inherited;
        if (source !== undefined) {
          if (source.length > MAX_STATE_BYTES) return { value: fallback("state_limit") };
          const loaded: unknown = JSON.parse(source);
          if (!validState(loaded)) return { value: fallback("invalid_state") };
          state = loaded;
        }
        const result = transform(body, state);
        if (!result.snapshot) return { value: result, state: null };
        const snapshot = result.snapshot;
        if (!state.snapshots.some(s => JSON.stringify(s) === JSON.stringify(snapshot))) {
          state.snapshots.push(snapshot);
          if (state.snapshots.length > MAX_SNAPSHOTS) state.snapshots.shift();
        }
        let next = JSON.stringify(state);
        while (next.length > MAX_STATE_BYTES && state.snapshots.length > 1) {
          state.snapshots.shift();
          next = JSON.stringify(state);
        }
        if (next.length > MAX_STATE_BYTES) return { value: fallback("state_limit") };
        return { value: { body: result.body, headers: result.headers, status: result.status, baseline: result.baseline, effective: result.effective }, state: next };
      } finally { measurement.historyMs = performance.now() - started; }
    }, measurement);
  } catch {
    return fallback("unavailable_state");
  }
}

/** Pin the top-level effort to the conversation baseline and carry later changes as per-message effort updates. */
export function applyAnthropicEffortCache(
  body: RecordValue,
  identity: { thread?: string; parent?: string },
  scopeParts: unknown[],
  directory = join(getConfigDir(), "anthropic-effort-cache"),
): AnthropicEffortResult {
  const started = performance.now();
  const measurement: AstraEffortStoreMeasurement & { historyMs?: number } = { outcome: "skipped" };
  const result = applyInner(body, identity.thread, identity.parent, scopeParts, directory, measurement);
  const input = Array.isArray(body.messages) ? body.messages : [];
  const output = Array.isArray(result.body.messages) ? result.body.messages : [];
  let updateCount = 0;
  for (const item of output) if (record(item) && item.role === "system" && record(item.output_config)) updateCount++;
  const metrics = normalizeAstraEffortCacheMetrics({
    status: result.status, stateOutcome: measurement.outcome, durationMs: performance.now() - started,
    setupMs: measurement.setupMs, transactionMs: measurement.transactionMs, historyMs: measurement.historyMs,
    closeMs: measurement.closeMs, inputItems: input.length, updateCount,
  });
  return { ...result, ...(metrics ? { metrics } : {}) };
}
