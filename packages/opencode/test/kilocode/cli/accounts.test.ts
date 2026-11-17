import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { accountsOf, type Account, type Interface, type Info } from "../../../src/auth"
import {
  activate,
  add,
  enable,
  list,
  pick,
  remove,
  replaceKey,
  strategy,
  verify,
  verifyAll,
  view,
} from "../../../src/kilocode/cli/accounts"
import { KiloProviderProbe } from "../../../src/kilocode/provider/probe"

const account = (id: string, label: string, key: string, extra: Partial<Account> = {}): Account => ({
  id,
  label,
  key,
  ...extra,
})

function seed(
  accounts: Account[],
  input: { active?: string; strategy?: "manual" | "failover" | "roundRobin" } = {},
): Info {
  return {
    type: "api",
    key: accounts[0]!.key,
    accounts,
    active: input.active ?? accounts[0]!.id,
    strategy: input.strategy ?? "manual",
  } as Info
}

/** In-memory credential store with the same account semantics as Auth.Service. */
function memory(data: Record<string, Info>) {
  const api: Interface = {
    get: (providerID) => Effect.succeed(data[providerID]),
    all: () => Effect.succeed(data),
    set: (providerID, info) =>
      Effect.sync(() => {
        data[providerID] = info
      }),
    remove: (providerID) =>
      Effect.sync(() => {
        delete data[providerID]
      }),
    accounts: (providerID) => Effect.succeed(accountsOf(data[providerID])),
    setAccounts: (providerID, input) =>
      Effect.sync(() => {
        const current = data[providerID]
        const active =
          input.accounts.find((item) => item.id === input.active) ??
          (current?.type === "api" ? input.accounts.find((item) => item.id === current.active) : undefined) ??
          input.accounts[0]
        if (!active) return
        data[providerID] = {
          ...(current?.type === "api" ? current : {}),
          type: "api",
          key: active.key,
          metadata: active.metadata,
          accounts: [...input.accounts],
          active: active.id,
          strategy: input.strategy ?? (current?.type === "api" ? current.strategy : undefined) ?? "manual",
        } as Info
      }),
    edit: (providerID, change, options) =>
      Effect.sync(() => {
        const current = data[providerID]
        const accounts = change(accountsOf(current))
        if (accounts.length === 0) return
        const active =
          accounts.find((item) => item.id === options?.active) ??
          accounts.find((item) => item.id === (current?.type === "api" ? current.active : undefined)) ??
          accounts[0]!
        data[providerID] = {
          ...(current?.type === "api" ? current : {}),
          type: "api",
          key: active.key,
          metadata: active.metadata,
          accounts: [...accounts],
          active: active.id,
          strategy: options?.strategy ?? (current?.type === "api" ? current.strategy : undefined) ?? "manual",
        } as Info
      }),
    markAccount: (providerID, accountID, state) =>
      Effect.sync(() => {
        const current = data[providerID]
        if (current?.type !== "api" || !current.accounts) return
        const accounts = current.accounts.map((item) => {
          if (item.id !== accountID) return item
          const next = { ...item }
          if (state.status !== undefined) next.status = state.status
          if (state.cooldownUntil === null) delete next.cooldownUntil
          else if (state.cooldownUntil !== undefined) next.cooldownUntil = state.cooldownUntil
          return next
        })
        data[providerID] = { ...current, accounts }
      }),
  }
  return { data, api }
}

/** Replace global fetch for the duration of one probe and record the URLs it saw. */
function stub(fn: (url: string) => Response) {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    try {
      return Promise.resolve(fn(url))
    } catch (error) {
      // fetch rejects on network errors; mirror that instead of throwing synchronously.
      return Promise.reject(error)
    }
  }) as unknown as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const error = (effect: Effect.Effect<unknown, { message: string }>) => Effect.runPromise(Effect.flip(effect))

