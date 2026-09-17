import { createHash } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import { registryEntryForProviderDestination } from "./registry";

export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_GO_SESSION_HEADER = OPENCODE_SESSION_HEADER;
export { OPENCODE_CLIENT_USER_AGENT_TOKEN, OPENCODE_ZEN_USER_AGENT } from "./registry/opencode-headers";

function hasHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === target);
}

/** Zen's free-tier gate accepts only OpenCode-shaped session IDs: `ses_` plus 26 characters. */
const OPENCODE_ZEN_SESSION_ID_LENGTH = 26;

function deriveOpenCodeSessionId(sessionLane: string, providerId: string): string {
  const digest = createHash("sha256")
    .update(`opencodex/${providerId}/session/v1\0`)
    .update(sessionLane)
    .digest("hex");
  return providerId === "opencode-zen"
    ? `ses_${digest.slice(0, OPENCODE_ZEN_SESSION_ID_LENGTH)}`
    : `ocx_${digest.slice(0, 32)}`;
}

export function deriveOpenCodeGoSessionId(sessionLane: string): string {
  return deriveOpenCodeSessionId(sessionLane, "opencode-go");
}

export function deriveOpenCodeZenSessionId(sessionLane: string): string {
  return deriveOpenCodeSessionId(sessionLane, "opencode-zen");
}

export function openCodeSessionProviderId(provider: OcxProviderConfig): string | undefined {
  const id = registryEntryForProviderDestination(provider)?.id;
  return id === "opencode-go" || id === "opencode-zen" ? id : undefined;
}

/**
 * Add affinity only to canonical fixed-key OpenCode destinations. Go and Zen both require a session
 * on every request, so a sessionless caller falls back to its request-scoped lane, which stays
 * stable across retries without grouping unrelated requests.
 */
export function resolveOpenCodeTransport<T extends OcxProviderConfig>(
  provider: T,
  sessionLane: string | undefined,
  allocatedSessionLane?: string,
): T {
  const providerId = openCodeSessionProviderId(provider);
  if (!providerId) return provider;
  const lane = sessionLane ?? allocatedSessionLane;
  if (!lane) return provider;
  if (hasHeaderCaseInsensitive(provider.headers, OPENCODE_SESSION_HEADER)) return provider;

  return {
    ...provider,
    headers: {
      ...(provider.headers ?? {}),
      [OPENCODE_SESSION_HEADER]: deriveOpenCodeSessionId(lane, providerId),
    },
  };
}

export const resolveOpenCodeGoTransport = resolveOpenCodeTransport;
