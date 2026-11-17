/**
 * Provider action handlers extracted from KiloProvider to stay under max-lines.
 * These are pure async functions that operate on the SDK client — no vscode dependency.
 */
import type { Config, KiloClient } from "@kilocode/sdk/v2"
import { validateProviderID as validateProviderIDShared } from "./shared/custom-provider"
import {
  resolveCustomProviderAuth,
  sanitizeCustomProviderConfig,
  withCustomProviderDeletions,
} from "./shared/custom-provider"
import { isCustomProviderPackage, KILO_AUTO, KILO_PROVIDER_ID, parseModelString } from "./shared/provider-model"
import { configFeatures, serverFeatures } from "./features"

/**
 * Compute the default model selection from CLI config, VS Code settings, or hardcoded fallback.
 * Pure function — takes cachedConfig and vscode settings as parameters.
 */
type AuthState = "api" | "oauth" | "wellknown"

function disabledWithout(list: string[] | undefined, id: string) {
  return (list ?? []).filter((item) => item !== id)
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function customProvider(config: unknown) {
  return record(config) && isCustomProviderPackage(config.npm)
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((value, index) => same(value, b[index]))
  }
  if (!record(a) || !record(b)) return false
  const akeys = Object.keys(a).sort()
  const bkeys = Object.keys(b).sort()
  if (akeys.length !== bkeys.length) return false
  return akeys.every((key, index) => key === bkeys[index] && same(a[key], b[key]))
}

/** Fetch provider availability and authentication state without exposing stored credentials. */
export async function fetchProviderData(client: KiloClient, dir: string) {
  const authRequest =
    typeof client.provider.auth === "function"
      ? client.provider
          .auth({ directory: dir }, { throwOnError: true })
          .then((r) => r.data ?? {})
          .catch(() => ({}))
      : Promise.resolve({})
  const kiloRequest = client.kilo
    .authStatus({ directory: dir }, { throwOnError: true })
    .then((r) => r.data)
    .catch(() => undefined)

  const [{ data: response }, authMethods, kiloAuth] = await Promise.all([
    client.provider.list({ directory: dir }, { throwOnError: true }),
    authRequest,
    kiloRequest,
  ])
  const authStates: Record<string, AuthState> = {}
  const all = response.all.map((item) => {
    const raw = item as Record<string, unknown>
    // Keys are masked at the HTTP boundary, so this only signals an API-key
    // credential. Model fetches for stored keys go through the backend
    // (provider.models.fetch), never through a key held by the extension.
    if (typeof raw.id === "string" && typeof raw.key === "string" && raw.key) authStates[raw.id] = "api"
    if (!("key" in raw)) return item
    const next = { ...raw }
    delete next.key
    return next as (typeof response.all)[number]
  })
  delete authStates[KILO_PROVIDER_ID]
  if (kiloAuth?.authenticated && kiloAuth.type) authStates[KILO_PROVIDER_ID] = kiloAuth.type
  const organizationId = kiloAuth ? (kiloAuth.organizationId ?? null) : undefined
  const defaults = { ...response.default }
  if (organizationId) {
    const models = all.find((item) => item.id === KILO_PROVIDER_ID)?.models ?? {}
    const recommended = response.default[KILO_PROVIDER_ID]
    const model = recommended && Object.hasOwn(models, recommended) ? recommended : Object.keys(models).at(0)
    if (model) defaults[KILO_PROVIDER_ID] = model
    if (!model) delete defaults[KILO_PROVIDER_ID]
  }
  if (!kiloAuth) delete defaults[KILO_PROVIDER_ID]
  return {
    response: {
      ...response,
      all: kiloAuth ? all : all.filter((item) => item.id !== KILO_PROVIDER_ID),
      connected: kiloAuth ? response.connected : response.connected.filter((id) => id !== KILO_PROVIDER_ID),
      default: defaults,
    },
    authMethods,
    authStates,
    organizationId,
    ready: !!kiloAuth,
    unavailable: catalogUnavailable(response.failed, all, organizationId),
  }
}

/** An organization's Kilo catalog failed to load, so Kilo has no models to pick. */
function catalogUnavailable(
  failed: string[] | undefined,
  all: ReadonlyArray<{ id: string; models: Record<string, unknown> }>,
  organizationId: string | null | undefined,
) {
  if (!organizationId || !failed?.includes(KILO_PROVIDER_ID)) return false
  return Object.keys(all.find((item) => item.id === KILO_PROVIDER_ID)?.models ?? {}).length === 0
}

