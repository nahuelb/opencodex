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

export function resolveOpenCodeTransport<T extends OcxProviderConfig>(
  provider: T,
  sessionLane: string | undefined,
): T {
  const providerId = openCodeSessionProviderId(provider);
  if (!providerId) return provider;
  if (!sessionLane) return provider;
  if (hasHeaderCaseInsensitive(provider.headers, OPENCODE_SESSION_HEADER)) return provider;

  return {
    ...provider,
    headers: {
      ...(provider.headers ?? {}),
      [OPENCODE_SESSION_HEADER]: deriveOpenCodeSessionId(sessionLane, providerId),
    },
  };
}

export const resolveOpenCodeGoTransport = resolveOpenCodeTransport;
