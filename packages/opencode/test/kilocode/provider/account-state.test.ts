import { beforeEach, describe, expect, test } from "bun:test"
import { KiloAccountState } from "../../../src/kilocode/provider/account-state"

type Write = {
  providerID: string
  accountID: string
  state: Record<string, unknown>
}

const writes: Write[] = []

beforeEach(() => {
  writes.length = 0
  KiloAccountState.reset()
  KiloAccountState.useWriter(async (entry) => {
    writes.push({ providerID: entry.providerID, accountID: entry.accountID, state: { ...entry.state } })
  })
})

describe("provider account state writer", () => {
  test("adds usage deltas into one write", async () => {
    KiloAccountState.spend("p", "one", { input: 10, output: 5, cost: 0.5 })
    KiloAccountState.spend("p", "one", { input: 20, output: 1, cost: 0.25 })
    await KiloAccountState.flush()

    expect(writes).toHaveLength(1)
    expect(writes[0]?.state.usage).toEqual({ input: 30, output: 6, cost: 0.75, turns: 2 })
  })

  test("coalesces changes for one account into a single write", async () => {
    KiloAccountState.record("p", "one", { status: "cooling" })
    KiloAccountState.record("p", "one", { status: "invalid" })
    await KiloAccountState.flush()

    expect(writes).toHaveLength(1)
    expect(writes[0]?.providerID).toBe("p")
    expect(writes[0]?.accountID).toBe("one")
    expect(writes[0]?.state).toEqual({ status: "invalid" })
  })

  test("writes accounts separately", async () => {
    KiloAccountState.record("p", "one", { status: "invalid" })
    KiloAccountState.record("p", "two", { status: "cooling", cooldownUntil: 42 })
    await KiloAccountState.flush()

    expect(writes.map((item) => [item.accountID, item.state])).toEqual([
      ["one", { status: "invalid" }],
      ["two", { status: "cooling", cooldownUntil: 42 }],
    ])
  })

  test("touch refreshes lastUsedAt at most once a minute per account", async () => {
    KiloAccountState.touch("p", "one", 1_000)
    await KiloAccountState.flush()
    expect(writes.map((item) => item.state)).toEqual([{ lastUsedAt: 1_000 }])

    KiloAccountState.touch("p", "one", 30_000)
    await KiloAccountState.flush()
    expect(writes).toHaveLength(1)

    KiloAccountState.touch("p", "one", 62_000)
    await KiloAccountState.flush()
    expect(writes.map((item) => item.state)).toEqual([{ lastUsedAt: 1_000 }, { lastUsedAt: 62_000 }])

    KiloAccountState.touch("p", "two", 62_000)
    await KiloAccountState.flush()
    expect(writes).toHaveLength(3)
  })

  test("keeps a queued write when persisting fails", async () => {
    KiloAccountState.useWriter(async () => {
      throw new Error("disk full")
    })
    KiloAccountState.record("p", "one", { status: "invalid" })
    await KiloAccountState.flush()

    KiloAccountState.useWriter(async (entry) => {
      writes.push({ providerID: entry.providerID, accountID: entry.accountID, state: { ...entry.state } })
    })
    KiloAccountState.record("p", "one", { status: "ok" })
    await KiloAccountState.flush()

    expect(writes).toEqual([{ providerID: "p", accountID: "one", state: { status: "ok" } }])
  })
})
