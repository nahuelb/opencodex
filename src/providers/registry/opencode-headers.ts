/** Zen admits free-model requests only with an `opencode/<version>` User-Agent plus a session header. */
export const OPENCODE_CLIENT_USER_AGENT_TOKEN = "opencode/1.18.31";
export const OPENCODE_ZEN_USER_AGENT = `opencodex ${OPENCODE_CLIENT_USER_AGENT_TOKEN}`;
/** Registry User-Agent values older configs persisted; the merge replaces them instead of keeping them. */
export const OPENCODE_SUPERSEDED_USER_AGENTS: ReadonlySet<string> = new Set(["opencodex"]);
