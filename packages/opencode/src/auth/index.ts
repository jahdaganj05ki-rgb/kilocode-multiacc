import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { randomUUID } from "crypto" // kilocode_change - unique temp file for atomic auth writes
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flock } from "@opencode-ai/core/util/flock" // kilocode_change - serialize auth.json writers across processes
import { Telemetry } from "@kilocode/kilo-telemetry" // kilocode_change

export const OAUTH_DUMMY_KEY = "kilo-oauth-dummy-key" // kilocode_change

const file = path.join(Global.Path.data, "auth.json")
const lockKey = `auth:${file}` // kilocode_change - one writer at a time for auth.json

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
  baseURL: Schema.optional(Schema.String), // kilocode_change - Azure Entra endpoint captured from OAuth prompts
}) {}

// kilocode_change start - multiple API-key accounts per provider
export const Strategy = Schema.Literals(["manual", "failover", "roundRobin"])
export type Strategy = Schema.Schema.Type<typeof Strategy>

export const AccountStatus = Schema.Literals(["ok", "invalid", "cooling"])
export type AccountStatus = Schema.Schema.Type<typeof AccountStatus>

export const AccountUsage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cost: Schema.Finite,
  turns: Schema.Finite,
  updatedAt: Schema.Finite,
})
export type AccountUsage = Schema.Schema.Type<typeof AccountUsage>

/** Rate-limit quota a provider reported for one account. */
export const AccountQuota = Schema.Struct({
  limit: Schema.optional(Schema.Finite),
  remaining: Schema.optional(Schema.Finite),
  resetAt: Schema.optional(Schema.Finite),
})
export type AccountQuota = Schema.Schema.Type<typeof AccountQuota>

export const Account = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  status: Schema.optional(AccountStatus),
  createdAt: Schema.optional(Schema.Finite),
  lastUsedAt: Schema.optional(Schema.Finite),
  cooldownUntil: Schema.optional(Schema.Finite),
  usage: Schema.optional(AccountUsage),
  quota: Schema.optional(AccountQuota),
})
export type Account = Schema.Schema.Type<typeof Account>

export const DEFAULT_ACCOUNT = "default"
export const DEFAULT_ACCOUNT_LABEL = "Account 1"
export const DEFAULT_STRATEGY: Strategy = "manual"

export interface AccountsInput {
  readonly accounts: readonly Account[]
  readonly active?: string
  readonly strategy?: Strategy
}

export interface AccountState {
  readonly status?: AccountStatus
  /** `null` clears the cooldown, e.g. after the key verified again. */
  readonly cooldownUntil?: number | null
  readonly lastUsedAt?: number
  /** Additive token/cost counters for one step; `turns` counts settled steps. */
  readonly usage?: {
    readonly input?: number
    readonly output?: number
    readonly cost?: number
    readonly turns?: number
  }
  /** Fields the provider just reported; missing ones keep their stored value. */
  readonly quota?: AccountQuota
}
// kilocode_change end

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // kilocode_change start - additive account list; key/metadata mirror the active account
  // so existing readers (JetBrains, KILO_AUTH_CONTENT, provider loading) keep working
  // Mutable array: the public SDK type (and the plugin hook context that mirrors it)
  // declares a plain array, and Schema.Array alone produces a readonly one.
  accounts: Schema.optional(Schema.mutable(Schema.Array(Account))),
  active: Schema.optional(Schema.String),
  strategy: Schema.optional(Strategy),
  // kilocode_change end
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  // kilocode_change start - multiple API-key accounts per provider. Optional so that
  // alternative Auth.Service implementations (tests, embedders) keep compiling; the
  // built-in layer always provides them.
  readonly accounts?: (providerID: string) => Effect.Effect<readonly Account[], AuthError>
  readonly setAccounts?: (providerID: string, input: AccountsInput) => Effect.Effect<void, AuthError>
  readonly activate?: (providerID: string, accountID: string) => Effect.Effect<void, AuthError>
  readonly markAccount?: (providerID: string, accountID: string, state: AccountState) => Effect.Effect<void, AuthError>
  /** Apply an account-list change inside the write lock, so concurrent writers cannot clobber it. */
  readonly edit?: (
    providerID: string,
    change: (accounts: readonly Account[]) => readonly Account[],
    options?: { readonly active?: string; readonly strategy?: Strategy },
  ) => Effect.Effect<void, AuthError>
  // kilocode_change end
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

// kilocode_change start - account helpers shared by the CLI backend and the selection policy
export function usable(account: Account, now = Date.now()) {
  if (account.enabled === false) return false
  if (account.status === "invalid") return false
  if (account.cooldownUntil !== undefined && account.cooldownUntil > now) return false
  // A provider that reported no quota left cannot serve until it resets.
  if (account.quota?.remaining === 0 && account.quota.resetAt !== undefined && account.quota.resetAt > now) return false
  return true
}

