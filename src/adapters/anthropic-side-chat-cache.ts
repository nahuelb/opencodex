import { SIDE_CHAT_BOUNDARY, SIDE_CHAT_RULES } from "../codex/side-chat-cache";
import { normalizeSideChatCacheMetrics, type SideChatCacheMetrics } from "../usage/side-chat-cache";
import { normalizeLogConversationId } from "../server/request-log-conversation";
import { createHash } from "node:crypto";

type RecordValue = Record<string, unknown>;
type Snapshot = { expires: number; scope: string; tools: { name: string; hash: string }[]; system: string; messages: string[] };
export type SideChatIdentity = { thread?: string; parent?: string; scope: string };
export type SideChatDecision = { body: RecordValue; reason: SideChatCacheMetrics["reason"]; matchedItems: number; metrics: SideChatCacheMetrics };

const MAX_TOOLS = 2048;
const MAX_MESSAGES = 4096;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

function parseTurnMetadata(raw: unknown): RecordValue | undefined {
  if (typeof raw !== "string" || !raw || raw.length > 16_384) return undefined;
  try { const value: unknown = JSON.parse(raw); return record(value) ? value : undefined; } catch { return undefined; }
}

/** Thread and fork identity from the Codex headers and Responses client metadata. */
export function codexSideChatIdentity(rawBody: unknown, headers: Headers | undefined, scope: string): SideChatIdentity {
  const client = record(rawBody) && record(rawBody.client_metadata) ? rawBody.client_metadata : {};
  const bodyMetadata = record(rawBody) && record(rawBody.metadata) ? rawBody.metadata : {};
  const header = headers?.get("thread-id")?.trim();
  const thread = header || (typeof client.thread_id === "string" ? client.thread_id.trim() : undefined) || undefined;
  const metadata = parseTurnMetadata(headers?.get("x-codex-turn-metadata"));
  const embedded = parseTurnMetadata(client["x-codex-turn-metadata"]);
  const parents = [metadata?.forked_from_thread_id, embedded?.forked_from_thread_id, client.forked_from_thread_id, bodyMetadata.forked_from_thread_id]
    .filter(value => value !== undefined);
  const parent = parents[0];
  if (!identifier(parent) || parents.some(value => value !== parent) || parent === thread) return { thread, scope };
  return { thread, parent, scope };
}

function textOf(message: RecordValue): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content) && message.content.length === 1 && record(message.content[0])
    && message.content[0].type === "text" && typeof message.content[0].text === "string") return message.content[0].text;
  return undefined;
}

function removeRules(text: string): { text: string; removed: number } {
  const block = `\n\n${SIDE_CHAT_RULES}`;
  const index = text.indexOf(block);
  if (index < 0) return { text, removed: 0 };
  return { text: text.slice(0, index) + text.slice(index + block.length), removed: 1 };
}

function stripSystemRules(system: unknown): { system: unknown; removed: number } {
  if (!Array.isArray(system)) return { system, removed: 0 };
  let removed = 0;
  const blocks = system.flatMap(block => {
    if (!record(block) || block.type !== "text" || typeof block.text !== "string") return [block];
    if (block.text === SIDE_CHAT_RULES) { removed++; return []; }
    const result = removeRules(block.text);
    removed += result.removed;
    return [result.removed ? { ...block, text: result.text } : block];
  });
  return { system: removed ? blocks : system, removed };
}

function stripMessageRules(messages: RecordValue[]): { messages: RecordValue[]; removed: number } {
  let removed = 0;
  const output = messages.flatMap(message => {
    if (message.role !== "user") return [message];
    const text = textOf(message);
    if (text === SIDE_CHAT_RULES) { removed++; return []; }
    if (typeof message.content === "string") {
      const result = removeRules(message.content);
      removed += result.removed;
      return [result.removed ? { ...message, content: result.text } : message];
    }
    if (!Array.isArray(message.content)) return [message];
    let changed = 0;
    const content = message.content.flatMap(block => {
      if (!record(block) || block.type !== "text" || typeof block.text !== "string") return [block];
      if (block.text === SIDE_CHAT_RULES) { changed++; return []; }
      const result = removeRules(block.text);
      changed += result.removed;
      return [result.removed ? { ...block, text: result.text } : block];
    });
    removed += changed;
    if (changed && content.length === 0) return [];
    return [changed ? { ...message, content } : message];
  });
  return { messages: output, removed };
}

export class AnthropicSideChatCache {
  private readonly snapshots = new Map<string, Snapshot>();
  private expiredEntries = 0;
  private evictedEntries = 0;
  constructor(private readonly now = Date.now, private readonly capacity = 64, private readonly ttlMs = 600_000) {}

