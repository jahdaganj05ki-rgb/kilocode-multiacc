/**
 * Account selection policy for API-key providers (kilocode).
 *
 * The credential store knows about every account; this module decides which one
 * serves a request. Selection is process-global because a single `kilo serve`
 * process serves the sidebar, every editor tab and the Agent Manager.
 *
 * Strategies:
 * - manual: the user's active account always wins.
 * - failover: keep using the last account until it fails, then move on.
 * - roundRobin: rotate per turn (a turn is sticky, so retries, tool calls and
 *   nested work within one turn stay on the same account).
 */
import type { Account, AccountQuota, AccountState, Info, Strategy } from "@/auth"
import { accountInfo, activeAccount, normalize, usable } from "@/auth"

export type Selection = {
  readonly strategy: Strategy
  readonly accounts: readonly Account[]
  readonly active?: string
}

export type Resolution = {
  readonly providerID: string
  readonly info?: Info
  readonly turn?: string
  readonly now?: number
}

export type Failure = {
  readonly providerID: string
  readonly error?: unknown
  readonly now?: number
}

const DEFAULT_COOLDOWN_MS = 60_000
/**
 * Upper bound for a cooldown a provider can ask for. It deliberately applies to
 * failed turns as well as to verifications: a day-long `retry-after` (daily quota)
 * would otherwise hide a working key from the selector and the dialog for a day.
 * One extra failed attempt per hour is cheaper than that, and both paths derive
 * their cooldown from `wait()`, so this stays the single rule for stored health.
 */
const MAX_COOLDOWN_MS = 60 * 60_000
/** Only guards against a broken reset header; real quota windows are days at most. */
const MAX_RESET_MS = 30 * 24 * 60 * 60_000
const MAX_TURNS = 256

const state = {
  /** Round-robin position per provider, as an index into the account list. */
  cursor: new Map<string, number>(),
  /** Turn -> provider -> account, so a turn stays on one account. */
  turns: new Map<string, Map<string, string>>(),
  /** Last account used per provider. */
  current: new Map<string, string>(),
  /** Last seen account list per provider, for failover decisions. */
  known: new Map<string, readonly Account[]>(),
  /** Runtime-only auth failures; persisted state comes from the auth store. */
  invalid: new Set<string>(),
  /** Runtime-only cooldowns keyed by provider+account. */
  cooldown: new Map<string, number>(),
}

function key(providerID: string, accountID: string) {
  return `${providerID}:${accountID}`
}

/** Reset all runtime selection state. Tests rely on this; nothing else should call it. */
export function reset() {
  state.cursor.clear()
  state.turns.clear()
  state.current.clear()
  state.known.clear()
  state.invalid.clear()
  state.cooldown.clear()
}

export function settings(info: Info | undefined): Selection | undefined {
  if (info?.type !== "api") return undefined
  const current = normalize(info)
  if (current.type !== "api") return undefined
  return {
    strategy: current.strategy ?? "manual",
    accounts: current.accounts ?? [],
    active: current.active,
  }
}

function ready(providerID: string, account: Account, now: number) {
  if (!usable(account, now)) return false
  if (state.invalid.has(key(providerID, account.id))) return false
  return (state.cooldown.get(key(providerID, account.id)) ?? 0) <= now
}

export function available(providerID: string, accounts: readonly Account[], now = Date.now()) {
  return accounts.filter((account) => ready(providerID, account, now))
}

function remember(turn: string, providerID: string, accountID: string) {
  const entry = state.turns.get(turn) ?? new Map<string, string>()
  entry.set(providerID, accountID)
  state.turns.set(turn, entry)
  if (state.turns.size <= MAX_TURNS) return
  const oldest = state.turns.keys().next()
  if (!oldest.done) state.turns.delete(oldest.value)
}

function remembered(turn: string, providerID: string) {
  return state.turns.get(turn)?.get(providerID)
}

function nextFrom(accounts: readonly Account[], pool: readonly Account[], cursor: number) {
  for (let step = 1; step <= accounts.length; step++) {
    const index = (cursor + step) % accounts.length
    const account = accounts[index]!
    if (pool.some((item) => item.id === account.id)) return { account, index }
  }
  return undefined
}

