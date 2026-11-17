// kilocode_change - new file
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { readdir, readFile, stat } from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))
const id = `accounts-test-${process.pid}`
const file = path.join(Global.Path.data, "auth.json")

async function snapshot() {
  return {
    entries: await readdir(Global.Path.data),
    mode: (await stat(file)).mode & 0o777,
    raw: JSON.parse(await readFile(file, "utf8")) as Record<string, { accounts?: unknown[] }>,
  }
}

describe("Auth accounts", () => {
  it.instance("materializes a default account for a legacy single-key entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set(id, {
        type: "api",
        key: "sk-legacy",
        metadata: { baseURL: "https://example.test" },
      })
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      expect(info?.type).toBe("api")
      if (info?.type !== "api") return
      expect(info.active).toBe(Auth.DEFAULT_ACCOUNT)
      expect(info.strategy).toBe("manual")
      expect(info.accounts).toHaveLength(1)
      expect(info.accounts?.[0]?.key).toBe("sk-legacy")
      expect(info.accounts?.[0]?.metadata?.baseURL).toBe("https://example.test")
      expect(Auth.usable(info.accounts![0]!)).toBe(true)
    }),
  )

  it.instance("setAccounts keeps key and metadata mirrored to the active account", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set(id, { type: "api", key: "sk-one" })
      yield* auth.setAccounts!(id, {
        accounts: [
          { id: "one", label: "Team A", key: "sk-one" },
          { id: "two", label: "Team B", key: "sk-two", metadata: { region: "eu" } },
        ],
        active: "two",
        strategy: "failover",
      })
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      expect(info?.type).toBe("api")
      if (info?.type !== "api") return
      expect(info.key).toBe("sk-two")
      expect(info.metadata).toEqual({ region: "eu" })
      expect(info.active).toBe("two")
      expect(info.strategy).toBe("failover")
      expect(info.accounts?.map((item) => item.id)).toEqual(["one", "two"])
    }),
  )

  it.instance("setAccounts keeps the active account when the caller does not pick one", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.setAccounts!(id, {
        accounts: [
          { id: "one", label: "Team A", key: "sk-one" },
          { id: "two", label: "Team B", key: "sk-two" },
        ],
        active: "two",
      })
      yield* auth.setAccounts!(id, {
        accounts: [
          { id: "one", label: "Team A", key: "sk-one" },
          { id: "two", label: "Team B", key: "sk-two" },
        ],
        strategy: "roundRobin",
      })
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      expect(info?.type).toBe("api")
      if (info?.type !== "api") return
      expect(info.active).toBe("two")
      expect(info.strategy).toBe("roundRobin")
      expect(info.key).toBe("sk-two")
    }),
  )

  it.instance("activate switches the mirrored credential", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.setAccounts!(id, {
        accounts: [
          { id: "one", label: "Team A", key: "sk-one" },
          { id: "two", label: "Team B", key: "sk-two" },
        ],
        active: "one",
      })
      yield* auth.activate!(id, "two")
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      expect(info?.type).toBe("api")
      if (info?.type !== "api") return
      expect(info.active).toBe("two")
      expect(info.key).toBe("sk-two")
    }),
  )

  it.instance("markAccount records cooldowns and invalid keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.setAccounts!(id, {
        accounts: [
          { id: "one", label: "Team A", key: "sk-one" },
          { id: "two", label: "Team B", key: "sk-two" },
        ],
        active: "one",
      })
      yield* auth.markAccount!(id, "one", { status: "cooling", cooldownUntil: Date.now() + 60_000 })
      yield* auth.markAccount!(id, "two", { status: "invalid" })
      const accounts = yield* auth.accounts!(id)
      yield* auth.remove(id)

      const one = accounts.find((item) => item.id === "one")
      const two = accounts.find((item) => item.id === "two")
      expect(one?.status).toBe("cooling")
      expect(two?.status).toBe("invalid")
      expect(Auth.usable(one!)).toBe(false)
      expect(Auth.usable(two!)).toBe(false)
    }),
  )

  it.instance("creates the credential entry for a provider that has no stored key yet", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.setAccounts!(id, { accounts: [{ id: "one", label: "Team A", key: "sk-one" }] })
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      expect(info?.type).toBe("api")
      if (info?.type !== "api") return
      expect(info.key).toBe("sk-one")
      expect(info.active).toBe("one")
      expect(info.accounts).toHaveLength(1)
    }),
  )

  it.instance("leaves OAuth entries untouched", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set(id, { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 })
      yield* auth.setAccounts!(id, { accounts: [{ id: "one", label: "Team A", key: "sk-one" }] })
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      expect(info?.type).toBe("oauth")
    }),
  )

  it.instance("set keeps the account list and replaces only the active key", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.setAccounts!(id, {
        accounts: [
          { id: "one", label: "Team A", key: "sk-one", metadata: { region: "eu" } },
          { id: "two", label: "Team B", key: "sk-two" },
        ],
        active: "two",
        strategy: "roundRobin",
      })
      yield* auth.set(id, { type: "api", key: "sk-rotated" })
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      expect(info?.type).toBe("api")
      if (info?.type !== "api") return
      expect(info.active).toBe("two")
      expect(info.strategy).toBe("roundRobin")
      expect(info.key).toBe("sk-rotated")
      expect(info.accounts?.map((item) => [item.id, item.label, item.key])).toEqual([
        ["one", "Team A", "sk-one"],
        ["two", "Team B", "sk-rotated"],
      ])
      expect(info.accounts?.[0]?.metadata?.region).toBe("eu")
    }),
  )

  it.instance("set clears only the replaced credential's status", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.setAccounts!(id, {
        accounts: [
          { id: "one", label: "Team A", key: "sk-one" },
          { id: "two", label: "Team B", key: "sk-two" },
        ],
        active: "one",
      })
      yield* auth.markAccount!(id, "one", { status: "cooling", cooldownUntil: Date.now() + 60_000 })
      yield* auth.markAccount!(id, "two", { status: "invalid" })
      yield* auth.set(id, { type: "api", key: "sk-new" })
      const accounts = yield* auth.accounts!(id)
      yield* auth.remove(id)

      const one = accounts.find((item) => item.id === "one")
      const two = accounts.find((item) => item.id === "two")
      expect(one?.key).toBe("sk-new")
      expect(one?.status).toBeUndefined()
      expect(one?.cooldownUntil).toBeUndefined()
      expect(two?.status).toBe("invalid")
      expect(two?.key).toBe("sk-two")
    }),
  )

  it.instance("set with an explicit account list replaces the stored accounts", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.setAccounts!(id, {
        accounts: [
          { id: "one", label: "Team A", key: "sk-one" },
          { id: "two", label: "Team B", key: "sk-two" },
        ],
        active: "one",
      })
      yield* auth.set(id, {
        type: "api",
        key: "sk-three",
        accounts: [{ id: "three", label: "Team C", key: "sk-three" }],
        active: "three",
      })
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      expect(info?.type).toBe("api")
      if (info?.type !== "api") return
      expect(info.accounts?.map((item) => item.id)).toEqual(["three"])
      expect(info.active).toBe("three")
      expect(info.key).toBe("sk-three")
    }),
  )

  it.instance("markAccount merges reported quota fields", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.setAccounts!(id, { accounts: [{ id: "one", label: "Team A", key: "sk-one" }] })
      yield* auth.markAccount!(id, "one", { quota: { limit: 100, remaining: 10 } })
      yield* auth.markAccount!(id, "one", { quota: { remaining: 0 } })
      const account = (yield* auth.accounts!(id)).find((item) => item.id === "one")
      yield* auth.remove(id)

      // A report without a limit must not drop the one of the same window.
      expect(account?.quota).toEqual({ limit: 100, remaining: 0 })
    }),
  )

  it.instance("markAccount stores the last use and clears a cooldown", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.setAccounts!(id, {
        accounts: [
          { id: "one", label: "Team A", key: "sk-one" },
          { id: "two", label: "Team B", key: "sk-two" },
        ],
        active: "one",
      })
      yield* auth.markAccount!(id, "one", { status: "cooling", cooldownUntil: Date.now() + 60_000 })
      yield* auth.markAccount!(id, "one", { status: "ok", cooldownUntil: null, lastUsedAt: 1234 })
      const accounts = yield* auth.accounts!(id)
      yield* auth.remove(id)

      const one = accounts.find((item) => item.id === "one")
      expect(one?.status).toBe("ok")
      expect(one?.cooldownUntil).toBeUndefined()
      expect(one?.lastUsedAt).toBe(1234)
    }),
  )

  it.instance("writes auth.json atomically without leaving temp files behind", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set(id, { type: "api", key: "sk-atomic" })
      const before = yield* Effect.promise(snapshot)
      yield* auth.remove(id)

      expect(
        before.entries.filter((name) => name.startsWith(`${path.basename(file)}.`) && name.endsWith(".tmp")),
      ).toEqual([])
      expect(before.mode).toBe(0o600)
      expect(before.raw[id]?.accounts).toHaveLength(1)
    }),
  )

  it.instance("markAccount accumulates usage and keeps other fields", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set(id, { type: "api", key: "sk-one" })
      yield* auth.setAccounts!(id, {
        accounts: [
          { id: "one", label: "Team A", key: "sk-one" },
          { id: "two", label: "Team B", key: "sk-two" },
        ],
        active: "one",
      })
      yield* auth.markAccount!(id, "one", { usage: { input: 10, output: 5, cost: 0.5, turns: 1 } })
      yield* auth.markAccount!(id, "one", { usage: { input: 20, output: 5, cost: 0.25, turns: 1 } })
      yield* auth.markAccount!(id, "one", { status: "ok" })
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      if (info?.type !== "api") return
      const account = info.accounts?.find((item) => item.id === "one")
      expect(account?.usage).toMatchObject({ input: 30, output: 10, cost: 0.75, turns: 2 })
      expect(account?.usage?.updatedAt).toBeGreaterThan(0)
      expect(account?.status).toBe("ok")
      expect(info.accounts?.find((item) => item.id === "two")?.usage).toBeUndefined()
    }),
  )

  it.instance("edit applies to the latest account list and keeps health", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set(id, { type: "api", key: "sk-one" })
      yield* auth.markAccount!(id, Auth.DEFAULT_ACCOUNT, { status: "cooling", cooldownUntil: 123 })
      yield* auth.edit!(id, (accounts) => [...accounts, { id: "extra", label: "Extra", key: "sk-extra" }])
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      if (info?.type !== "api") return
      expect(info.accounts).toHaveLength(2)
      expect(info.accounts?.find((item) => item.id === Auth.DEFAULT_ACCOUNT)?.status).toBe("cooling")
      expect(info.active).toBe(Auth.DEFAULT_ACCOUNT)
    }),
  )

  it.instance("keeps both writes when an edit and a status update run at the same time", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set(id, { type: "api", key: "sk-one" })
      yield* Effect.all(
        [
          auth.edit!(id, (accounts) => [...accounts, { id: "added", label: "Added", key: "sk-added" }]),
          auth.markAccount!(id, Auth.DEFAULT_ACCOUNT, { status: "invalid" }),
        ],
        { concurrency: "unbounded" },
      )
      const info = yield* auth.get(id)
      yield* auth.remove(id)

      if (info?.type !== "api") return
      expect(info.accounts?.map((item) => item.id).sort()).toEqual(["added", Auth.DEFAULT_ACCOUNT].sort())
      expect(info.accounts?.find((item) => item.id === Auth.DEFAULT_ACCOUNT)?.status).toBe("invalid")
    }),
  )
})
