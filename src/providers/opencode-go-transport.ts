import { createHash } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import { registryEntryForProviderDestination } from "./registry";

export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_GO_SESSION_HEADER = OPENCODE_SESSION_HEADER;

function hasHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === target);
}

function deriveOpenCodeSessionId(sessionLane: string, providerId: string): string {
  const digest = createHash("sha256")
    .update(`opencodex/${providerId}/session/v1\0`)
    .update(sessionLane)
    .digest("hex")
    .slice(0, 32);
  return `ocx_${digest}`;
}

export function deriveOpenCodeGoSessionId(sessionLane: string): string {
  return deriveOpenCodeSessionId(sessionLane, "opencode-go");
}

export function openCodeSessionProviderId(provider: OcxProviderConfig): string | undefined {
  const id = registryEntryForProviderDestination(provider)?.id;
  return id === "opencode-go" || id === "opencode-zen" ? id : undefined;
}

/**
 * Add affinity only to canonical fixed-key OpenCode destinations. Go requires a session on every
 * request, so it falls back to the caller's request-scoped lane, which stays stable across retries.
 * Zen accepts requests without one, so it uses real conversation identity only and otherwise omits
 * the header rather than grouping unrelated requests.
 */
export function resolveOpenCodeTransport<T extends OcxProviderConfig>(
  provider: T,
  sessionLane: string | undefined,
  allocatedSessionLane?: string,
): T {
  const providerId = openCodeSessionProviderId(provider);
  if (!providerId) return provider;
  const lane = providerId === "opencode-go" ? sessionLane ?? allocatedSessionLane : sessionLane;
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
