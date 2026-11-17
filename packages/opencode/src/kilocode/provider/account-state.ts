/**
 * Throttled writer for per-account health and usage (kilocode).
 *
 * Every turn touches an account and every provider failure marks one, but auth.json
 * must not be rewritten on that cadence: writes are coalesced per account and
 * flushed on a short timer, and `lastUsedAt` is refreshed at most once a minute.
 *
 * The writer is module-global on purpose — one `kilo serve` process serves the
 * sidebar, every editor tab and the Agent Manager, and they all share auth.json.
 */
import { Auth, type AccountState } from "@/auth"
import { AppRuntime } from "@/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"

const log = Log.create({ service: "provider.accounts" })

/** Writes are batched for this long, so a burst of turns costs one auth.json write. */
const FLUSH_MS = 2_000
/** A successful turn only refreshes `lastUsedAt` once per account per minute. */
const TOUCH_MS = 60_000

type Entry = {
  readonly providerID: string
  readonly accountID: string
  readonly state: AccountState
}

export type Writer = (entry: Entry) => Promise<void>

const store: Writer = (entry) =>
  AppRuntime.runPromise(
    Auth.Service.use((auth) =>
      auth.markAccount ? auth.markAccount(entry.providerID, entry.accountID, entry.state) : Effect.void,
    ),
  )

const pending = new Map<string, Entry>()
const touched = new Map<string, number>()
let writer: Writer = store
let timer: ReturnType<typeof setTimeout> | undefined

function id(providerID: string, accountID: string) {
  return `${providerID}\u0000${accountID}`
}

/** Combine a queued change with the one before it; usage deltas add up instead of replacing. */
function merge(entry: Entry) {
  const key = id(entry.providerID, entry.accountID)
  const prev = pending.get(key)?.state
  const usage =
    prev?.usage !== undefined && entry.state.usage !== undefined
      ? {
          input: (prev.usage.input ?? 0) + (entry.state.usage.input ?? 0),
          output: (prev.usage.output ?? 0) + (entry.state.usage.output ?? 0),
          cost: (prev.usage.cost ?? 0) + (entry.state.usage.cost ?? 0),
          turns: (prev.usage.turns ?? 0) + (entry.state.usage.turns ?? 0),
        }
      : (entry.state.usage ?? prev?.usage)
  pending.set(key, {
    providerID: entry.providerID,
    accountID: entry.accountID,
    state: { ...prev, ...entry.state, ...(usage !== undefined ? { usage } : {}) },
  })
}

function schedule() {
  if (timer) return
  timer = setTimeout(() => void flush(), FLUSH_MS)
  timer.unref?.()
}

/** Queue a health change (status, cooldown, last use) for the next flush. */
export function record(providerID: string, accountID: string, state: AccountState) {
  merge({ providerID, accountID, state })
  schedule()
}

/**
 * Mark an account as used by a successful turn. Throttled per account so long
 * sessions do not rewrite the credential file on every step.
 */
export function touch(providerID: string, accountID: string, now = Date.now()) {
  const key = id(providerID, accountID)
  const last = touched.get(key)
  if (last !== undefined && now - last < TOUCH_MS) return
  touched.set(key, now)
  merge({ providerID, accountID, state: { lastUsedAt: now } })
  schedule()
}

/** Queue token/cost usage of one settled step for the next flush. */
export function spend(providerID: string, accountID: string, usage: { input: number; output: number; cost: number }) {
  merge({ providerID, accountID, state: { usage: { ...usage, turns: 1 } } })
  schedule()
}

/** Write everything queued right now. Exposed for tests and shutdown paths. */
export async function flush() {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  const entries = [...pending.values()]
  pending.clear()
  for (const entry of entries) {
    try {
      await writer(entry)
    } catch (error) {
      log.warn("account state write failed", {
        providerID: entry.providerID,
        accountID: entry.accountID,
        error,
      })
    }
  }
}

/** Replace the persistence target. Tests use this to observe writes. */
export function useWriter(next: Writer) {
  writer = next
}

/** Drop queued state and restore the real writer. Tests only. */
export function reset() {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  pending.clear()
  touched.clear()
  writer = store
}

export * as KiloAccountState from "./account-state"