function resolveRoundRobin(providerID: string, accounts: readonly Account[], pool: readonly Account[], turn?: string) {
  const assigned = turn ? remembered(turn, providerID) : undefined
  const restored = assigned ? pool.find((item) => item.id === assigned) : undefined
  if (restored) return restored
  const picked = nextFrom(accounts, pool, state.cursor.get(providerID) ?? -1)
  if (!picked) return undefined
  state.cursor.set(providerID, picked.index)
  return picked.account
}

function resolveFailover(providerID: string, accounts: readonly Account[], pool: readonly Account[]) {
  const last = state.current.get(providerID)
  const current = last ? pool.find((item) => item.id === last) : undefined
  if (current) return current
  const index = last ? accounts.findIndex((item) => item.id === last) : -1
  return nextFrom(accounts, pool, index)?.account
}

/**
 * Pick the account that serves this request. Returns undefined when the provider
 * has no usable accounts, in which case callers keep the legacy credential.
 */
export function resolve(input: Resolution): Account | undefined {
  const current = settings(input.info)
  if (!current || current.accounts.length === 0) return undefined
  const now = input.now ?? Date.now()
  state.known.set(input.providerID, current.accounts)

  const active = current.accounts.find((item) => item.id === current.active) ?? activeAccount(input.info ?? undefined)
  const pool = available(input.providerID, current.accounts, now)
  const fallback = active ?? current.accounts[0]

  const picked = (() => {
    if (current.strategy === "manual") return fallback
    if (pool.length === 0) return fallback
    if (current.strategy === "roundRobin")
      return resolveRoundRobin(input.providerID, current.accounts, pool, input.turn)
    return resolveFailover(input.providerID, current.accounts, pool)
  })()

  if (!picked) return fallback
  state.current.set(input.providerID, picked.id)
  if (input.turn) remember(input.turn, input.providerID, picked.id)
  return picked
}

/** Credential for the selected account, shaped like the legacy single-key entry. */
export function credential(info: Info | undefined, account: Account): Info | undefined {
  if (!info) return undefined
  return accountInfo(info, account)
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined
  const data = (error as { data?: unknown }).data
  if (!data || typeof data !== "object" || !("statusCode" in data)) return undefined
  const status = (data as { statusCode?: unknown }).statusCode
  return typeof status === "number" ? status : undefined
}

function cap(ms: number) {
  return Math.min(Math.max(0, Math.ceil(ms)), MAX_COOLDOWN_MS)
}

/** Retry-after in milliseconds; accepts seconds or an HTTP date, never above MAX_COOLDOWN_MS. */
export function wait(value: string | undefined | null): number | undefined {
  if (!value) return undefined
  const seconds = Number.parseFloat(value)
  if (!Number.isNaN(seconds)) return cap(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return cap(date - Date.now())
}

function headersOf(error: unknown): Record<string, string | undefined> | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined
  const data = (error as { data?: unknown }).data
  if (!data || typeof data !== "object" || !("responseHeaders" in data)) return undefined
  const headers = (data as { responseHeaders?: unknown }).responseHeaders
  if (!headers || typeof headers !== "object") return undefined
  return headers as Record<string, string | undefined>
}

const LIMITS = ["x-ratelimit-limit", "x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"]
const LEFTOVER = ["x-ratelimit-remaining", "x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining"]
const RESETS = ["x-ratelimit-reset", "x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset"]

function header(headers: Record<string, string | undefined>, names: readonly string[]) {
  for (const name of names) {
    const value = headers[name]
    if (value) return value
  }
  return undefined
}

/**
 * Reset time from a header. Providers send epoch seconds or millis, a relative wait
 * in seconds, a duration like "1m30s" or an RFC 3339 date; "1m30s" is a duration,
 * not the number 1, so a bare number is only read when the whole value is numeric.
 */
