import { beforeEach, describe, expect, test } from "bun:test"
import type { Auth } from "../../../src/auth"
import { KiloProviderAccounts } from "../../../src/kilocode/provider/accounts"

const now = 1_700_000_000_000

function provider(input: {
  strategy?: "manual" | "failover" | "roundRobin"
  active?: string
  accounts?: Array<{
    id: string
    key?: string
    enabled?: boolean
    status?: "ok" | "invalid" | "cooling"
    cooldownUntil?: number
    quota?: { limit?: number; remaining?: number; resetAt?: number }
  }>
}): Auth.Info {
  return {
    type: "api",
    key: "sk-active",
    active: input.active ?? "one",
    strategy: input.strategy ?? "manual",
    accounts: (
      input.accounts ?? [
        { id: "one", key: "sk-one" },
        { id: "two", key: "sk-two" },
        { id: "three", key: "sk-three" },
      ]
    ).map((item) => ({
      id: item.id,
      label: item.id,
      key: item.key ?? `sk-${item.id}`,
      createdAt: now,
      ...(item.enabled !== undefined ? { enabled: item.enabled } : {}),
      ...(item.status !== undefined ? { status: item.status } : {}),
      ...(item.cooldownUntil !== undefined ? { cooldownUntil: item.cooldownUntil } : {}),
      ...(item.quota !== undefined ? { quota: item.quota } : {}),
    })),
  }
}

function rateLimited() {
  return { data: { statusCode: 429, responseHeaders: { "retry-after": "30" } } }
}

function unauthorized() {
  return { data: { statusCode: 401 } }
}