/**
 * Resolve the stored API key for a model fetch on an existing provider.
 * The key is only applied when the requested URL matches the provider's
 * configured baseURL, so a stored secret can never be redirected to a
 * different host (e.g. after the user edits the URL field).
 */
export function buildActionContext(
  client: KiloClient,
  post: (msg: unknown) => void,
  errFn: (err: unknown) => string,
  dir: string,
  refresh: () => Promise<void>,
): ActionContext {
  return {
    client,
    postMessage: post,
    getErrorMessage: errFn,
    workspaceDir: dir,
    disposeGlobal: async (reason: string) => {
      // Wait for the server to finish disposing before refreshing providers.
      // Shared State.dispose() now has a hard per-disposer timeout, so this
      // wait is bounded without needing a client-side timeout here.
      await client.global.dispose().catch((error: unknown) => {
        console.warn(`[Kilo New] KiloProvider: global.dispose() after ${reason} failed:`, error)
      })
    },
    fetchAndSendProviders: refresh,
  }
}

function isModelSelection(r: unknown): r is { providerID: string; modelID: string } {
  return (
    !!r &&
    typeof r === "object" &&
    typeof (r as Record<string, unknown>).providerID === "string" &&
    typeof (r as Record<string, unknown>).modelID === "string"
  )
}

/** Validate and sanitize recent model selections from untrusted sources. */
export function validateRecents(raw: unknown): Array<{ providerID: string; modelID: string }> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isModelSelection)
    .slice(0, 5)
    .map((r) => ({ providerID: r.providerID, modelID: r.modelID }))
}

/** Validate and sanitize favorite model selections from untrusted sources. */
export function validateFavorites(raw: unknown): Array<{ providerID: string; modelID: string }> {
  if (!Array.isArray(raw)) return []
  return raw.filter(isModelSelection).map((r) => ({ providerID: r.providerID, modelID: r.modelID }))
}

/** Validate and sanitize per-mode model selections from untrusted sources. */
export function validateModelSelections(raw: unknown): Record<string, { providerID: string; modelID: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const result: Record<string, { providerID: string; modelID: string }> = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (isModelSelection(val)) {
      result[key] = { providerID: val.providerID, modelID: val.modelID }
    }
  }
  return result
}

export function computeDefaultSelection(
  cachedConfig: { config?: { model?: string } } | null,
  vscodePID: string,
  vscodeMID: string,
): { providerID: string; modelID: string } {
  const configured = parseModelString(cachedConfig?.config?.model)
  if (configured) return configured
  if (vscodePID && vscodeMID) return { providerID: vscodePID, modelID: vscodeMID }
  return { ...KILO_AUTO }
}

type PostMessage = (message: unknown) => void
type GetErrorMessage = (error: unknown) => string
type SetCachedConfig = (msg: unknown) => void
type AuthMetadata = Record<string, string>

interface ActionContext {
  client: KiloClient
  postMessage: PostMessage
  getErrorMessage: GetErrorMessage
  workspaceDir: string
  disposeGlobal: (reason: string) => Promise<void>
  fetchAndSendProviders: () => Promise<void>
}

function postError(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  action: "connect" | "disconnect" | "authorize",
  message: string,
) {
  ctx.postMessage({ type: "providerActionError", requestId, providerID, action, message })
}

function validateID(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  action: "connect" | "disconnect" | "authorize",
): string | null {
  const result = validateProviderIDShared(providerID)
  if ("value" in result) return result.value
  postError(ctx, requestId, providerID, action, result.error)
  return null
}