/** Materialize the additive account list. Legacy single-key entries become one default account. */
export function normalize(info: Info): Info {
  if (info.type !== "api") return info
  const accounts: Account[] =
    info.accounts && info.accounts.length > 0
      ? [...info.accounts]
      : [{ id: DEFAULT_ACCOUNT, label: DEFAULT_ACCOUNT_LABEL, key: info.key, metadata: info.metadata }]
  const active = accounts.find((item) => item.id === info.active) ?? accounts[0]!
  return {
    ...info,
    accounts,
    active: active.id,
    key: active.key,
    metadata: active.metadata,
    strategy: info.strategy ?? DEFAULT_STRATEGY,
  }
}

/**
 * Preserve a provider's account list when a client writes a single key over it.
 * `PUT /auth/:id` (JetBrains, `kilo auth login`, scripts) replaces the whole entry,
 * which used to delete every other account. A key now lands on the active account,
 * the rest stay, and the replaced credential loses the status of the old key.
 */
export function merge(info: Info, current: Info | undefined): Info {
  if (info.type !== "api" || !current || current.type !== "api") return normalize(info)
  // An explicit account list is an account edit, not a single-key write.
  if (info.accounts && info.accounts.length > 0) return normalize(info)
  const prev = normalize(current) as Api
  const list = prev.accounts ?? []
  const active = list.find((item) => item.id === prev.active) ?? list.at(0)
  if (!active) return normalize(info)
  const accounts = list.map((item) => {
    if (item.id !== active.id) return item
    const next = { ...item, key: info.key }
    if (info.metadata !== undefined) next.metadata = info.metadata
    delete next.status
    delete next.cooldownUntil
    return next
  })
  return normalize({ ...prev, accounts, active: active.id })
}

export function accountsOf(info: Info | undefined): readonly Account[] {
  if (info?.type !== "api") return []
  return (normalize(info) as Api).accounts ?? []
}

export function activeAccount(info: Info | undefined): Account | undefined {
  if (info?.type !== "api") return undefined
  const current = normalize(info) as Api
  return current.accounts?.find((item) => item.id === current.active)
}