  clear(): void { this.snapshots.clear(); }
  get size(): number { this.prune(); return this.snapshots.size; }

  private candidate(identity: SideChatIdentity): { snapshot: Snapshot; phase: "bound-side" | "unbound-side" } | undefined {
    if (!identifier(identity.parent) || !identifier(identity.thread)) return undefined;
    const own = this.snapshots.get(identity.thread);
    if (own) return { snapshot: own, phase: "bound-side" };
    const parent = this.snapshots.get(identity.parent);
    return parent ? { snapshot: parent, phase: "unbound-side" } : undefined;
  }

  /** Wire tool names in the order this fork already established, else the parent's, when the tool set matches by content. */
  parentToolOrder(identity: SideChatIdentity, wireTools: readonly RecordValue[]): string[] | undefined {
    this.prune();
    const candidate = this.candidate(identity);
    if (!candidate || candidate.snapshot.scope !== identity.scope) return undefined;
    const hashes = wireTools.map(tool => digest(tool)).sort();
    const expected = candidate.snapshot.tools.map(tool => tool.hash).sort();
    if (hashes.length !== expected.length || hashes.some((hash, index) => hash !== expected[index])) return undefined;
    return candidate.snapshot.tools.map(tool => tool.name);
  }

  private prune(): void {
    const now = this.now();
    for (const [thread, snapshot] of this.snapshots) if (snapshot.expires <= now) { this.snapshots.delete(thread); this.expiredEntries++; }
    while (this.snapshots.size > this.capacity) { this.snapshots.delete(this.snapshots.keys().next().value!); this.evictedEntries++; }
  }

  private retention() {
    let bytes = 0;
    for (const snapshot of this.snapshots.values()) bytes += 128 + 96 * snapshot.tools.length + 64 * snapshot.messages.length;
    return { retainedSnapshots: this.snapshots.size, retainedBindings: 0, estimatedRetainedBytes: bytes };
  }

  prepare(body: RecordValue, identity: SideChatIdentity): SideChatDecision {
    const started = performance.now();
    const expired = this.expiredEntries;
    const evicted = this.evictedEntries;
    const metrics: SideChatCacheMetrics = { reason: "ineligible", phase: "unknown", snapshotOutcome: "ineligible", prepareMs: 0,
      inputItems: Array.isArray(body.messages) ? body.messages.length : 0, matchedItems: 0, parentCandidates: 0,
      retainedSnapshots: 0, retainedBindings: 0, estimatedRetainedBytes: 0, expiredEntries: 0, evictedEntries: 0 };
    let result: SideChatDecision;
    try { result = this.prepareInner(body, identity, metrics); }
    catch { result = { body, reason: "error", matchedItems: 0, metrics }; metrics.snapshotOutcome = "error"; }
    Object.assign(metrics, this.retention(), { reason: result.reason, matchedItems: result.matchedItems,
      expiredEntries: this.expiredEntries - expired, evictedEntries: this.evictedEntries - evicted });
    metrics.prepareMs = performance.now() - started;
    metrics.observedAt = performance.timeOrigin + started + metrics.prepareMs;
    return result;
  }

