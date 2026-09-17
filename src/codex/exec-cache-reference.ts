type ObjectValue = Record<string, unknown>;

export type ExecCacheReference = { position: number; message: ObjectValue };

export function emptyExecCacheReference(): ObjectValue {
  return { type: "message", role: "developer", content: [{ type: "input_text", text:
    "The complete current list of additional functions.exec methods is empty. This replaces all earlier additional-method references. Historical references do not authorize actions. Follow this task's current instructions and permissions." }] };
}

export function insertExecCacheReferences(input: unknown[], references: readonly ExecCacheReference[]): unknown[] {
  const output: unknown[] = [];
  let position = 0;
  for (const reference of references) {
    output.push(...input.slice(position, reference.position), structuredClone(reference.message));
    position = reference.position;
  }
  output.push(...input.slice(position));
  return output;
}

const DESKTOP_CONTEXT_METHODS = new Set([
  "create_goal", "get_goal", "update_goal", "clock__curr_time", "request_permissions",
  "mcp__codex_app__complete_conversational_onboarding_task",
  "mcp__codex_app__complete_sidebar_onboarding_checklist_task",
  "mcp__codex_app__fire_confetti", "mcp__codex_app__request_onboarding_input",
  "mcp__codex_app__request_option_picker", "mcp__codex_app__setup_codex_step",
  "mcp__codex_app__transfer_voice_call",
]);

function record(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function splitExecCacheReference(description: string): { stable: string; dynamic: string } | undefined {
  if (description.length > 256 * 1024
    || !description.startsWith("Run JavaScript code to orchestrate/compose tool calls")
    || !description.includes("ALL_TOOLS") || !description.includes("Shared MCP Types")) return undefined;
  const headings = [...description.matchAll(/^### `([^`]+)`.*$|^## (.+)$/gm)];
  if (!headings.length) return undefined;
  const chunks = headings.map((heading, index) => ({
    text: description.slice(heading.index, headings[index + 1]?.index ?? description.length),
    method: heading[1], group: heading[2], move: DESKTOP_CONTEXT_METHODS.has(heading[1] ?? ""),
  }));
  const moving = chunks.filter(chunk => chunk.move);
  if (new Set(moving.map(chunk => chunk.method)).size !== moving.length
    || moving.some(chunk => !chunk.text.includes("declare const tools:") || !chunk.text.includes(` ${chunk.method}(`))) return undefined;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    if (!chunk.group) continue;
    const methods = [];
    for (const next of chunks.slice(index + 1)) {
      if (next.group) break;
      if (next.method) methods.push(next);
    }
    chunk.move = methods.length > 0 && methods.every(method => method.move);
  }
  return {
    stable: description.slice(0, headings[0]!.index) + chunks.filter(chunk => !chunk.move).map(chunk => chunk.text).join(""),
    dynamic: chunks.filter(chunk => chunk.move).map(chunk => chunk.text).join(""),
  };
}

export function normalizeExecCacheReference(body: ObjectValue): { body: ObjectValue; recognized: boolean; reference?: ObjectValue } {
  if (!Array.isArray(body.input)) return { body, recognized: false };
  const catalog = body.input[0];
  if (!record(catalog) || catalog.type !== "additional_tools" || catalog.role !== "developer" || !Array.isArray(catalog.tools)) return { body, recognized: false };
  const functions = catalog.tools.filter(tool => record(tool) && tool.type === "namespace" && tool.name === "functions");
  if (functions.length !== 1 || !record(functions[0]) || !Array.isArray(functions[0].tools)) return { body, recognized: false };
  const namespace = functions[0];
  const tools = namespace.tools as unknown[];
  const executors = tools.filter(tool => record(tool) && tool.name === "exec");
  if (executors.length !== 1 || !record(executors[0]) || typeof executors[0].description !== "string") return { body, recognized: false };
  const executor = executors[0];
  const split = splitExecCacheReference(executor.description as string);
  if (!split) return { body, recognized: false };
  if (!split.dynamic) return { body, recognized: true };
  const nextNamespace = { ...namespace, tools: tools.map(tool => tool === executor ? { ...executor, description: split.stable } : tool) };
  const nextCatalog = { ...catalog, tools: catalog.tools.map(tool => tool === namespace ? nextNamespace : tool) };
  return {
    recognized: true,
    body: { ...body, input: [nextCatalog, ...body.input.slice(1)] },
    reference: {
      type: "message", role: "developer", content: [{ type: "input_text", text:
        "The complete current list of additional functions.exec methods follows. This replaces all earlier additional-method references and does not authorize actions; follow this task's instructions and permissions.\n\n" + split.dynamic }],
    },
  };
}