/** Credential view of one account, shaped like the legacy single-key entry. */
export function accountInfo(info: Info, account: Account): Info {
  if (info.type !== "api") return info
  return { ...info, key: account.key, metadata: account.metadata, active: account.id }
}
// kilocode_change end

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    // kilocode_change start - KILO_AUTH_CONTENT override and in-memory normalization
    const read = Effect.fn("Auth.read")(function* () {
      if (process.env.KILO_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.KILO_AUTH_CONTENT) as Record<string, Info>
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const all = Effect.fn("Auth.all")(function* () {
      return Record.map(yield* read(), normalize)
    })
    // kilocode_change end

    // kilocode_change start - atomic, lock-protected writes
    const write = (data: Record<string, Info>) =>
      Effect.gen(function* () {
        const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
        yield* fsys
          .writeFileString(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
          .pipe(Effect.mapError(fail("Failed to write auth data")))
        yield* fsys.rename(tmp, file).pipe(Effect.mapError(fail("Failed to write auth data")))
        yield* fsys.chmod(file, 0o600).pipe(Effect.ignore)
      })

    // Serializes read-merge-write across threads and processes, so concurrent account
    // edits cannot lose each other's changes.
    const mutate = <A>(update: (data: Record<string, Info>) => { next: Record<string, Info>; result: A }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () => Flock.acquire(lockKey),
              catch: fail("Failed to lock auth data"),
            }),
            (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
          )
          const data = yield* all()
          const { next, result } = update(data)
          yield* write(next)
          return result
        }),
      )
    // kilocode_change end

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      // kilocode_change start - write through the lock and normalize the entry
      yield* mutate((data) => {
        const next = { ...data }
        if (norm !== key) delete next[key]
        delete next[norm + "/"]
        next[norm] = merge(info, data[norm] ?? data[key])
        return { next, result: undefined }
      })
      // kilocode_change end
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      // kilocode_change start - write through the lock
      yield* mutate((data) => {
        const next = { ...data }
        delete next[key]
        delete next[norm]
        return { next, result: undefined }
      })
      // kilocode_change end

      // kilocode_change start - Track logout and reset telemetry identity for Kilo
      if (key === "kilo") {
        yield* Effect.promise(() => Telemetry.updateIdentity(null))
      }
      Telemetry.trackAuthLogout(key)
      // kilocode_change end
    })

    // kilocode_change start - account CRUD on top of the legacy credential entry
    const accounts = Effect.fn("Auth.accounts")(function* (providerID: string) {
      return accountsOf((yield* all())[providerID])
    })

    const setAccounts = Effect.fn("Auth.setAccounts")(function* (providerID: string, input: AccountsInput) {
      yield* mutate((data) => {
        const current = data[providerID]
        // OAuth and well-known credentials are not account-based; leave them alone.
        if (current && current.type !== "api") return { next: data, result: undefined }
        if (input.accounts.length === 0) return { next: data, result: undefined }
        const norm = current ? normalize(current) : undefined
        // Keep the current active account when a caller edits the list without
        // naming one (e.g. a strategy change), so it does not silently switch.
        const active =
          input.accounts.find((item) => item.id === input.active) ??
          (norm?.type === "api" ? input.accounts.find((item) => item.id === norm.active) : undefined) ??
          input.accounts[0]!
        const next = {
          ...(norm?.type === "api" ? norm : {}),
          type: "api" as const,
          key: active.key,
          metadata: active.metadata,
          accounts: [...input.accounts],
          active: active.id,
          strategy: input.strategy ?? (norm?.type === "api" ? norm.strategy : undefined) ?? DEFAULT_STRATEGY,
        } satisfies Api
        return { next: { ...data, [providerID]: next }, result: undefined }
      })
    })

    const activate = Effect.fn("Auth.activate")(function* (providerID: string, accountID: string) {
      yield* mutate((data) => {
        const current = data[providerID]
        if (!current || current.type !== "api") return { next: data, result: undefined }
        const norm = normalize(current) as Api
        const chosen = norm.accounts?.find((item) => item.id === accountID)
        if (!chosen) return { next: data, result: undefined }
        const next = { ...norm, active: chosen.id, key: chosen.key, metadata: chosen.metadata } satisfies Api
        return { next: { ...data, [providerID]: next }, result: undefined }
      })
    })

    const markAccount = Effect.fn("Auth.markAccount")(function* (
      providerID: string,
      accountID: string,
      input: AccountState,
    ) {
      yield* mutate((data) => {
        const current = data[providerID]
        if (!current || current.type !== "api") return { next: data, result: undefined }
        const norm = normalize(current) as Api
        const accounts = (norm.accounts ?? []).map((item) => {
          if (item.id !== accountID) return item
          const next = { ...item }
          if (input.status !== undefined) next.status = input.status
          if (input.cooldownUntil === null) delete next.cooldownUntil
          else if (input.cooldownUntil !== undefined) next.cooldownUntil = input.cooldownUntil
          if (input.lastUsedAt !== undefined) next.lastUsedAt = input.lastUsedAt
          if (input.quota !== undefined) next.quota = { ...next.quota, ...input.quota }
          if (input.usage !== undefined) {
            next.usage = {
              input: (next.usage?.input ?? 0) + (input.usage.input ?? 0),
              output: (next.usage?.output ?? 0) + (input.usage.output ?? 0),
              cost: (next.usage?.cost ?? 0) + (input.usage.cost ?? 0),
              turns: (next.usage?.turns ?? 0) + (input.usage.turns ?? 0),
              updatedAt: Date.now(),
            }
          }
          return next
        })
        const active = accounts.find((item) => item.id === norm.active)
        const next = {
          ...norm,
          accounts,
          key: active?.key ?? norm.key,
          metadata: active?.metadata ?? norm.metadata,
        } satisfies Api
        return { next: { ...data, [providerID]: next }, result: undefined }
      })
    })
    const edit = Effect.fn("Auth.edit")(function* (
      providerID: string,
      change: (accounts: readonly Account[]) => readonly Account[],
      options?: { readonly active?: string; readonly strategy?: Strategy },
    ) {
      yield* mutate((data) => {
        const current = data[providerID]
        if (current && current.type !== "api") return { next: data, result: undefined }
        const norm = current ? (normalize(current) as Api) : undefined
        const accounts = change(norm?.accounts ?? [])
        if (accounts.length === 0) return { next: data, result: undefined }
        const active =
          accounts.find((item) => item.id === options?.active) ??
          accounts.find((item) => item.id === norm?.active) ??
          accounts[0]!
        const next = {
          ...(norm ?? {}),
          type: "api" as const,
          key: active.key,
          metadata: active.metadata,
          accounts: [...accounts],
          active: active.id,
          strategy: options?.strategy ?? norm?.strategy ?? DEFAULT_STRATEGY,
        } satisfies Api
        return { next: { ...data, [providerID]: next }, result: undefined }
      })
    })
    // kilocode_change end

    return Service.of({ get, all, set, remove, accounts, setAccounts, activate, markAccount, edit }) // kilocode_change
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })
export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer)) // kilocode_change - legacy Kilo runtime compatibility

export * as Auth from "."