describe("kilo auth account", () => {
  test("masks keys and reports the active account and strategy", () => {
    const payload = view(
      "groq",
      seed(
        [
          account("a", "Team A", "gsk_secret_0001", {
            usage: { input: 100, output: 50, cost: 0.25, turns: 3, updatedAt: 7 },
          }),
          account("b", "Team B", "gsk_secret_0002"),
        ],
        {
          active: "b",
          strategy: "failover",
        },
      ),
    )

    expect(payload.providerID).toBe("groq")
    expect(payload.active).toBe("b")
    expect(payload.strategy).toBe("failover")
    expect(payload.accounts.map((item) => item.maskedKey)).toEqual(["••••0001", "••••0002"])
    expect(payload.accounts[0]?.usage).toMatchObject({ turns: 3, cost: 0.25 })
    expect(JSON.stringify(payload)).not.toContain("gsk_secret")
  })

  test("resolves accounts by id or label", () => {
    const accounts = [account("a", "Team A", "k1"), account("b", "Team B", "k2")]

    expect(pick(accounts, "b")?.label).toBe("Team B")
    expect(pick(accounts, "team a")?.id).toBe("a")
    expect(pick(accounts, "missing")).toBeUndefined()
  })

  test("list fails for a provider without API-key accounts", async () => {
    const failure = await error(list(memory({}).api, "groq"))
    expect(failure.message).toContain("No API-key accounts")
  })

  test("add creates the provider entry when no account exists yet", async () => {
    const store = memory({})

    const payload = await Effect.runPromise(add(store.api, { providerID: "groq", key: "gsk_a_0001" }))

    expect(payload.accounts.map((item) => item.label)).toEqual(["Account 1"])
    expect(payload.active).toBe(payload.accounts[0]?.id)
    expect(accountsOf(store.data.groq).map((item) => item.key)).toEqual(["gsk_a_0001"])
  })

  test("add appends an account without changing the active one", async () => {
    const store = memory({ groq: seed([account("a", "Team A", "gsk_a_0001")]) })

    const payload = await Effect.runPromise(add(store.api, { providerID: "groq", key: "gsk_b_0002" }))

    expect(payload.accounts.map((item) => item.label)).toEqual(["Team A", "Account 2"])
    expect(payload.active).toBe("a")
    expect(accountsOf(store.data.groq).map((item) => item.key)).toEqual(["gsk_a_0001", "gsk_b_0002"])
  })

  test("add keeps an explicit label", async () => {
    const store = memory({ groq: seed([account("a", "Team A", "gsk_a_0001")]) })

    const payload = await Effect.runPromise(add(store.api, { providerID: "groq", key: "gsk_b_0002", label: "Team B" }))

    expect(payload.accounts.map((item) => item.label)).toEqual(["Team A", "Team B"])
  })

  test("add rejects a label that is already used", async () => {
    const store = memory({ groq: seed([account("a", "Team A", "gsk_a_0001")]) })

    const failure = await error(add(store.api, { providerID: "groq", key: "gsk_b_0002", label: "team a" }))

    expect(failure.message).toContain('An account labelled "team a" already exists.')
    expect(accountsOf(store.data.groq)).toHaveLength(1)
  })

  test("add skips taken default labels", async () => {
    const store = memory({ groq: seed([account("a", "Account 2", "gsk_a_0001")]) })

    const payload = await Effect.runPromise(add(store.api, { providerID: "groq", key: "gsk_b_0002" }))

    expect(payload.accounts.map((item) => item.label)).toEqual(["Account 2", "Account 3"])
  })

  test("add rejects a provider that does not use API keys", async () => {
    const store = memory({
      kilo: { type: "oauth", refresh: "r", access: "a", expires: 1 },
    })

    const failure = await error(add(store.api, { providerID: "kilo", key: "gsk_a_0001" }))

    expect(failure.message).toContain("does not use API-key authentication")
  })

  test("remove drops the account and moves the active marker", async () => {
    const store = memory({
      groq: seed([account("a", "Team A", "gsk_a_0001"), account("b", "Team B", "gsk_b_0002")], { active: "a" }),
    })

    const payload = await Effect.runPromise(remove(store.api, { providerID: "groq", query: "Team A" }))

    expect(payload.accounts.map((item) => item.id)).toEqual(["b"])
    expect(payload.active).toBe("b")
  })

  test("remove refuses to drop the last account", async () => {
    const store = memory({ groq: seed([account("a", "Team A", "gsk_a_0001")]) })

    const failure = await error(remove(store.api, { providerID: "groq", query: "a" }))

    expect(failure.message).toContain("Cannot remove the last account")
    expect(accountsOf(store.data.groq)).toHaveLength(1)
  })

  test("activate switches the active account", async () => {
    const store = memory({
      groq: seed([account("a", "Team A", "gsk_a_0001"), account("b", "Team B", "gsk_b_0002")]),
    })

    const payload = await Effect.runPromise(activate(store.api, { providerID: "groq", query: "Team B" }))

    expect(payload.active).toBe("b")
    expect(accountsOf(store.data.groq).map((item) => item.key)).toEqual(["gsk_a_0001", "gsk_b_0002"])
  })

  test("strategy persists without switching accounts", async () => {
    const store = memory({
      groq: seed([account("a", "Team A", "gsk_a_0001"), account("b", "Team B", "gsk_b_0002")], { active: "b" }),
    })

    const payload = await Effect.runPromise(strategy(store.api, { providerID: "groq", strategy: "roundRobin" }))

    expect(payload.strategy).toBe("roundRobin")
    expect(payload.active).toBe("b")
  })

  test("strategy rejects an unknown value", async () => {
    const store = memory({ groq: seed([account("a", "Team A", "gsk_a_0001")]) })

    const failure = await error(strategy(store.api, { providerID: "groq", strategy: "random" }))

    expect(failure.message).toContain("Unknown strategy")
  })

  test("verify persists health for the probed account only", async () => {
    const store = memory({
      groq: seed([account("a", "Team A", "gsk_a_0001"), account("b", "Team B", "gsk_b_0002", { status: "invalid" })]),
    })

    const accepted = stub(() => new Response("", { status: 200 }))
    try {
      const ok = await Effect.runPromise(
        verify(store.api, { providerID: "groq", query: "Team A", url: "https://api.groq.test/v1" }),
      )
      expect(ok).toMatchObject({ accountID: "a", status: "ok", httpStatus: 200 })
      expect(accepted.calls).toEqual(["https://api.groq.test/v1/models"])
    } finally {
      accepted.restore()
    }
    expect(accountsOf(store.data.groq).find((item) => item.id === "a")?.status).toBe("ok")
    expect(accountsOf(store.data.groq).find((item) => item.id === "b")?.status).toBe("invalid")

    const rejected = stub(() => new Response("", { status: 401 }))
    try {
      const invalid = await Effect.runPromise(
        verify(store.api, { providerID: "groq", query: "Team A", url: "https://api.groq.test/v1" }),
      )
      expect(invalid.status).toBe("invalid")
    } finally {
      rejected.restore()
    }
    expect(accountsOf(store.data.groq).find((item) => item.id === "a")?.status).toBe("invalid")
  })

  test("verify without a model endpoint reports unknown and keeps stored health", async () => {
    const store = memory({ groq: seed([account("a", "Team A", "gsk_a_0001", { status: "ok" })]) })
    const net = stub(() => new Response("", { status: 200 }))
    try {
      const payload = await Effect.runPromise(verify(store.api, { providerID: "groq", query: "Team A" }))
      expect(payload.status).toBe("unknown")
      expect(net.calls).toHaveLength(0)
    } finally {
      net.restore()
    }
    expect(accountsOf(store.data.groq)[0]?.status).toBe("ok")
  })

  test("enable and disable toggle only that account", async () => {
    const store = memory({
      groq: seed([account("a", "Team A", "gsk_a_0001"), account("b", "Team B", "gsk_b_0002")]),
    })

    const off = await Effect.runPromise(enable(store.api, { providerID: "groq", query: "Team A", enabled: false }))
    expect(off.accounts.find((item) => item.id === "a")?.enabled).toBe(false)
    expect(off.accounts.find((item) => item.id === "b")?.enabled).toBe(true)

    const on = await Effect.runPromise(enable(store.api, { providerID: "groq", query: "Team A", enabled: true }))
    expect(on.accounts.find((item) => item.id === "a")?.enabled).toBe(true)
  })

  test("verifyAll checks every account and reports each status", async () => {
    const store = memory({
      groq: seed([account("a", "Team A", "gsk_a_0001"), account("b", "Team B", "gsk_b_0002")]),
    })
    const net = stub(() => new Response("", { status: 200 }))
    try {
      const checks = await Effect.runPromise(
        verifyAll(store.api, { providerID: "groq", url: "https://api.groq.test/v1" }),
      )
      expect(checks.map((item) => item.status)).toEqual(["ok", "ok"])
      expect(net.calls).toHaveLength(2)
    } finally {
      net.restore()
    }
  })

  test("an account edit keeps health written by a running server", async () => {
    const store = memory({ groq: seed([account("a", "Team A", "gsk_a_0001")]) })
    await Effect.runPromise(store.api.markAccount!("groq", "a", { status: "cooling", cooldownUntil: 5 }))

    await Effect.runPromise(add(store.api, { providerID: "groq", key: "gsk_b_0002" }))

    expect(accountsOf(store.data.groq)[0]).toMatchObject({ status: "cooling", cooldownUntil: 5 })
  })

  test("login --account replaces only that account's key and clears its health", async () => {
    const store = memory({
      groq: seed([
        account("a", "Team A", "gsk_old_0001", { status: "invalid", cooldownUntil: 1 }),
        account("b", "Team B", "gsk_b_0002"),
      ]),
    })

    await Effect.runPromise(replaceKey({ auth: store.api, providerID: "groq", query: "Team A", key: "gsk_new_0001" }))

    const stored = accountsOf(store.data.groq)
    expect(stored.map((item) => item.key)).toEqual(["gsk_new_0001", "gsk_b_0002"])
    expect(stored[0]?.status).toBeUndefined()
    expect(stored[0]?.cooldownUntil).toBeUndefined()
  })

  test("login --account rejects an unknown account", async () => {
    const store = memory({ groq: seed([account("a", "Team A", "gsk_a_0001")]) })

    const failure = await error(
      replaceKey({ auth: store.api, providerID: "groq", query: "Team Z", key: "gsk_new_0001" }),
    )

    expect(failure.message).toContain('Unknown account "Team Z"')
  })
})

describe("provider probe", () => {
  test("normalizes the model endpoint", () => {
    expect(KiloProviderProbe.endpoint("https://api.example.com/v1/")).toBe("https://api.example.com/v1/models")
    expect(KiloProviderProbe.endpoint("https://api.example.com/v1/models")).toBe("https://api.example.com/v1/models")
  })

  test("uses provider-specific authentication headers", () => {
    expect(KiloProviderProbe.headers("anthropic", "k")["x-api-key"]).toBe("k")
    expect(KiloProviderProbe.headers("google", "k")["x-goog-api-key"]).toBe("k")
    expect(KiloProviderProbe.headers("groq", "k").authorization).toBe("Bearer k")
  })

  test("reports unknown when the endpoint cannot be reached", async () => {
    const net = stub(() => {
      throw new Error("offline")
    })
    try {
      expect(await KiloProviderProbe.probe({ providerID: "groq", key: "k", url: "https://api.groq.test/v1" })).toEqual({
        status: "unknown",
      })
    } finally {
      net.restore()
    }
  })
})