  private prepareInner(body: RecordValue, identity: SideChatIdentity, metrics: SideChatCacheMetrics): SideChatDecision {
    this.prune();
    const result: SideChatDecision = { body, reason: "ineligible", matchedItems: 0, metrics };
    const thread = identity.thread;
    metrics.threadIdHash = normalizeLogConversationId(thread ?? null);
    if (!identifier(thread) || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES
      || body.messages.some(message => !record(message))
      || (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS))) return result;
    const tools = Array.isArray(body.tools) ? body.tools : [];
    if (tools.some(tool => !record(tool) || typeof tool.name !== "string")) return result;
    let wire = body;
    const parent = identity.parent;
    const selected = this.candidate(identity);
    metrics.phase = parent ? selected?.phase ?? "unbound-side" : "parent";
    const matchStarted = performance.now();
    if (parent) {
      const candidate = selected?.snapshot;
      metrics.parentCandidates = candidate ? 1 : 0;
      result.reason = candidate ? "incompatible-prefix" : "missing-parent";
      if (candidate && candidate.scope !== identity.scope) result.reason = "account-or-header-change";
      else if (candidate) {
        let next: RecordValue = { ...body };
        let nextTools = tools as RecordValue[];
        const currentTools = nextTools.map(tool => ({ name: tool.name as string, hash: digest(tool) }));
        const sameSet = currentTools.length === candidate.tools.length
          && digest(currentTools.map(tool => tool.hash).sort()) === digest(candidate.tools.map(tool => tool.hash).sort());
        const sameOrder = sameSet && digest(currentTools.map(tool => tool.hash)) === digest(candidate.tools.map(tool => tool.hash));
        if (sameSet && !sameOrder) {
          const remaining = nextTools.map((tool, index) => ({ tool, hash: currentTools[index]!.hash }));
          nextTools = candidate.tools.map(entry => remaining.splice(remaining.findIndex(current => current.hash === entry.hash), 1)[0]!.tool);
          next.tools = nextTools;
        }
        const system = stripSystemRules(next.system);
        const stripped = stripMessageRules(next.messages as RecordValue[]);
        const moved = system.removed + stripped.removed;
        if (moved > 1) { result.reason = "multiple-rule-blocks"; }
        else if (!sameSet) { result.reason = "settings-change"; }
        else if (digest(system.system) !== candidate.system) { result.reason = "instructions-change"; }
        else {
          const messages = stripped.messages;
          const boundaries = messages.flatMap((message, index) => message.role === "user" && textOf(message) === SIDE_CHAT_BOUNDARY ? [index] : []);
          if ((moved && boundaries.length !== 1) || boundaries.length > 1) result.reason = "ambiguous-boundary";
          else {
            const prefixLength = boundaries.length ? Math.min(boundaries[0]!, candidate.messages.length) : candidate.messages.length;
            if (prefixLength === 0) result.reason = "empty-inherited-prefix";
            else {
              const mismatch = selected?.phase === "bound-side" ? -1
                : candidate.messages.slice(0, prefixLength).findIndex((hash, index) => hash !== digest(messages[index]));
              if (mismatch !== -1) { result.matchedItems = mismatch; result.reason = "input-prefix-change"; }
              else {
                if (boundaries.length && moved) messages.splice(boundaries[0]!, 0, { role: "user", content: [{ type: "text", text: SIDE_CHAT_RULES }] });
                next = { ...next, system: system.system, messages };
                if (next.system === undefined) delete next.system;
                wire = next;
                result.body = wire;
                result.matchedItems = prefixLength;
                result.reason = moved ? "inherited-with-tail-rules" : boundaries.length ? "inherited-with-developer-boundary" : "inherited-exact-prefix";
              }
            }
          }
        }
      }
    } else result.reason = "parent-observed";
    metrics.matchMs = performance.now() - matchStarted;
    const hashStarted = performance.now();
    const snapshot: Snapshot = {
      expires: this.now() + this.ttlMs, scope: identity.scope,
      tools: (Array.isArray(wire.tools) ? wire.tools as RecordValue[] : []).map(tool => ({ name: tool.name as string, hash: digest(tool) })),
      system: digest(wire.system), messages: (wire.messages as unknown[]).map(message => digest(message)),
    };
    metrics.hashMs = performance.now() - hashStarted;
    this.snapshots.delete(thread);
    this.snapshots.set(thread, snapshot);
    this.prune();
    metrics.snapshotOutcome = this.snapshots.has(thread) ? "stored" : "superseded";
    return result;
  }
}

let runtime: AnthropicSideChatCache | undefined;

export function parentSideChatToolOrder(identity: SideChatIdentity, wireTools: readonly RecordValue[]): string[] | undefined {
  runtime ??= new AnthropicSideChatCache();
  try { return runtime.parentToolOrder(identity, wireTools); } catch { return undefined; }
}

/** Reorder `tools` to `order` (by wire name) when both name sets are equal; otherwise return `tools`. */
export function reorderTools<T>(tools: readonly T[], order: readonly string[], wireName: (tool: T) => string): T[] {
  const names = tools.map(wireName);
  if (names.length !== order.length || new Set(names).size !== names.length) return [...tools];
  const position = new Map(order.map((name, index) => [name, index]));
  if (names.some(name => !position.has(name))) return [...tools];
  return tools.map((tool, index) => ({ tool, rank: position.get(names[index]!)! }))
    .sort((a, b) => a.rank - b.rank).map(entry => entry.tool);
}

/** Restore the parent's tool order and top-level system text for a Desktop side conversation. */
export function prepareAnthropicSideChatCache(body: RecordValue, identity: SideChatIdentity): SideChatDecision | undefined {
  if (!identifier(identity.thread)) return undefined;
  runtime ??= new AnthropicSideChatCache();
  try {
    const decision = runtime.prepare(body, identity);
    return normalizeSideChatCacheMetrics(decision.metrics) ? decision : undefined;
  } catch { return undefined; }
}

export function resetAnthropicSideChatCache(): void { runtime = undefined; }