function cleanMetadata(input?: Record<string, unknown>): AuthMetadata | undefined {
  const entries = Object.entries(input ?? {})
    .map(([key, value]) => [key, typeof value === "string" ? value.trim() : ""] as const)
    .filter(([key, value]) => key !== "" && value !== "")
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

async function configs(ctx: ActionContext) {
  const [{ data: global }, { data: merged }] = await Promise.all([
    ctx.client.global.config.get({ throwOnError: true }),
    ctx.client.config.get({ directory: ctx.workspaceDir }, { throwOnError: true }),
  ])
  return { global: global ?? {}, merged: merged ?? {} }
}

async function refreshConfig(ctx: ActionContext, setCachedConfig: SetCachedConfig) {
  const [{ data: config }, { data: global }] = await Promise.all([
    ctx.client.config.get({ directory: ctx.workspaceDir }, { throwOnError: true }),
    ctx.client.global.config.get({ throwOnError: true }),
  ])
  if (!config) return
  const features = configFeatures(config, await serverFeatures(ctx.client, ctx.workspaceDir))
  setCachedConfig({ type: "configLoaded", config, globalConfig: global, features })
  ctx.postMessage({ type: "configUpdated", config, globalConfig: global, features })
}

async function saveGlobal(ctx: ActionContext, config: Config) {
  await ctx.client.global.config.update({ config }, { throwOnError: true })
}

async function saveProject(ctx: ActionContext, config: Config) {
  await ctx.client.config.update({ config, directory: ctx.workspaceDir }, { throwOnError: true })
}

async function removeAuth(ctx: ActionContext, id: string, configured: boolean) {
  try {
    await ctx.client.auth.remove({ providerID: id }, { throwOnError: true })
  } catch (err) {
    if (!configured) throw err
    console.warn(`[Kilo New] auth.remove failed for configured provider ${id} (non-fatal):`, err)
  }
}

async function removeConfigured(ctx: ActionContext, id: string, global: Config, merged: Config) {
  const cfg = global.provider?.[id]
  const effective = merged.provider?.[id]
  const tasks = []
  if (cfg) {
    tasks.push(
      saveGlobal(ctx, {
        provider: { [id]: null },
        disabled_providers: disabledWithout(global.disabled_providers, id),
      }),
    )
  }
  if (effective) {
    tasks.push(saveProject(ctx, { provider: { [id]: null } }))
  }
  await Promise.all(tasks)
}

export async function connectProvider(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  apiKey: string,
  metadata?: Record<string, unknown>,
) {
  const id = validateID(ctx, requestId, providerID, "connect")
  if (!id) return
  try {
    const meta = cleanMetadata(metadata)
    const auth = meta ? { type: "api" as const, key: apiKey, metadata: meta } : { type: "api" as const, key: apiKey }
    await ctx.client.auth.set({ providerID: id, auth }, { throwOnError: true })
    await ctx.disposeGlobal(`provider connect (${id})`)
    await ctx.fetchAndSendProviders()
    ctx.postMessage({ type: "providerConnected", requestId, providerID: id })
  } catch (error) {
    postError(ctx, requestId, providerID, "connect", ctx.getErrorMessage(error) || "Failed to connect provider")
  }
}

export async function authorizeProviderOAuth(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  method: number,
  inputs?: Record<string, string>,
) {
  const id = validateID(ctx, requestId, providerID, "authorize")
  if (!id) return
  try {
    const { data: authorization } = await ctx.client.provider.oauth.authorize(
      { providerID: id, method, directory: ctx.workspaceDir, inputs },
      { throwOnError: true },
    )
    if (!authorization) {
      postError(ctx, requestId, providerID, "authorize", "Failed to start provider authorization")
      return
    }
    ctx.postMessage({ type: "providerOAuthReady", requestId, providerID: id, authorization })
  } catch (error) {
    postError(
      ctx,
      requestId,
      providerID,
      "authorize",
      ctx.getErrorMessage(error) || "Failed to start provider authorization",
    )
  }
}

export async function completeProviderOAuth(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  method: number,
  code?: string,
) {
  const id = validateID(ctx, requestId, providerID, "connect")
  if (!id) return
  try {
    await ctx.client.provider.oauth.callback(
      { providerID: id, method, code, directory: ctx.workspaceDir },
      { throwOnError: true },
    )
    await ctx.disposeGlobal(`provider oauth (${id})`)
    await ctx.fetchAndSendProviders()
    ctx.postMessage({ type: "providerConnected", requestId, providerID: id })
  } catch (error) {
    postError(
      ctx,
      requestId,
      providerID,
      "connect",
      ctx.getErrorMessage(error) || "Failed to complete provider authorization",
    )
  }
}

export async function disconnectProvider(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  cachedConfigMessage: unknown,
  setCachedConfig: SetCachedConfig,
) {
  const id = validateID(ctx, requestId, providerID, "disconnect")
  if (!id) return
  try {
    const config = await configs(ctx)
    const cfg = config.global.provider?.[id]
    const effective = config.merged.provider?.[id]
    const configured = !!cfg || !!effective
    const custom = customProvider(cfg) || customProvider(effective)
    // Remove stored credentials and config so configured providers cannot
    // reconnect automatically with an old key after logout.
    await removeAuth(ctx, id, custom)

    if (id === "kilo") {
      ctx.postMessage({ type: "profileData", data: null })
    }

    if (configured) {
      await removeConfigured(ctx, id, config.global, config.merged)
    }

    await ctx.disposeGlobal(`provider disconnect (${id})`)
    if (configured) await refreshConfig(ctx, setCachedConfig)
    await ctx.fetchAndSendProviders()
    ctx.postMessage({ type: "providerDisconnected", requestId, providerID: id })
  } catch (error) {
    postError(ctx, requestId, providerID, "disconnect", ctx.getErrorMessage(error) || "Failed to disconnect provider")
  }
}

export async function saveCustomProvider(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  provider: Record<string, unknown>,
  apiKey: string | undefined,
  apiKeyChanged: boolean,
  cachedConfigMessage: unknown,
  setCachedConfig: (msg: unknown) => void,
) {
  const id = validateID(ctx, requestId, providerID, "connect")
  if (!id) return

  const sanitized = sanitizeCustomProviderConfig(provider)
  if ("error" in sanitized) {
    postError(ctx, requestId, providerID, "connect", sanitized.error)
    return
  }

  const refresh = async () => {
    await ctx.disposeGlobal(`custom provider save (${id})`)
    await ctx.fetchAndSendProviders()
  }

  try {
    const globalConfig = (await ctx.client.global.config.get({ throwOnError: true })).data ?? {}
    const disabled = globalConfig.disabled_providers ?? []
    const nextDisabled = disabled.filter((item: string) => item !== id)
    const existing = (globalConfig.provider as Record<string, unknown> | undefined)?.[id]
    const patch = withCustomProviderDeletions(existing, sanitized.value)
    const { data: updated } = await ctx.client.global.config.update(
      {
        config: {
          provider: { [id]: patch },
          disabled_providers: nextDisabled,
        },
      },
      { throwOnError: true },
    )

    const merged = await ctx.client.config.get({ directory: ctx.workspaceDir }, { throwOnError: true })
    const config = merged.data ?? updated
    const features = configFeatures(config, await serverFeatures(ctx.client, ctx.workspaceDir))
    const msg = { type: "configLoaded", config, globalConfig: updated, features }
    setCachedConfig(msg)
    ctx.postMessage({ type: "configUpdated", config, globalConfig: updated, features })

    const auth = resolveCustomProviderAuth(apiKey, apiKeyChanged)

    try {
      if (auth.mode === "set") {
        await ctx.client.auth.set({ providerID: id, auth: { type: "api", key: auth.key } }, { throwOnError: true })
      }
      if (auth.mode === "clear") {
        await ctx.client.auth.remove({ providerID: id }, { throwOnError: true })
      }
    } catch (error) {
      await refresh()
      postError(ctx, requestId, providerID, "connect", ctx.getErrorMessage(error) || "Failed to save custom provider")
      return
    }

    await refresh()
    ctx.postMessage({ type: "providerConnected", requestId, providerID: id })
  } catch (error) {
    postError(ctx, requestId, providerID, "connect", ctx.getErrorMessage(error) || "Failed to save custom provider")
  }
}

type AccountAction = "list" | "save" | "activate" | "remove" | "strategy" | "verify"
type AccountStrategy = "manual" | "failover" | "roundRobin"

interface AccountInput {
  id?: string
  label?: string
  key?: string
  enabled?: boolean
}

interface AccountView {
  id: string
  label: string
  maskedKey: string
  enabled: boolean
  status?: "ok" | "invalid" | "cooling"
  createdAt?: number
  lastUsedAt?: number
  cooldownUntil?: number
  usage?: { input: number; output: number; cost: number; turns: number; updatedAt: number }
  quota?: { limit?: number; remaining?: number; resetAt?: number }
}

interface AccountsResult {
  accounts: AccountView[]
  active?: string
  strategy: AccountStrategy
}

const STRATEGIES: AccountStrategy[] = ["manual", "failover", "roundRobin"]

function postAccountError(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  action: AccountAction,
  message: string,
) {
  ctx.postMessage({ type: "providerAccountError", requestId, providerID, action, message })
}

/** Validate account edits from the webview: ids and keys only, nothing executable. */
function cleanAccounts(raw: unknown): AccountInput[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): AccountInput[] => {
    if (!record(item)) return []
    const input: AccountInput = {}
    if (typeof item.id === "string" && item.id) input.id = item.id
    if (typeof item.label === "string") input.label = item.label
    if (typeof item.key === "string" && item.key) input.key = item.key
    if (typeof item.enabled === "boolean") input.enabled = item.enabled
    return input.id || input.key ? [input] : []
  })
}

