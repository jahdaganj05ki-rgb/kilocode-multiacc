import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"

import { mapValues, pickBy } from "remeda" // kilocode_change
import { ModelCache } from "@/provider/model-cache" // kilocode_change
import { Auth } from "@/auth" // kilocode_change
import { KiloProviderAccounts } from "@/kilocode/provider/accounts" // kilocode_change - account management
import { KiloProviderProbe } from "@/kilocode/provider/probe" // kilocode_change - account verification
import { organization, recommend } from "@/kilocode/provider/catalog" // kilocode_change
import { ModelV2 } from "@opencode-ai/core/model" // kilocode_change
import { Option } from "effect" // kilocode_change
import {
  disposeAllInstancesAfterProviderAuthCallback,
  invalidatePresence,
} from "@/kilocode/server/provider-auth-lifecycle" // kilocode_change
import { providerMetadata } from "@/kilocode/provider/metadata" // kilocode_change
import { filterPromptTrainingModels } from "@/kilocode/provider/model-filter" // kilocode_change
import { overlay as overlayAnacondaDesktop } from "@/kilocode/anaconda-desktop/provider" // kilocode_change
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: { message: error.message } }) // kilocode_change
    }),
  )
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const cache = yield* ModelCache.Service // kilocode_change
    const access = yield* Auth.Service // kilocode_change

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const all = overlayAnacondaDesktop(yield* ModelsDev.Service.use((s) => s.get())) // kilocode_change
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const connected = yield* provider.list()
      // kilocode_change start
      const info = yield* access.get("kilo").pipe(Effect.option)
      const unavailable = Option.isNone(info) && ("kilo" in filtered || "kilo" in connected)
      if (Option.isNone(info) || organization(config.provider?.kilo?.options, info.value)) delete filtered.kilo
      const providers = filterPromptTrainingModels(
        Object.assign(
          mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
          connected,
        ),
        config.hide_prompt_training_models === true,
      )
      // kilocode_change end
      // kilocode_change start
      const failed = yield* cache.failedProviders()
      // Note: connected only contains providers with non-empty models after Provider.Service.list(),
      // so failed must be checked explicitly for providers whose fetch returned an error.
      const failedSet = new Set(failed)
      if (unavailable) failedSet.add("kilo")
      const validProviders = pickBy(
        providers,
        (item, id) => Object.keys(item.models).length > 0 || id in connected || failedSet.has(id),
      )
      // A failed provider can be entirely absent from `providers` (e.g. an org-scoped Kilo
      // catalog is deleted above at `delete filtered.kilo`, and `Provider.Service.list()` drops
      // zero-model entries). `pickBy` only filters existing keys, so without this, `failedSet`
      // has no row left to attach a reason to — the client gets `failed: ["kilo"]` but no entry
      // in `all` to render it against. Synthesize a models-less placeholder instead, only for
      // providers not excluded by config; it is never sourced from the raw catalog, so the
      // public models.dev model list cannot leak through it.
      for (const id of failedSet) {
        if (id in validProviders || !((enabled ? enabled.has(id) : true) && !disabled.has(id))) continue
        validProviders[id] = {
          id: ProviderV2.ID.make(id),
          name: all[id]?.name ?? id,
          source: "api",
          env: [],
          options: {},
          models: {},
        }
      }
      const failures: Provider.Failure[] = []
      for (const id of failedSet) {
        const failure = yield* cache.getFailure(id)
        if (!failure && id === "kilo" && unavailable) {
          failures.push({ providerID: id, kind: "unauthenticated" })
          continue
        }
        failures.push({
          providerID: id,
          kind: failure?.kind ?? "http",
          ...(failure?.status == null ? {} : { status: failure.status }),
        })
      }
      const defaults = Provider.defaultModelIDs(pickBy(validProviders, (item) => Object.keys(item.models).length > 0))
      if (connected[ProviderV2.ID.kilo] && defaults[ProviderV2.ID.kilo]) {
        const model = yield* Effect.promise(() =>
          recommend(
            validProviders.kilo.models,
            config.provider?.kilo?.options,
            Option.getOrUndefined(info),
            Option.isSome(info),
          ),
        )
        if (model) defaults[ProviderV2.ID.kilo] = ModelV2.ID.make(model)
      }
      return {
        all: Object.values(validProviders).map((item) => {
          const publicItem = Provider.toPublicInfo(item)
          // kilocode_change start - never hand a usable credential to a client
          const options =
            publicItem.options && typeof publicItem.options.apiKey === "string"
              ? { ...publicItem.options, apiKey: KiloProviderAccounts.maskKey(publicItem.options.apiKey) }
              : publicItem.options
          return {
            ...publicItem,
            ...(publicItem.key ? { key: KiloProviderAccounts.maskKey(publicItem.key) } : {}),
            options,
            metadata: providerMetadata(item.id),
          }
          // kilocode_change end
        }), // kilocode_change
        default: defaults,
        connected: Object.keys(connected),
        failed: [...failedSet],
        failures,
      }
      // kilocode_change end
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      // kilocode_change start - drop old-user presence before instance disposal on Kilo OAuth callback
      if (ctx.params.providerID === "kilo") yield* invalidatePresence()
      // kilocode_change end
      yield* disposeAllInstancesAfterProviderAuthCallback() // kilocode_change
      return true
    })

    // kilocode_change start - API-key account management
    const accountError = (providerID: ProviderV2.ID, message: string) =>
      new ProviderAuthApiError({ name: "BadRequest", data: { providerID, message } })

    // Storage failures surface as a normal provider auth error instead of an untyped 500.
    const guarded = <A, E, R>(providerID: ProviderV2.ID, body: Effect.Effect<A, E | Auth.AuthError, R>) =>
      body.pipe(
        Effect.catchIf(
          (error): error is Auth.AuthError => error instanceof Auth.AuthError,
          (error) => Effect.fail(accountError(providerID, error.message)),
        ),
      )

    const accountsView = (providerID: ProviderV2.ID) =>
      guarded(
        providerID,
        Effect.gen(function* () {
          const info = yield* access.get(providerID)
          const current = info?.type === "api" ? (Auth.normalize(info) as Auth.Api) : undefined
          return {
            providerID,
            accounts: (current?.accounts ?? []).map((item) => KiloProviderAccounts.viewAccount(item)),
            ...(current?.active !== undefined ? { active: current.active } : {}),
            strategy: current?.strategy ?? Auth.DEFAULT_STRATEGY,
          }
        }),
      )

    const accounts = Effect.fn("ProviderHttpApi.accounts.list")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      return yield* accountsView(ctx.params.providerID)
    })

    const accountsSet = Effect.fn("ProviderHttpApi.accounts.set")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: {
        accounts: ReadonlyArray<KiloProviderAccounts.AccountInput>
        active?: string
        strategy?: Auth.Strategy
      }
    }) {
      const providerID = ctx.params.providerID
      return yield* guarded(
        providerID,
        Effect.gen(function* () {
          const info = yield* access.get(providerID)
          if (info && info.type !== "api")
            return yield* accountError(providerID, "Provider does not use API-key authentication")
          const change = (stored: readonly Auth.Account[]) =>
            KiloProviderAccounts.mergeAccounts(stored, ctx.payload.accounts)
          // Reject an empty result up front so the client gets a 400 instead of a no-op write.
          const merged = change(info ? Auth.accountsOf(info) : [])
          if (merged.length === 0)
            return yield* accountError(providerID, "At least one account with an API key is required")
          const names = merged.map((item) => item.label.trim().toLowerCase())
          // Labels identify accounts in the CLI and the dialog, so they must be unique.
          if (new Set(names).size !== names.length)
            return yield* accountError(providerID, "Account labels must be unique")
          // Merge inside the credential lock: a running turn may mark an account while the
          // dialog saves, and a read-modify-write here would drop that status again.
          const options = {
            ...(ctx.payload.active !== undefined ? { active: ctx.payload.active } : {}),
            ...(ctx.payload.strategy !== undefined ? { strategy: ctx.payload.strategy } : {}),
          }
          const edit = access.edit
          if (edit) yield* edit(providerID, change, options)
          else
            yield* access.setAccounts!(providerID, {
              accounts: change(info ? Auth.accountsOf(info) : []),
              ...options,
            })
          return yield* accountsView(providerID)
        }),
      )
    })

    const accountsRemove = Effect.fn("ProviderHttpApi.accounts.remove")(function* (ctx: {
      params: { providerID: ProviderV2.ID; accountID: string }
    }) {
      const providerID = ctx.params.providerID
      return yield* guarded(
        providerID,
        Effect.gen(function* () {
          const info = yield* access.get(providerID)
          const stored = info ? Auth.accountsOf(info) : []
          const accountID = ctx.params.accountID
          if (!stored.some((item) => item.id === accountID)) return yield* accountError(providerID, "Unknown account")
          if (stored.length === 1)
            return yield* accountError(providerID, "Cannot remove the last account. Disconnect the provider instead.")
          const change = (accounts: readonly Auth.Account[]) => accounts.filter((item) => item.id !== accountID)
          // Remove inside the credential lock, so a health update of a running turn stays.
          const edit = access.edit
          if (edit) yield* edit(providerID, change)
          else yield* access.setAccounts!(providerID, { accounts: change(stored) })
          return yield* accountsView(providerID)
        }),
      )
    })

    const accountsActivate = Effect.fn("ProviderHttpApi.accounts.activate")(function* (ctx: {
      params: { providerID: ProviderV2.ID; accountID: string }
    }) {
      const providerID = ctx.params.providerID
      return yield* guarded(
        providerID,
        Effect.gen(function* () {
          const info = yield* access.get(providerID)
          const stored = info ? Auth.accountsOf(info) : []
          if (!stored.some((item) => item.id === ctx.params.accountID))
            return yield* accountError(providerID, "Unknown account")
          yield* access.activate!(providerID, ctx.params.accountID)
          return yield* accountsView(providerID)
        }),
      )
    })

    const accountsStrategy = Effect.fn("ProviderHttpApi.accounts.strategy")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: { strategy: Auth.Strategy }
    }) {
      const providerID = ctx.params.providerID
      return yield* guarded(
        providerID,
        Effect.gen(function* () {
          const info = yield* access.get(providerID)
          const stored = info ? Auth.accountsOf(info) : []
          if (stored.length === 0) return yield* accountError(providerID, "Provider has no API-key accounts")
          // The strategy change touches no accounts; keep whatever health the list has now.
          const edit = access.edit
          if (edit) yield* edit(providerID, (accounts) => accounts, { strategy: ctx.payload.strategy })
          else yield* access.setAccounts!(providerID, { accounts: stored, strategy: ctx.payload.strategy })
          return yield* accountsView(providerID)
        }),
      )
    })

    const modelsFetch = Effect.fn("ProviderHttpApi.models.fetch")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: { baseURL: string; headers?: Record<string, string> }
    }) {
      const providerID = ctx.params.providerID
      return yield* guarded(
        providerID,
        Effect.gen(function* () {
          const info = yield* access.get(providerID)
          const current = info?.type === "api" ? (Auth.normalize(info) as Auth.Api) : undefined
          const active = current?.accounts?.find((item) => item.id === current.active)
          const key = active?.key
          if (!key) return yield* accountError(providerID, "API key required")

          const connected = yield* provider.list()
          const item = connected[providerID]
          const stored =
            (typeof item?.options?.baseURL === "string" ? item.options.baseURL : undefined) ??
            Object.values(item?.models ?? {})
              .map((model) => model.api.url)
              .find((value) => !!value)
          const normalize = (value: string) => value.trim().replace(/\/+$/, "")
          // The stored key is only ever sent to the URL the provider is configured for.
          if (!stored || normalize(stored) !== normalize(ctx.payload.baseURL))
            return yield* accountError(providerID, "Base URL does not match the stored provider")

          const response = yield* Effect.tryPromise({
            try: (signal) =>
              fetch(`${normalize(ctx.payload.baseURL)}/models`, {
                headers: {
                  accept: "application/json",
                  authorization: `Bearer ${key}`,
                  ...ctx.payload.headers,
                },
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
              }),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!response) return yield* accountError(providerID, "Failed to fetch models")
          if (!response.ok) {
            yield* Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve())
            return yield* accountError(providerID, `HTTP ${response.status}`)
          }
          const body = yield* Effect.tryPromise({
            try: () => response.json() as Promise<{ data?: Array<{ id?: unknown; name?: unknown }> }>,
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const models = (body?.data ?? [])
            .filter((item): item is { id: string; name?: string } => typeof item.id === "string")
            .map((item) => ({ id: item.id, ...(typeof item.name === "string" ? { name: item.name } : {}) }))
          return { models }
        }),
      )
    })

    const accountsVerify = Effect.fn("ProviderHttpApi.accounts.verify")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: { accountID?: string; key?: string }
    }) {
      const providerID = ctx.params.providerID
      const info = yield* access.get(providerID).pipe(
        Effect.catchIf(
          (error): error is Auth.AuthError => error instanceof Auth.AuthError,
          (error) => Effect.fail(accountError(providerID, error.message)),
        ),
      )
      const stored = info ? Auth.accountsOf(info) : []
      const account = ctx.payload.accountID ? stored.find((item) => item.id === ctx.payload.accountID) : undefined
      const key = ctx.payload.key?.trim() || account?.key
      if (!key) return yield* accountError(providerID, "API key required")

      const connected = yield* provider.list()
      const url = Object.values(connected[providerID]?.models ?? {})
        .map((model) => model.api.url)
        .find((value) => !!value)
      // Providers without a discoverable model endpoint cannot be probed generically.
      if (!url) return { status: "unknown" as const }

      const result = yield* Effect.promise(() => KiloProviderProbe.probe({ providerID, key, url }))
      const status = result.status
      // Persist health for a stored account so the dialog and later turns agree
      // without waiting for a failing turn.
      const accountID = ctx.payload.accountID
      const state = KiloProviderAccounts.verified(status, result.retryAfter)
      const health = state || result.quota ? { ...state, ...(result.quota ? { quota: result.quota } : {}) } : undefined
      if (accountID && health)
        yield* (access.markAccount?.(providerID, accountID, health) ?? Effect.void).pipe(
          // A failed write must not hide the probe result.
          Effect.catchIf(
            (error): error is Auth.AuthError => error instanceof Auth.AuthError,
            (error) => Effect.logWarning("failed to persist provider account health", { providerID, accountID, error }),
          ),
        )
      return result
    })
    // kilocode_change end

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handle("accounts", accounts) // kilocode_change
      .handle("accountsSet", accountsSet) // kilocode_change
      .handle("accountsRemove", accountsRemove) // kilocode_change
      .handle("accountsActivate", accountsActivate) // kilocode_change
      .handle("accountsStrategy", accountsStrategy) // kilocode_change
      .handle("accountsVerify", accountsVerify) // kilocode_change
      .handle("modelsFetch", modelsFetch) // kilocode_change
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