describe("provider account policy", () => {
  beforeEach(() => KiloProviderAccounts.reset())

  test("manual keeps the active account even when it is failing", () => {
    const info = provider({ strategy: "manual", active: "two" })
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, now })?.id).toBe("two")
    expect(KiloProviderAccounts.failed({ providerID: "p", error: unauthorized(), now })).toBe(true)
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, now })?.id).toBe("two")
  })

  test("failover moves to the next usable account after a 401", () => {
    const info = provider({ strategy: "failover", active: "one" })
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, now })?.id).toBe("one")
    expect(KiloProviderAccounts.failed({ providerID: "p", error: unauthorized(), now })).toBe(true)
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, now })?.id).toBe("two")
    expect(KiloProviderAccounts.failed({ providerID: "p", error: unauthorized(), now })).toBe(true)
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, now })?.id).toBe("three")
    // every account is spent: retrying cannot help
    expect(KiloProviderAccounts.failed({ providerID: "p", error: unauthorized(), now })).toBe(false)
  })

  test("429 cools an account down for the advertised retry-after window", () => {
    const info = provider({ strategy: "failover", active: "one" })
    KiloProviderAccounts.resolve({ providerID: "p", info, now })
    expect(KiloProviderAccounts.failed({ providerID: "p", error: rateLimited(), now })).toBe(true)
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, now: now + 1_000 })?.id).toBe("two")
    // after the window the account is eligible again
    const accounts = KiloProviderAccounts.settings(info)?.accounts ?? []
    expect(KiloProviderAccounts.available("p", accounts, now + 31_000).map((item) => item.id)).toEqual([
      "one",
      "two",
      "three",
    ])
  })

  test("round robin rotates per turn and stays sticky within a turn", () => {
    const info = provider({ strategy: "roundRobin" })
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, turn: "t1", now })?.id).toBe("one")
    // repeated calls in the same turn (retries, nested work) keep the account
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, turn: "t1", now })?.id).toBe("one")
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, turn: "t2", now })?.id).toBe("two")
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, turn: "t3", now })?.id).toBe("three")
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, turn: "t4", now })?.id).toBe("one")
  })

  test("round robin skips disabled and cooling accounts", () => {
    const info = provider({
      strategy: "roundRobin",
      accounts: [
        { id: "one", enabled: false },
        { id: "two" },
        { id: "three", status: "cooling", cooldownUntil: now + 10_000 },
      ],
    })
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, turn: "t1", now })?.id).toBe("two")
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, turn: "t2", now })?.id).toBe("two")
  })

  test("keeps a single cooling account in use instead of locking the provider out", () => {
    const info = provider({
      strategy: "failover",
      accounts: [{ id: "one", status: "cooling", cooldownUntil: now + 60_000 }],
    })
    const accounts = KiloProviderAccounts.settings(info)?.accounts ?? []
    // The selector skips it, but the provider still resolves it rather than failing.
    expect(KiloProviderAccounts.available("p", accounts, now)).toEqual([])
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, now })?.id).toBe("one")
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, now: now + 61_000 })?.id).toBe("one")
  })

  test("reads the quota a provider reports", () => {
    expect(KiloProviderAccounts.quota({ "x-ratelimit-remaining": "7", "x-ratelimit-limit": "100" })).toEqual({
      remaining: 7,
      limit: 100,
    })
    expect(KiloProviderAccounts.quota({ "anthropic-ratelimit-requests-remaining": "0" })).toEqual({ remaining: 0 })
    expect(KiloProviderAccounts.quota({ "x-ratelimit-remaining-requests": "3" })?.remaining).toBe(3)
    expect(KiloProviderAccounts.quota({})).toBeUndefined()
    // Resets arrive as a wait, a duration or an epoch.
    const wait = KiloProviderAccounts.quota({ "x-ratelimit-reset": "30" })?.resetAt ?? 0
    expect(wait - Date.now()).toBeGreaterThan(28_000)
    expect(wait - Date.now()).toBeLessThan(32_000)
    const duration = KiloProviderAccounts.quota({ "anthropic-ratelimit-requests-reset": "1m30s" })?.resetAt ?? 0
    expect(duration - Date.now()).toBeGreaterThan(88_000)
    expect(duration - Date.now()).toBeLessThan(92_000)
    expect(KiloProviderAccounts.quota({ "x-ratelimit-reset-requests": "1700000000" })?.resetAt).toBe(1_700_000_000_000)
    expect(KiloProviderAccounts.quota({ "x-ratelimit-reset": "1700000000000" })?.resetAt).toBe(1_700_000_000_000)
    // Anthropic sends a timestamp, and error detail headers keep their wire casing.
    const soon = new Date(Date.now() + 3_600_000).toISOString()
    expect(KiloProviderAccounts.quota({ "Anthropic-Ratelimit-Requests-Reset": soon })?.resetAt).toBe(Date.parse(soon))
    // A broken header cannot hide an account for longer than the guard.
    const huge = KiloProviderAccounts.quota({ "x-ratelimit-reset": "999999999999" })?.resetAt ?? 0
    expect(huge - Date.now()).toBeGreaterThan(29 * 86_400_000)
    expect(huge - Date.now()).toBeLessThanOrEqual(30 * 86_400_000)
  })

  test("labels a merged account without colliding with a default", () => {
    const merged = KiloProviderAccounts.mergeAccounts(
      [{ id: "one", label: "Account 2", key: "sk-one" }],
      [{ id: "one", label: "Account 2" }, { key: "sk-two" }],
    )
    expect(merged.map((item) => item.label)).toEqual(["Account 2", "Account 3"])
  })

  test("skips an account whose quota is spent until it resets", () => {
    const info = provider({
      strategy: "failover",
      accounts: [{ id: "one", quota: { remaining: 0, limit: 40, resetAt: now + 60_000 } }, { id: "two" }],
    })
    const accounts = KiloProviderAccounts.settings(info)?.accounts ?? []
    expect(KiloProviderAccounts.available("p", accounts, now).map((item) => item.id)).toEqual(["two"])
    expect(KiloProviderAccounts.available("p", accounts, now + 61_000).map((item) => item.id)).toEqual(["one", "two"])
  })

  test("stores the quota a throttled turn reported", () => {
    const info = provider({ strategy: "failover", active: "one" })
    KiloProviderAccounts.resolve({ providerID: "p", info, now })
    const result = KiloProviderAccounts.failure({
      providerID: "p",
      error: {
        data: { statusCode: 429, responseHeaders: { "retry-after": "30", "x-ratelimit-remaining": "0" } },
      },
      now,
    })
    expect(result?.state.quota?.remaining).toBe(0)
  })

  test("caps the cooldown a failed turn stores", () => {
    const info = provider({ strategy: "failover", active: "one" })
    KiloProviderAccounts.resolve({ providerID: "p", info, now })
    const state = KiloProviderAccounts.failure({
      providerID: "p",
      error: { data: { statusCode: 429, responseHeaders: { "retry-after": "86400" } } },
      now,
    })
    expect(state?.state.cooldownUntil).toBe(now + 3_600_000)
    // Failover skips the account until the capped window ends, then offers it again.
    const accounts = KiloProviderAccounts.settings(info)?.accounts ?? []
    expect(KiloProviderAccounts.available("p", accounts, now + 3_599_000).map((item) => item.id)).toEqual([
      "two",
      "three",
    ])
    expect(KiloProviderAccounts.available("p", accounts, now + 3_601_000).map((item) => item.id)).toEqual([
      "one",
      "two",
      "three",
    ])
  })

  test("caps the wait a provider advertises", () => {
    // A day-long retry-after cannot bench a key longer than an hour.
    expect(KiloProviderAccounts.wait("86400")).toBe(3_600_000)
    expect(KiloProviderAccounts.wait("2")).toBe(2_000)
    expect(KiloProviderAccounts.wait("soon")).toBeUndefined()
    expect(KiloProviderAccounts.wait(undefined)).toBeUndefined()
    const until = KiloProviderAccounts.verified("rateLimited", 86_400_000)?.cooldownUntil ?? 0
    expect(until).toBeGreaterThan(Date.now() + 3_500_000)
    expect(until).toBeLessThan(Date.now() + 3_700_000)
  })

  test("falls back to the active account when nothing is usable", () => {
    const info = provider({
      strategy: "failover",
      active: "two",
      accounts: [
        { id: "one", enabled: false },
        { id: "two", enabled: false },
      ],
    })
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, now })?.id).toBe("two")
  })

  test("ignores providers that are not API-key based", () => {
    expect(KiloProviderAccounts.settings({ type: "oauth", access: "a", refresh: "r", expires: 1 })).toBeUndefined()
    expect(KiloProviderAccounts.resolve({ providerID: "kilo", info: undefined })).toBeUndefined()
  })

  test("only auth and quota statuses trigger failover", () => {
    const info = provider({ strategy: "failover" })
    KiloProviderAccounts.resolve({ providerID: "p", info, now })
    expect(KiloProviderAccounts.failed({ providerID: "p", error: { data: { statusCode: 500 } }, now })).toBe(false)
    expect(KiloProviderAccounts.failed({ providerID: "p", error: "not an error", now })).toBe(false)
    expect(KiloProviderAccounts.failed({ providerID: "unknown", error: unauthorized(), now })).toBe(false)
  })

  test("masks keys down to the last four characters", () => {
    expect(KiloProviderAccounts.maskKey("sk-live-123456")).toBe("••••3456")
    expect(KiloProviderAccounts.maskKey("abc")).toBe("••••")
    expect(KiloProviderAccounts.maskKey("    ")).toBe("••••")
  })

  test("classifies verification responses", () => {
    expect(KiloProviderAccounts.classify(200)).toBe("ok")
    expect(KiloProviderAccounts.classify(401)).toBe("invalid")
    expect(KiloProviderAccounts.classify(403)).toBe("invalid")
    expect(KiloProviderAccounts.classify(402)).toBe("rateLimited")
    expect(KiloProviderAccounts.classify(429)).toBe("rateLimited")
    expect(KiloProviderAccounts.classify(500)).toBe("unknown")
    expect(KiloProviderAccounts.classify(undefined)).toBe("unknown")
  })

  test("merges account edits without inventing keys", () => {
    const stored = [
      { id: "one", label: "Team A", key: "sk-one", status: "cooling" as const, cooldownUntil: 42 },
      { id: "two", label: "Team B", key: "sk-two" },
    ]
    const merged = KiloProviderAccounts.mergeAccounts(
      stored,
      [
        { id: "one", label: "Renamed" },
        { id: "two", key: "sk-two-new" },
        { label: "Team C", key: "sk-three" },
        { label: "no key" },
      ],
      () => "generated",
    )

    expect(merged.map((item) => item.id)).toEqual(["one", "two", "generated"])
    expect(merged[0]?.label).toBe("Renamed")
    expect(merged[0]?.key).toBe("sk-one")
    // a kept key keeps its failure state, a replaced key starts clean
    expect(merged[0]?.status).toBe("cooling")
    expect(merged[1]?.key).toBe("sk-two-new")
    expect(merged[1]?.status).toBeUndefined()
    expect(merged[2]?.label).toBe("Team C")
  })

  test("credential returns the legacy shape for the selected account", () => {
    const info = provider({ active: "two" })
    const account = KiloProviderAccounts.resolve({ providerID: "p", info, now })!
    const credential = KiloProviderAccounts.credential(info, account)
    expect(credential?.type).toBe("api")
    if (credential?.type !== "api") return
    expect(credential.key).toBe("sk-two")
    expect(credential.active).toBe("two")
  })

  test("verified maps a probe result to the account state to persist", () => {
    expect(KiloProviderAccounts.verified("ok")).toEqual({ status: "ok", cooldownUntil: null })
    expect(KiloProviderAccounts.verified("invalid")).toEqual({ status: "invalid" })
    expect(KiloProviderAccounts.verified("unknown")).toBeUndefined()
    // A rate limit benches the account for the advertised wait, like a failed turn.
    expect(KiloProviderAccounts.verified("rateLimited", 5_000)?.cooldownUntil).toBeGreaterThan(Date.now())
    const state = KiloProviderAccounts.verified("rateLimited", 5_000)
    expect(state?.status).toBe("cooling")
    const until = state?.cooldownUntil
    expect(until).toBeGreaterThan(Date.now() + 3_000)
    expect(until).toBeLessThan(Date.now() + 7_000)
  })

  test("failure reports the state to persist and leaves other errors alone", () => {
    const info = provider({ strategy: "failover", active: "one" })
    expect(KiloProviderAccounts.resolve({ providerID: "p", info, now })?.id).toBe("one")
    expect(KiloProviderAccounts.failure({ providerID: "p", error: unauthorized(), now })).toEqual({
      accountID: "one",
      state: { status: "invalid" },
    })
    expect(KiloProviderAccounts.failure({ providerID: "p", error: rateLimited(), now })).toEqual({
      accountID: "one",
      state: { status: "cooling", cooldownUntil: now + 30_000 },
    })
    expect(KiloProviderAccounts.failure({ providerID: "p", error: { data: { statusCode: 500 } }, now })).toBeUndefined()
  })

  test("turnAccount reports the account that served a turn", () => {
    const info = provider({ strategy: "roundRobin" })
    const picked = KiloProviderAccounts.resolve({ providerID: "p", info, turn: "turn-1", now })
    expect(KiloProviderAccounts.turnAccount("turn-1", "p")).toBe(picked?.id)
    expect(KiloProviderAccounts.turnAccount("turn-2", "p")).toBeUndefined()
  })
})