function cleanStrategy(value: unknown): AccountStrategy | undefined {
  return STRATEGIES.find((item) => item === value)
}

function toResult(
  data: { accounts?: unknown; active?: string; strategy?: string } | undefined,
): AccountsResult | undefined {
  if (!data) return undefined
  const accounts = Array.isArray(data.accounts) ? (data.accounts as AccountView[]) : []
  return { accounts, active: data.active, strategy: cleanStrategy(data.strategy) ?? "manual" }
}

function postAccounts(ctx: ActionContext, requestId: string, providerID: string, data: AccountsResult | undefined) {
  if (!data) {
    postAccountError(ctx, requestId, providerID, "list", "Failed to load provider accounts")
    return
  }
  ctx.postMessage({
    type: "providerAccounts",
    requestId,
    providerID,
    accounts: data.accounts,
    active: data.active,
    strategy: data.strategy,
  })
}

/** Run one account request and answer the webview with the returned list. */
async function ask(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  action: AccountAction,
  failure: string,
  run: () => Promise<{ data?: { accounts?: unknown; active?: string; strategy?: string } }>,
  refresh = false,
) {
  try {
    const { data } = await run()
    if (refresh) await ctx.fetchAndSendProviders()
    postAccounts(ctx, requestId, providerID, toResult(data))
  } catch (error) {
    postAccountError(ctx, requestId, providerID, action, ctx.getErrorMessage(error) || failure)
  }
}

