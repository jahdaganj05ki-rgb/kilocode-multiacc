/**
 * Credential probe for API-key providers (kilocode).
 *
 * A probe asks a provider's `/models` endpoint whether a key is accepted. Only a
 * definitive answer changes stored health; network failures stay "unknown" so a
 * hiccup never marks a working account as broken.
 */
import { classify, quota, wait as retry, type VerifyStatus } from "./accounts"
import type { AccountQuota } from "@/auth"

export type ProbeInput = {
  readonly providerID: string
  readonly key: string
  /** Any model endpoint of the provider; `/models` is appended when missing. */
  readonly url: string
}

export type ProbeResult = {
  readonly status: VerifyStatus
  readonly httpStatus?: number
  /** Advertised wait from a rate limit, in milliseconds. */
  readonly retryAfter?: number
  /** Rate-limit quota the provider reported in its response headers. */
  readonly quota?: AccountQuota
}

export function endpoint(url: string) {
  const base = url.trim().replace(/\/+$/, "")
  return base.endsWith("/models") ? base : `${base}/models`
}

/** Provider-specific authentication headers. */
export function headers(providerID: string, key: string): Record<string, string> {
  if (providerID === "anthropic")
    return { accept: "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
  if (providerID === "google" || providerID === "google-vertex")
    return { accept: "application/json", "x-goog-api-key": key }
  return { accept: "application/json", authorization: `Bearer ${key}` }
}

/** Never throws: an unreachable endpoint is "unknown", not a failure. */
export async function probe(input: ProbeInput): Promise<ProbeResult> {
  const response = await fetch(endpoint(input.url), {
    headers: headers(input.providerID, input.key),
    // Cap the wait so a hung provider cannot block a request indefinitely.
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response) return { status: "unknown" }
  const retryAfter = retry(response.headers.get("retry-after"))
  const reported = quota(Object.fromEntries(response.headers))
  // The body is irrelevant; release the connection instead of buffering it.
  await response.body?.cancel().catch(() => undefined)
  return {
    status: classify(response.status),
    httpStatus: response.status,
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(reported === undefined ? {} : { quota: reported }),
  }
}

export * as KiloProviderProbe from "./probe"