function stamp(value: string) {
  const text = value.trim()
  const now = Date.now()
  const at = (() => {
    if (/^\d+(\.\d+)?$/.test(text)) {
      const seconds = Number.parseFloat(text)
      if (seconds > 1_000_000_000_000) return seconds
      if (seconds > 1_000_000_000) return seconds * 1000
      return now + seconds * 1000
    }
    const date = Date.parse(text)
    if (!Number.isNaN(date)) return date
    const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
    const parts = [...text.matchAll(/([\d.]+)(ms|s|m|h|d)/g)]
    if (parts.length === 0) return undefined
    return (
      now + parts.reduce((sum, part) => sum + Number.parseFloat(part[1]!) * scale[part[2] as keyof typeof scale], 0)
    )
  })()
  // A broken or absurd reset must not hide an account for longer than the guard.
  return at === undefined ? undefined : Math.min(at, now + MAX_RESET_MS)
}

/** Rate-limit quota a provider reported in response headers, if any. */
export function quota(headers: Record<string, string | undefined>): AccountQuota | undefined {
  // Probe headers arrive lowercase, error detail headers keep their wire casing.
  const values = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  const limit = Number.parseFloat(header(values, LIMITS) ?? "")
  const remaining = Number.parseFloat(header(values, LEFTOVER) ?? "")
  const reset = header(values, RESETS)
  const resetAt = reset === undefined ? undefined : stamp(reset)
  const result: AccountQuota = {
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(Number.isFinite(remaining) ? { remaining } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/**
 * Record a failed attempt and decide whether retrying can help.
 *
 * 401/403 invalidate the account for this process, 402/429 cool it down. Both are
 * recoverable by switching accounts; returning false keeps the original error
 * behaviour when no other account can serve the request.
 */
export type FailureState = {
  readonly accountID: string
  readonly state: AccountState
}

/**
 * Record a failed attempt in memory and describe what belongs in the credential
 * store. Callers persist the returned state (throttled) so the UI and the next
 * process see the same health information.
 */
export function failure(input: Failure): FailureState | undefined {
  const accountID = state.current.get(input.providerID)
  if (!accountID) return undefined
  const status = statusOf(input.error)
  if (status === undefined) return undefined
  const now = input.now ?? Date.now()

  if (status === 401 || status === 403) {
    state.invalid.add(key(input.providerID, accountID))
    return { accountID, state: { status: "invalid" } }
  }
  if (status === 402 || status === 429) {
    const headers = headersOf(input.error)
    const until = now + (wait(headers?.["retry-after"]) ?? DEFAULT_COOLDOWN_MS)
    state.cooldown.set(key(input.providerID, accountID), until)
    const reported = headers ? quota(headers) : undefined
    return {
      accountID,
      state: { status: "cooling", cooldownUntil: until, ...(reported ? { quota: reported } : {}) },
    }
  }
  return undefined
}

/** Whether an account other than `accountID` can serve the provider right now. */
export function switchable(providerID: string, accountID: string, now = Date.now()) {
  const accounts = state.known.get(providerID) ?? []
  return available(providerID, accounts, now).some((item) => item.id !== accountID)
}

export function failed(input: Failure) {
  const record = failure(input)
  if (!record) return false
  return switchable(input.providerID, record.accountID, input.now)
}

/** The account that served a turn, so successful steps can refresh its last use. */
export function turnAccount(turn: string, providerID: string) {
  return remembered(turn, providerID)
}

/** Test/inspection helper: the account currently serving a provider, if any. */
export function current(providerID: string) {
  return state.current.get(providerID)
}

// ---------------------------------------------------------------------------
// API surface helpers: masking, views, merging, verification classification
// ---------------------------------------------------------------------------

/** Never expose a stored key to a client; keep only the last four characters. */
export function maskKey(key: string) {
  const value = key.trim()
  if (value.length <= 4) return "••••"
  return `••••${value.slice(-4)}`
}

export type VerifyStatus = "ok" | "invalid" | "rateLimited" | "unknown"

/** Map an HTTP status from a credential probe to a verification result. */
export function classify(status: number | undefined): VerifyStatus {
  if (status === undefined) return "unknown"
  if (status >= 200 && status < 300) return "ok"
  if (status === 401 || status === 403) return "invalid"
  if (status === 402 || status === 429) return "rateLimited"
  return "unknown"
}

/**
 * Account state to persist after a credential probe. A working key clears any
 * cooldown left by an earlier failure, a rejected key is invalid, and a rate
 * limit benches the account for the advertised wait exactly like a failed turn
 * does, so the dialog and the next turn agree. Unreachable endpoints stay
 * "unknown" and leave the stored health alone.
 */
export function verified(status: VerifyStatus, ms?: number): AccountState | undefined {
  if (status === "ok") return { status: "ok", cooldownUntil: null }
  if (status === "invalid") return { status: "invalid" }
  if (status === "rateLimited") return { status: "cooling", cooldownUntil: Date.now() + cap(ms ?? DEFAULT_COOLDOWN_MS) }
  return undefined
}

export type AccountUsage = {
  readonly input: number
  readonly output: number
  readonly cost: number
  readonly turns: number
  readonly updatedAt: number
}

export type AccountView = {
  readonly id: string
  readonly label: string
  readonly maskedKey: string
  readonly enabled: boolean
  readonly status?: Account["status"]
  readonly createdAt?: number
  readonly lastUsedAt?: number
  readonly cooldownUntil?: number
  readonly usage?: AccountUsage
  readonly quota?: AccountQuota
}

/** Client-facing account shape. Metadata is deliberately omitted: it can hold secrets. */
export function viewAccount(account: Account): AccountView {
  return {
    id: account.id,
    label: account.label,
    maskedKey: maskKey(account.key),
    enabled: account.enabled !== false,
    ...(account.status !== undefined ? { status: account.status } : {}),
    ...(account.createdAt !== undefined ? { createdAt: account.createdAt } : {}),
    ...(account.lastUsedAt !== undefined ? { lastUsedAt: account.lastUsedAt } : {}),
    ...(account.cooldownUntil !== undefined ? { cooldownUntil: account.cooldownUntil } : {}),
    ...(account.usage !== undefined ? { usage: account.usage } : {}),
    ...(account.quota !== undefined ? { quota: account.quota } : {}),
  }
}

export type AccountInput = {
  readonly id?: string
  readonly label?: string
  readonly key?: string
  readonly metadata?: Record<string, string>
  readonly enabled?: boolean
}

/** Next free default label, so a client that omits `label` never collides. */
export function freeLabel(accounts: readonly { label: string }[]) {
  const used = new Set(accounts.map((item) => item.label.toLowerCase()))
  let index = accounts.length + 1
  while (used.has(`account ${index}`)) index += 1
  return `Account ${index}`
}

/**
 * Merge a client-supplied account list over the stored one.
 *
 * Existing ids keep their stored key unless a new one is supplied; a replaced key
 * clears the failure state, because the old failure belonged to the old credential.
 * Entries without a usable key are dropped instead of creating broken accounts.
 */
export function mergeAccounts(
  stored: readonly Account[],
  input: readonly AccountInput[],
  makeID: () => string = () => crypto.randomUUID(),
): Account[] {
  const accounts: Account[] = []
  for (const item of input) {
    const existing = item.id ? stored.find((account) => account.id === item.id) : undefined
    const key = item.key?.trim() || existing?.key
    if (!key) continue
    const replaced = existing !== undefined && item.key !== undefined && item.key.trim() !== existing.key
    accounts.push({
      id: existing?.id ?? item.id ?? makeID(),
      label: item.label?.trim() || existing?.label || freeLabel(accounts),
      key,
      metadata: item.metadata ?? existing?.metadata,
      enabled: item.enabled ?? existing?.enabled ?? true,
      ...(existing?.createdAt !== undefined ? { createdAt: existing.createdAt } : {}),
      ...(!replaced && existing?.status !== undefined ? { status: existing.status } : {}),
      ...(!replaced && existing?.cooldownUntil !== undefined ? { cooldownUntil: existing.cooldownUntil } : {}),
      ...(!replaced && existing?.quota !== undefined ? { quota: existing.quota } : {}),
      ...(!replaced && existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
    })
  }
  return accounts
}

export * as KiloProviderAccounts from "./accounts"