export async function listProviderAccounts(ctx: ActionContext, requestId: string, providerID: string) {
  if (!providerID) return postAccountError(ctx, requestId, providerID, "list", "Missing provider")
  await ask(ctx, requestId, providerID, "list", "Failed to load provider accounts", () =>
    ctx.client.provider.accounts.list({ providerID, directory: ctx.workspaceDir }, { throwOnError: true }),
  )
}

export async function saveProviderAccounts(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  raw: unknown,
  active?: string,
  strategy?: string,
) {
  const list = cleanAccounts(raw)
  if (list.length === 0) return postAccountError(ctx, requestId, providerID, "save", "Add at least one API key")
  await ask(
    ctx,
    requestId,
    providerID,
    "save",
    "Failed to save provider accounts",
    () =>
      ctx.client.provider.accounts.set(
        {
          providerID,
          directory: ctx.workspaceDir,
          accounts: list,
          active,
          strategy: cleanStrategy(strategy),
        },
        { throwOnError: true },
      ),
    true,
  )
}

export async function activateProviderAccount(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  accountID: string,
) {
  await ask(ctx, requestId, providerID, "activate", "Failed to activate account", () =>
    ctx.client.provider.accounts.activate(
      { providerID, accountID, directory: ctx.workspaceDir },
      { throwOnError: true },
    ),
  )
}

export async function removeProviderAccount(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  accountID: string,
) {
  await ask(
    ctx,
    requestId,
    providerID,
    "remove",
    "Failed to remove account",
    () =>
      ctx.client.provider.accounts.remove(
        { providerID, accountID, directory: ctx.workspaceDir },
        { throwOnError: true },
      ),
    true,
  )
}

export async function setProviderAccountStrategy(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  value: string,
) {
  const strategy = cleanStrategy(value)
  if (!strategy) return postAccountError(ctx, requestId, providerID, "strategy", "Unknown strategy")
  await ask(ctx, requestId, providerID, "strategy", "Failed to save strategy", () =>
    ctx.client.provider.accounts.strategy(
      { providerID, strategy, directory: ctx.workspaceDir },
      { throwOnError: true },
    ),
  )
}

export async function verifyProviderAccount(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  accountID: string,
) {
  try {
    const { data } = await ctx.client.provider.accounts.verify(
      { providerID, accountID, directory: ctx.workspaceDir },
      { throwOnError: true },
    )
    ctx.postMessage({
      type: "providerAccountVerified",
      requestId,
      providerID,
      accountID,
      status: data?.status ?? "unknown",
      httpStatus: data?.httpStatus,
    })
  } catch (error) {
    postAccountError(ctx, requestId, providerID, "verify", ctx.getErrorMessage(error) || "Failed to verify account")
  }
}

/**
 * Fetch a provider's model list with its stored key. The backend only uses the
 * key for the URL the provider is configured for, so the secret never leaves it.
 */
export async function fetchProviderModels(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  baseURL: string,
  headers?: Record<string, string>,
) {
  try {
    const { data } = await ctx.client.provider.models.fetch(
      { providerID, baseURL, headers, directory: ctx.workspaceDir },
      { throwOnError: true },
    )
    const models = (data?.models ?? []).map((item) => ({ id: item.id, name: item.name ?? item.id }))
    ctx.postMessage({ type: "customProviderModelsFetched", requestId, models })
  } catch (error) {
    const status = (error as { status?: unknown }).status
    ctx.postMessage({
      type: "customProviderModelsFetched",
      requestId,
      error: ctx.getErrorMessage(error) || "Failed to fetch models",
      auth: status === 401 || status === 403,
    })
  }
}
