import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global" // kilocode_change - account test seeding
import { Effect, Layer } from "effect"
import { mkdir, readFile, rm, writeFile } from "fs/promises" // kilocode_change - account test seeding
import path from "path"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { preparePluginDependencies } from "../kilocode/plugin-dependencies" // kilocode_change
import { httpApiLayer, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, LayerNode.compile(FSUtil.node), httpApiLayer))
const projectOptions = { config: { formatter: false, lsp: false } }
// kilocode_change start - shared setup for tests that seed API-key accounts
type Entry = {
  id: string
  label: string
  maskedKey: string
  status?: string
  cooldownUntil?: number
  quota?: { limit?: number; remaining?: number; resetAt?: number }
}
type Group = { accounts: Entry[]; active: string; strategy: string }
type Answer = { status: number; retryAfter?: string; headers?: Record<string, string> }

// A config provider pins the credential probe URL; the handler reads it from the model.
const probeOptions = {
  ...projectOptions,
  config: {
    ...projectOptions.config,
    provider: { groq: { api: "https://api.groq.test/v1", models: { "probe-model": { name: "Probe" } } } },
  },
}

/** Restores the shared auth.json and the network afterwards, and answers probes locally. */
const health = <A, E, R>(
  status: number,
  run: (headers: Record<string, string>, answer: Answer) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const headers = { "x-kilo-directory": directory, "content-type": "application/json" }
    const answer: Answer = { status }
    const file = path.join(Global.Path.data, "auth.json")
    const before = yield* Effect.promise(() => readFile(file, "utf8").catch(() => undefined))
    const original = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.includes("api.groq.test")) {
          const headers = {
            ...(answer.retryAfter === undefined ? {} : { "retry-after": answer.retryAfter }),
            ...answer.headers,
          }
          return new Response("not authorized", {
            status: answer.status,
            ...(Object.keys(headers).length === 0 ? {} : { headers }),
          })
        }
        return original(input, init)
      },
      { preconnect: original.preconnect },
    )
    return yield* run(headers, answer).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          globalThis.fetch = original
          if (before === undefined) await rm(file, { force: true })
          else await writeFile(file, before, { mode: 0o600 })
        }),
      ),
    )
  })

/** Parses an accounts response. */
const view = <E, R>(response: { readonly json: Effect.Effect<unknown, E, R> }) =>
  response.json as Effect.Effect<Group, E, R>

/** Stores two accounts and returns their ids. */
const seed = (headers: Record<string, string>, keys: readonly [string, string]) =>
  Effect.gen(function* () {
    const response = yield* request("/provider/groq/accounts", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        accounts: [
          { label: "Team A", key: keys[0] },
          { label: "Team B", key: keys[1] },
        ],
      }),
    })
    expect(response.status).toBe(200)
    const group = yield* view(response)
    return { first: group.accounts[0]!.id, second: group.accounts[1]!.id, active: group.active }
  })

/** Probes a key and returns the status the probe reported. */
const verify = (headers: Record<string, string>, accountID: string) =>
  Effect.gen(function* () {
    const response = yield* request("/provider/groq/accounts/verify", {
      method: "POST",
      headers,
      body: JSON.stringify({ accountID }),
    })
    expect(response.status).toBe(200)
    return ((yield* response.json) as { status: string }).status
  })
// kilocode_change end
const providerID = "test-oauth-parity"
const oauthURL = "https://example.com/oauth"
const oauthInstructions = "Finish OAuth"

function providerListHasFetch(list: unknown) {
  if (!Array.isArray(list)) return false
  return list.some((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("options" in item)) return false
    if (item.id !== "google") return false
    if (typeof item.options !== "object" || item.options === null) return false
    return "fetch" in item.options
  })
}

function hasProviderWithFetch(input: unknown, key: "all" | "providers") {
  if (typeof input !== "object" || input === null) return false
  if (key === "all") return "all" in input && providerListHasFetch(input.all)
  return "providers" in input && providerListHasFetch(input.providers)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function providerList(input: unknown, key: "all" | "providers") {
  if (!isRecord(input)) return []
  if (!Array.isArray(input[key])) return []
  return input[key]
}

function providerByID(input: unknown, key: "all" | "providers", id: string) {
  return providerList(input, key).find((provider) => isRecord(provider) && provider.id === id)
}

function hasNonZeroModelCost(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider) || !isRecord(provider.models)) return false
  return Object.values(provider.models).some((model) => {
    if (!isRecord(model) || !isRecord(model.cost) || !isRecord(model.cost.cache)) return false
    return [model.cost.input, model.cost.output, model.cost.cache.read, model.cost.cache.write].some(
      (cost) => typeof cost === "number" && cost > 0,
    )
  })
}

function hasProviderMutationMarker(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider)) return false
  if (provider.name === "mutated-provider") return true
  return isRecord(provider.options) && provider.options.mutatedByPlugin === true
}

function requestAuthorize(input: {
  providerID: string
  method: number
  headers: HeadersInit
  inputs?: Record<string, string>
}) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/authorize`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.inputs ? { inputs: input.inputs } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function requestCallback(input: { providerID: string; method: number; headers: HeadersInit; code?: string }) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/callback`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.code ? { code: input.code } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function writeProviderAuthPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => preparePluginDependencies(dir)) // kilocode_change

    yield* fs.writeWithDirs(
      path.join(dir, ".kilo", "plugin", "provider-oauth-parity.ts"), // kilocode_change
      [
        "export default {",
        '  id: "test.provider-oauth-parity",',
        "  server: async () => ({",
        "    auth: {",
        `      provider: "${providerID}",`,
        "      methods: [",
        '        { type: "api", label: "API key" },',
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderAuthValidationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => preparePluginDependencies(dir)) // kilocode_change

    yield* fs.writeWithDirs(
      path.join(dir, ".kilo", "plugin", "provider-oauth-validation.ts"), // kilocode_change
      [
        "export default {",
        '  id: "test.provider-oauth-validation",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "test-oauth-validation",',
        "      methods: [",
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          prompts: [",
        "            {",
        '              type: "text",',
        '              key: "token",',
        '              message: "Token",',
        "              validate: (value) => value === 'ok' ? undefined : 'Token must be ok',",
        "            },",
        "          ],",
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeFunctionOptionsPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => preparePluginDependencies(dir)) // kilocode_change

    yield* fs.writeWithDirs(
      path.join(dir, ".kilo", "plugin", "provider-function-options.ts"), // kilocode_change
      [
        "export default {",
        '  id: "test.provider-function-options",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "google",',
        "      loader: async (_getAuth, provider) => {",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return {",
        '        apiKey: "",',
        "        fetch: async (input, init) => fetch(input, init),",
        "        }",
        "      },",
        "      methods: [{ type: 'api', label: 'API key' }],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderModelsMutationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => preparePluginDependencies(dir)) // kilocode_change

    yield* fs.writeWithDirs(
      path.join(dir, ".kilo", "plugin", "provider-models-mutation.ts"), // kilocode_change
      [
        "export default {",
        '  id: "test.provider-models-mutation",',
        "  server: async () => ({",
        "    provider: {",
        '      id: "google",',
        "      models: async (provider) => {",
        "        const models = Object.fromEntries(",
        "          Object.entries(provider.models ?? {}).map(([id, model]) => [id, { ...model }]),",
        "        )",
        '        provider.name = "mutated-provider"',
        "        provider.options = { ...provider.options, mutatedByPlugin: true }",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return models",
        "      },",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function setEnvScoped(key: string, value: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      process.env[key] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )
}

describe("provider HttpApi", () => {
  it.instance.skip(
    "returns public v2 provider not found errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* request("/api/provider/missing", {
        headers: { "x-kilo-directory": directory },
      })

      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({
        _tag: "ProviderNotFoundError",
        providerID: "missing",
        message: "Provider not found: missing",
      })
    }),
    projectOptions,
  )

  it.instance(
    "serves OAuth authorize response shapes",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-kilo-directory": directory, "content-type": "application/json" }
      const api = yield* requestAuthorize({
        providerID,
        method: 0,
        headers,
      })
      // method 0 (api-key style) — authorize() resolves with no further
      // redirect; #26474 changed the wire format to JSON `null` so clients
      // can `.json()` parse uniformly instead of getting an empty body
      // that throws.
      expect(api).toEqual({ status: 200, body: "null" })

      const oauth = yield* requestAuthorize({
        providerID,
        method: 1,
        headers,
      })
      expect(JSON.parse(oauth.body)).toEqual({
        url: oauthURL,
        method: "code",
        instructions: oauthInstructions,
      })
    }),
    { ...projectOptions, init: writeProviderAuthPlugin },
    30000,
  )

  it.instance(
    "returns declared provider auth validation errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestAuthorize({
        providerID: "test-oauth-validation",
        method: 0,
        inputs: { token: "nope" },
        headers: { "x-kilo-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthValidationFailed",
        data: { field: "token", message: "Token must be ok" },
      })
    }),
    { ...projectOptions, init: writeProviderAuthValidationPlugin },
    30000,
  )

  it.instance(
    "returns declared provider auth callback errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestCallback({
        providerID,
        method: 0,
        headers: { "x-kilo-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthOauthMissing",
        data: { providerID },
      })
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "serves provider lists when auth loaders add runtime fetch options",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped(
        "KILO_AUTH_CONTENT",
        JSON.stringify({
          google: { type: "oauth", refresh: "dummy", access: "dummy", expires: 9999999999999 },
        }),
      )
      const headers = { "x-kilo-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      // kilocode_change start - persisted Kilo credentials count as connected providers
      expect(isRecord(providerBody) && Array.isArray(providerBody.connected) ? providerBody.connected : []).toContain(
        "google",
      )
      // kilocode_change end
      expect(hasProviderWithFetch(providerBody, "all")).toBe(false)
      expect(hasProviderWithFetch(configBody, "providers")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
      expect(hasNonZeroModelCost(configBody, "providers", "google")).toBe(true)
    }),
    { ...projectOptions, init: writeFunctionOptionsPlugin },
  )

  // kilocode_change start - API-key account management coverage
  it.instance(
    "manages API-key accounts and never returns raw keys",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-kilo-directory": directory, "content-type": "application/json" }
      const authFile = path.join(Global.Path.data, "auth.json")
      const rawKey = "gsk_test_1234567890abcdef"
      const before = yield* Effect.promise(() => readFile(authFile, "utf8").catch(() => undefined))
      const restore = Effect.promise(async () => {
        if (before === undefined) await rm(authFile, { force: true })
        else await writeFile(authFile, before, { mode: 0o600 })
      })
      yield* Effect.promise(async () => {
        await mkdir(Global.Path.data, { recursive: true })
        const current = before ? (JSON.parse(before) as Record<string, unknown>) : {}
        await writeFile(authFile, JSON.stringify({ ...current, groq: { type: "api", key: rawKey } }, null, 2), {
          mode: 0o600,
        })
      })

      try {
        const listed = yield* request("/provider/groq/accounts", { headers })
        expect(listed.status).toBe(200)
        const initial = (yield* listed.json) as {
          accounts: Array<{ id: string; maskedKey: string }>
          strategy: string
        }
        expect(initial.accounts).toHaveLength(1)
        expect(initial.accounts[0]?.maskedKey).toBe(`••••${rawKey.slice(-4)}`)
        expect(initial.strategy).toBe("manual")
        expect(JSON.stringify(initial)).not.toContain(rawKey)

        const put = yield* request("/provider/groq/accounts", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            accounts: [
              { label: "Team A", key: "gsk_alpha_0001" },
              { label: "Team B", key: "gsk_beta_0002" },
            ],
            strategy: "failover",
          }),
        })
        expect(put.status).toBe(200)
        const updated = (yield* put.json) as {
          accounts: Array<{ id: string; label: string; maskedKey: string }>
          strategy: string
        }
        expect(updated.accounts).toHaveLength(2)
        expect(updated.strategy).toBe("failover")
        expect(updated.accounts.map((item) => item.label)).toEqual(["Team A", "Team B"])
        expect(JSON.stringify(updated)).not.toContain("gsk_alpha_0001")
        const second = updated.accounts[1]!.id

        const activate = yield* request(`/provider/groq/accounts/${second}/activate`, { method: "POST", headers })
        expect(activate.status).toBe(200)
        expect(((yield* activate.json) as { active: string }).active).toBe(second)

        const strategy = yield* request("/provider/groq/accounts/strategy", {
          method: "PUT",
          headers,
          body: JSON.stringify({ strategy: "roundRobin" }),
        })
        expect(strategy.status).toBe(200)
        expect(((yield* strategy.json) as { strategy: string }).strategy).toBe("roundRobin")

        // PUT /auth rotates only the active account's key; the other accounts survive.
        const rotate = yield* request("/auth/groq", {
          method: "PUT",
          headers,
          body: JSON.stringify({ type: "api", key: "gsk_rotated_0009" }),
        })
        expect(rotate.status).toBe(200)
        const after = yield* request("/provider/groq/accounts", { headers })
        const rotated = (yield* after.json) as {
          accounts: Array<{ id: string; maskedKey: string }>
          active: string
        }
        expect(rotated.accounts).toHaveLength(2)
        expect(rotated.accounts.find((item) => item.id === rotated.active)?.maskedKey).toBe("••••0009")
        expect(rotated.accounts.filter((item) => item.id !== rotated.active).map((item) => item.maskedKey)).toEqual([
          "••••0001",
        ])

        const removed = yield* request(`/provider/groq/accounts/${second}`, { method: "DELETE", headers })
        expect(removed.status).toBe(200)
        expect(((yield* removed.json) as { accounts: unknown[] }).accounts).toHaveLength(1)

        const providers = yield* request("/provider", { headers })
        expect(providers.status).toBe(200)
        const body = (yield* providers.json) as { all: Array<{ id: string; key?: string }> }
        expect(JSON.stringify(body)).not.toContain(rawKey)
        expect(JSON.stringify(body)).not.toContain("gsk_alpha_0001")
        // Team A is the remaining account after the delete, so it is the masked active key
        expect(body.all.find((item) => item.id === "groq")?.key).toBe("••••0001")

        // The stored key may only be sent to the URL the provider is configured for.
        const mismatched = yield* request("/provider/groq/models", {
          method: "POST",
          headers,
          body: JSON.stringify({ baseURL: "https://evil.example.com/v1" }),
        })
        expect(mismatched.status).toBe(400)
        expect(JSON.stringify(yield* mismatched.json)).not.toContain("gsk_alpha_0001")
      } finally {
        yield* restore
      }
    }),
    projectOptions,
    30000,
  )
  // kilocode_change end

  // kilocode_change start - verify persists account health
  it.instance(
    "persists account health after a credential probe",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-kilo-directory": directory, "content-type": "application/json" }
      const authFile = path.join(Global.Path.data, "auth.json")
      const before = yield* Effect.promise(() => readFile(authFile, "utf8").catch(() => undefined))
      const restore = Effect.promise(async () => {
        if (before === undefined) await rm(authFile, { force: true })
        else await writeFile(authFile, before, { mode: 0o600 })
      })
      // Probe the handler's credential check against a canned answer instead of the network.
      const probe = { status: 401 }
      const original = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.includes("api.groq.test")) return new Response("not authorized", { status: probe.status })
        return original(input, init)
      }) as typeof fetch

      try {
        const seeded = yield* request("/provider/groq/accounts", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            accounts: [
              { label: "Team A", key: "gsk_health_0001" },
              { label: "Team B", key: "gsk_health_0002" },
            ],
          }),
        })
        expect(seeded.status).toBe(200)
        const created = (yield* seeded.json) as { accounts: Array<{ id: string }> }
        const first = created.accounts[0]!.id

        const invalid = yield* request("/provider/groq/accounts/verify", {
          method: "POST",
          headers,
          body: JSON.stringify({ accountID: first }),
        })
        expect(((yield* invalid.json) as { status: string }).status).toBe("invalid")

        const stored = yield* request("/provider/groq/accounts", { headers })
        const afterInvalid = (yield* stored.json) as { accounts: Array<{ id: string; status?: string }> }
        expect(afterInvalid.accounts.find((item) => item.id === first)?.status).toBe("invalid")
        expect(afterInvalid.accounts.find((item) => item.id !== first)?.status).toBeUndefined()

        probe.status = 200
        const ok = yield* request("/provider/groq/accounts/verify", {
          method: "POST",
          headers,
          body: JSON.stringify({ accountID: first }),
        })
        expect(((yield* ok.json) as { status: string }).status).toBe("ok")

        const reread = yield* request("/provider/groq/accounts", { headers })
        const afterOk = (yield* reread.json) as { accounts: Array<{ id: string; status?: string }> }
        expect(afterOk.accounts.find((item) => item.id === first)?.status).toBe("ok")
      } finally {
        globalThis.fetch = original
        yield* restore
      }
    }),
    {
      ...projectOptions,
      config: {
        ...projectOptions.config,
        // A config provider pins the probe URL; the handler reads it from the model.
        provider: {
          groq: { api: "https://api.groq.test/v1", models: { "probe-model": { name: "Probe" } } },
        },
      },
    },
    30000,
  )
  // kilocode_change end

  // kilocode_change start - account health survives the server's own writes
  it.instance(
    "keeps account health while the dialog saves the account list",
    health(401, (headers) =>
      Effect.gen(function* () {
        const { first, second } = yield* seed(headers, ["gsk_merge_0001", "gsk_merge_0002"])
        expect(yield* verify(headers, first)).toBe("invalid")

        // What the dialog sends: known accounts by id without a key, plus one new key.
        const saved = yield* request("/provider/groq/accounts", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            accounts: [
              { id: first, label: "Team A" },
              { id: second, label: "Team B" },
              { label: "Team C", key: "gsk_merge_0003" },
            ],
            strategy: "failover",
          }),
        })
        expect(saved.status).toBe(200)
        const after = yield* view(saved)
        expect(after.strategy).toBe("failover")
        expect(after.accounts).toHaveLength(3)
        expect(after.accounts.slice(0, 2).map((item) => item.id)).toEqual([first, second])
        // The health update of the earlier probe survives the save.
        expect(after.accounts.find((item) => item.id === first)?.status).toBe("invalid")
        expect(after.accounts.find((item) => item.id === first)?.maskedKey).toBe("••••0001")
        expect(JSON.stringify(after)).not.toContain("gsk_merge_")
      }),
    ),
    probeOptions,
    30000,
  )

  it.instance(
    "keeps account health while an account is removed",
    health(401, (headers) =>
      Effect.gen(function* () {
        const { first, second } = yield* seed(headers, ["gsk_remove_0001", "gsk_remove_0002"])
        expect(yield* verify(headers, first)).toBe("invalid")

        const removed = yield* request(`/provider/groq/accounts/${second}`, { method: "DELETE", headers })
        expect(removed.status).toBe(200)
        const after = yield* view(removed)
        expect(after.accounts).toHaveLength(1)
        expect(after.accounts[0]!.id).toBe(first)
        // The health update of the earlier probe survives the removal.
        expect(after.accounts[0]!.status).toBe("invalid")
        expect(after.accounts[0]!.maskedKey).toBe("••••0001")

        const unknown = yield* request("/provider/groq/accounts/missing", { method: "DELETE", headers })
        expect(unknown.status).toBe(400)
        const last = yield* request(`/provider/groq/accounts/${first}`, { method: "DELETE", headers })
        expect(last.status).toBe(400)
      }),
    ),
    probeOptions,
    30000,
  )

  it.instance(
    "keeps account health while the strategy changes",
    health(401, (headers) =>
      Effect.gen(function* () {
        const { first, active } = yield* seed(headers, ["gsk_strategy_0001", "gsk_strategy_0002"])
        expect(yield* verify(headers, first)).toBe("invalid")

        const switched = yield* request("/provider/groq/accounts/strategy", {
          method: "PUT",
          headers,
          body: JSON.stringify({ strategy: "roundRobin" }),
        })
        expect(switched.status).toBe(200)
        const after = yield* view(switched)
        expect(after.strategy).toBe("roundRobin")
        expect(after.accounts).toHaveLength(2)
        // The health update of the earlier probe survives the strategy switch.
        expect(after.accounts.find((item) => item.id === first)?.status).toBe("invalid")
        expect(after.active).toBe(active)

        const empty = yield* request("/provider/strategy-empty/accounts/strategy", {
          method: "PUT",
          headers,
          body: JSON.stringify({ strategy: "failover" }),
        })
        expect(empty.status).toBe(400)
      }),
    ),
    probeOptions,
    30000,
  )

  it.instance(
    "keeps account health while an account is activated",
    health(401, (headers, answer) =>
      Effect.gen(function* () {
        const { first, second } = yield* seed(headers, ["gsk_activate_0001", "gsk_activate_0002"])
        expect(yield* verify(headers, first)).toBe("invalid")
        // The provider throttles the second key and advertises a two minute wait.
        answer.status = 429
        answer.retryAfter = "120"
        answer.headers = { "x-ratelimit-limit": "40", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "120" }
        expect(yield* verify(headers, second)).toBe("rateLimited")
        const before = yield* view(yield* request("/provider/groq/accounts", { headers }))
        const cooling = before.accounts.find((item) => item.id === second)
        const until = cooling?.cooldownUntil
        expect(until).toBeGreaterThan(Date.now() + 100_000)
        // The quota the provider reported is stored for the dialog and selection.
        expect(cooling?.quota?.remaining).toBe(0)
        expect(cooling?.quota?.limit).toBe(40)
        expect(cooling?.quota?.resetAt).toBeGreaterThan(Date.now() + 100_000)

        const activated = yield* request(`/provider/groq/accounts/${second}/activate`, { method: "POST", headers })
        expect(activated.status).toBe(200)
        const after = yield* view(activated)
        expect(after.active).toBe(second)
        expect(after.accounts.map((item) => item.id)).toEqual([first, second])
        // Neither the rejected key nor the cooldown of the other account changed.
        expect(after.accounts.find((item) => item.id === first)?.status).toBe("invalid")
        expect(after.accounts.find((item) => item.id === second)?.status).toBe("cooling")
        expect(after.accounts.find((item) => item.id === second)?.cooldownUntil).toBe(until)
      }),
    ),
    probeOptions,
    30000,
  )
  // kilocode_change end

  // kilocode_change start - labels identify accounts
  it.instance(
    "rejects duplicate account labels",
    health(401, (headers) =>
      Effect.gen(function* () {
        const duplicate = yield* request("/provider/groq/accounts", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            accounts: [
              { label: "Team A", key: "gsk_label_0001" },
              { label: "team a", key: "gsk_label_0002" },
            ],
          }),
        })
        expect(duplicate.status).toBe(400)
        expect((yield* view(yield* request("/provider/groq/accounts", { headers }))).accounts).toHaveLength(0)
      }),
    ),
    probeOptions,
    30000,
  )
  // kilocode_change end

  // kilocode_change start - default labels are chosen server-side
  it.instance(
    "picks a free default label for an account without one",
    health(401, (headers) =>
      Effect.gen(function* () {
        const reply = yield* request("/provider/groq/accounts", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            accounts: [{ label: "Account 2", key: "gsk_free_0001" }, { key: "gsk_free_0002" }],
          }),
        })
        expect(reply.status).toBe(200)
        expect((yield* view(reply)).accounts.map((item) => item.label)).toEqual(["Account 2", "Account 3"])
      }),
    ),
    probeOptions,
    30000,
  )
  // kilocode_change end

  it.instance(
    "keeps provider.models hook input mutations out of provider state",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory

      const headers = { "x-kilo-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      expect(hasProviderMutationMarker(providerBody, "all", "google")).toBe(false)
      expect(hasProviderMutationMarker(configBody, "providers", "google")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
    }),
    { ...projectOptions, init: writeProviderModelsMutationPlugin },
  )
})
