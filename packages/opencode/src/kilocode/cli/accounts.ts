/**
 * `kilo auth account` commands (kilocode).
 *
 * The operations are plain effects over `Auth.Interface`, so the yargs commands
 * stay thin and tests drive them with an in-memory credential store. They mirror
 * the HTTP account endpoints: masked views, explicit account lists, persisted health.
 */
import type { Argv } from "yargs"
import { Effect, Option } from "effect"
import {
  Auth,
  accountsOf,
  activeAccount,
  DEFAULT_STRATEGY,
  type Account,
  type Info,
  type Interface,
  type Strategy,
} from "@/auth"
import { cmd } from "@/cli/cmd/cmd"
import { effectCmd, fail } from "@/cli/effect-cmd"
import { UI } from "@/cli/ui"
import * as Prompt from "@/cli/effect/prompt"
import { KiloProviderAccounts, type AccountView, type VerifyStatus } from "@/kilocode/provider/accounts"
import { KiloProviderProbe } from "@/kilocode/provider/probe"

const strategies = ["manual", "failover", "roundRobin"] as const

const valid = (value: string): value is Strategy => (strategies as readonly string[]).includes(value)

type View = {
  readonly providerID: string
  readonly active?: string
  readonly strategy: Strategy
  readonly accounts: readonly AccountView[]
}

/** Client-facing view of a provider's accounts: keys stay masked. */
export function view(providerID: string, info: Info): View {
  const active = activeAccount(info)?.id
  return {
    providerID,
    ...(active !== undefined ? { active } : {}),
    strategy: info.type === "api" ? (info.strategy ?? DEFAULT_STRATEGY) : DEFAULT_STRATEGY,
    accounts: accountsOf(info).map(KiloProviderAccounts.viewAccount),
  }
}

/** Match an account by id or, failing that, by label (case-insensitive). */
export function pick(accounts: readonly Account[], query: string) {
  const value = query.trim()
  return (
    accounts.find((item) => item.id === value) ??
    accounts.find((item) => item.label.toLowerCase() === value.toLowerCase())
  )
}

const labels = (accounts: readonly Account[]) => accounts.map((item) => item.label).join(", ")

const api = Effect.fn("Cli.accounts.info")(function* (auth: Interface, providerID: string) {
  const info = yield* auth.get(providerID).pipe(Effect.orDie)
  if (info?.type !== "api")
    return yield* fail(
      `No API-key accounts for "${providerID}". Run \`kilo auth login --provider ${providerID}\` first.`,
    )
  return info
})

const locate = Effect.fn("Cli.accounts.account")(function* (auth: Interface, providerID: string, query: string) {
  const info = yield* api(auth, providerID)
  const accounts = accountsOf(info)
  const account = pick(accounts, query)
  if (!account) return yield* fail(`Unknown account "${query}". Accounts: ${labels(accounts)}`)
  return { accounts, account }
})

type Change = (accounts: readonly Account[]) => readonly Account[]

const save = Effect.fn("Cli.accounts.save")(function* (
  auth: Interface,
  input: { providerID: string; update: Change; active?: string; strategy?: Strategy },
) {
  // `edit` runs the change inside the write lock, so health written by a running
  // server (or another CLI call) survives a concurrent account edit.
  const edit = auth.edit
  if (edit) {
    yield* edit(input.providerID, input.update, { active: input.active, strategy: input.strategy }).pipe(Effect.orDie)
    return view(input.providerID, yield* api(auth, input.providerID))
  }
  const set = auth.setAccounts
  if (!set) return yield* fail("This credential store does not support API-key accounts.")
  const accounts = input.update(accountsOf(yield* api(auth, input.providerID)))
  if (accounts.length === 0) return yield* fail("At least one account is required.")
  yield* set(input.providerID, {
    accounts: [...accounts],
    ...(input.active !== undefined ? { active: input.active } : {}),
    ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
  }).pipe(Effect.orDie)
  return view(input.providerID, yield* api(auth, input.providerID))
})

export const list = Effect.fn("Cli.accounts.list")(function* (auth: Interface, providerID: string) {
  return view(providerID, yield* api(auth, providerID))
})

export const add = Effect.fn("Cli.accounts.add")(function* (
  auth: Interface,
  input: { providerID: string; key: string; label?: string },
) {
  const key = input.key.trim()
  if (!key) return yield* fail("API key is required")
  // The first account creates the provider entry, so `add` works before any login.
  const info = yield* auth.get(input.providerID).pipe(Effect.orDie)
  if (info && info.type !== "api") return yield* fail(`"${input.providerID}" does not use API-key authentication.`)
  const existing = accountsOf(info)
  const label = input.label?.trim()
  // Labels are how `--account` and the dialog address an account, so they must be unique.
  if (label && existing.some((item) => item.label.toLowerCase() === label.toLowerCase()))
    return yield* fail(`An account labelled "${label}" already exists.`)
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  return yield* save(auth, {
    providerID: input.providerID,
    update: (stored) => [...stored, { id, label: label || KiloProviderAccounts.freeLabel(stored), key, createdAt }],
  })
})

/** The key prompt, shared with `auth login`: tests answer it through KILO_TEST_PROMPT_PASSWORD. */
const ask = Effect.gen(function* () {
  const answer = yield* Prompt.password({
    message: "Enter your API key",
    validate: (value) => (value && value.length > 0 ? undefined : "Required"),
  })
  if (Option.isNone(answer)) return yield* fail("Cancelled")
  return answer.value
})

export const remove = Effect.fn("Cli.accounts.remove")(function* (
  auth: Interface,
  input: { providerID: string; query: string },
) {
  const { accounts, account } = yield* locate(auth, input.providerID, input.query)
  if (accounts.length <= 1) return yield* fail("Cannot remove the last account. Use `kilo auth logout` instead.")
  return yield* save(auth, {
    providerID: input.providerID,
    update: (stored) => stored.filter((item) => item.id !== account.id),
  })
})

export const activate = Effect.fn("Cli.accounts.activate")(function* (
  auth: Interface,
  input: { providerID: string; query: string },
) {
  const { account } = yield* locate(auth, input.providerID, input.query)
  return yield* save(auth, { providerID: input.providerID, update: (stored) => stored, active: account.id })
})

export const strategy = Effect.fn("Cli.accounts.strategy")(function* (
  auth: Interface,
  input: { providerID: string; strategy: string },
) {
  if (!valid(input.strategy))
    return yield* fail(`Unknown strategy "${input.strategy}". Use one of: ${strategies.join(", ")}`)
  yield* api(auth, input.providerID)
  return yield* save(auth, { providerID: input.providerID, update: (stored) => stored, strategy: input.strategy })
})

/** Enable or disable an account without touching its key. */
export const enable = Effect.fn("Cli.accounts.enable")(function* (
  auth: Interface,
  input: { providerID: string; query: string; enabled: boolean },
) {
  const { account } = yield* locate(auth, input.providerID, input.query)
  return yield* save(auth, {
    providerID: input.providerID,
    update: (stored) => stored.map((item) => (item.id === account.id ? { ...item, enabled: input.enabled } : item)),
  })
})

/** Replace one account's key, e.g. `kilo auth login --account <id>`. */
export const replaceKey = Effect.fn("Cli.accounts.replaceKey")(function* (input: {
  auth: Interface
  providerID: string
  query: string
  key: string
  metadata?: Record<string, string>
}) {
  const { account } = yield* locate(input.auth, input.providerID, input.query)
  return yield* save(input.auth, {
    providerID: input.providerID,
    update: (stored) =>
      stored.map((item) => {
        if (item.id !== account.id) return item
        // The failures belonged to the old credential.
        const { status: _status, cooldownUntil: _cooldown, ...rest } = item
        return {
          ...rest,
          key: input.key.trim(),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        }
      }),
  })
})

type Check = {
  readonly providerID: string
  readonly accountID: string
  readonly label: string
  readonly status: VerifyStatus
  readonly httpStatus?: number
}

export const verify = Effect.fn("Cli.accounts.verify")(function* (
  auth: Interface,
  input: {
    providerID: string
    query: string
    /** Model endpoint to probe; without one the result stays "unknown". */
    url?: string
  },
) {
  const { account } = yield* locate(auth, input.providerID, input.query)
  const url = input.url
  const result = url
    ? yield* Effect.promise(() => KiloProviderProbe.probe({ providerID: input.providerID, key: account.key, url }))
    : { status: "unknown" as const, httpStatus: undefined }

  // Persist health so later turns and the account dialog agree without a failing turn.
  const state = KiloProviderAccounts.verified(result.status, result.retryAfter)
  const health = state || result.quota ? { ...state, ...(result.quota ? { quota: result.quota } : {}) } : undefined
  const mark = auth.markAccount
  if (health && mark)
    yield* mark(input.providerID, account.id, health).pipe(
      Effect.catch((error) => Effect.logWarning("failed to persist provider account health", { error })),
    )

  return {
    providerID: input.providerID,
    accountID: account.id,
    label: account.label,
    status: result.status,
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
  } satisfies Check
})

/** Verify every stored account of one provider. */
export const verifyAll = Effect.fn("Cli.accounts.verifyAll")(function* (
  auth: Interface,
  input: { providerID: string; url?: string },
) {
  const info = yield* api(auth, input.providerID)
  return yield* Effect.forEach(
    accountsOf(info),
    (account) => verify(auth, { providerID: input.providerID, query: account.id, url: input.url }),
    { concurrency: 1 },
  )
})

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const options = (yargs: Argv) =>
  yargs
    .option("provider", { alias: ["p"], describe: "provider id", type: "string", demandOption: true })
    .option("json", { describe: "print JSON instead of formatted text", type: "boolean", default: false })

const print = (payload: unknown) => console.log(JSON.stringify(payload, null, 2))

const show = (payload: View) =>
  Effect.gen(function* () {
    yield* Prompt.intro(`Accounts ${UI.Style.TEXT_DIM}${payload.providerID} • ${payload.strategy}`)
    for (const account of payload.accounts) {
      const marks = [
        account.id === payload.active ? "active" : undefined,
        account.enabled ? undefined : "disabled",
        account.status,
      ].filter((value): value is string => value !== undefined)
      yield* Prompt.log.info(
        `${account.label} ${UI.Style.TEXT_DIM}${account.maskedKey}${marks.length > 0 ? " " + marks.join(" ") : ""}`,
      )
    }
    yield* Prompt.outro(`${payload.accounts.length} account${payload.accounts.length === 1 ? "" : "s"}`)
  })

const output = (payload: View, json: boolean) => (json ? Effect.sync(() => print(payload)) : show(payload))

const ProvidersAccountListCommand = effectCmd({
  command: "list",
  describe: "list the API-key accounts of a provider",
  instance: false,
  builder: options,
  handler: Effect.fn("Cli.accounts.list")(function* (args) {
    yield* output(yield* list(yield* Auth.Service, args.provider), args.json)
  }),
})

const ProvidersAccountAddCommand = effectCmd({
  command: "add [key]",
  describe: "add an API-key account to a provider (prompts for the key when omitted)",
  instance: false,
  builder: (yargs: Argv) =>
    options(yargs)
      .positional("key", { describe: "API key of the account; prompted when omitted", type: "string" })
      .option("label", { alias: ["l"], describe: "display name of the account", type: "string" }),
  handler: Effect.fn("Cli.accounts.add")(function* (args) {
    const auth = yield* Auth.Service
    // A key on the command line ends up in the shell history, so prompting is the default.
    const key = args.key ?? (yield* ask)
    yield* output(yield* add(auth, { providerID: args.provider, key, label: args.label }), args.json)
  }),
})

const ProvidersAccountRemoveCommand = effectCmd({
  command: "remove <account>",
  describe: "remove an API-key account from a provider",
  instance: false,
  builder: (yargs: Argv) =>
    options(yargs).positional("account", { describe: "account id or label", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.accounts.remove")(function* (args) {
    const auth = yield* Auth.Service
    yield* output(yield* remove(auth, { providerID: args.provider, query: args.account }), args.json)
  }),
})

const ProvidersAccountActivateCommand = effectCmd({
  command: "activate <account>",
  describe: "make an account the active one",
  instance: false,
  builder: (yargs: Argv) =>
    options(yargs).positional("account", { describe: "account id or label", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.accounts.activate")(function* (args) {
    const auth = yield* Auth.Service
    yield* output(yield* activate(auth, { providerID: args.provider, query: args.account }), args.json)
  }),
})

const ProvidersAccountEnableCommand = effectCmd({
  command: "enable <account>",
  describe: "use an account again",
  instance: false,
  builder: (yargs: Argv) =>
    options(yargs).positional("account", { describe: "account id or label", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.accounts.enable")(function* (args) {
    const auth = yield* Auth.Service
    yield* output(yield* enable(auth, { providerID: args.provider, query: args.account, enabled: true }), args.json)
  }),
})

const ProvidersAccountDisableCommand = effectCmd({
  command: "disable <account>",
  describe: "stop using an account without deleting it",
  instance: false,
  builder: (yargs: Argv) =>
    options(yargs).positional("account", { describe: "account id or label", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.accounts.disable")(function* (args) {
    const auth = yield* Auth.Service
    yield* output(yield* enable(auth, { providerID: args.provider, query: args.account, enabled: false }), args.json)
  }),
})

const ProvidersAccountStrategyCommand = effectCmd({
  command: "strategy <strategy>",
  describe: "choose how accounts rotate (manual, failover, roundRobin)",
  instance: false,
  builder: (yargs: Argv) =>
    options(yargs).positional("strategy", {
      describe: "manual, failover or roundRobin",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.accounts.strategy")(function* (args) {
    const auth = yield* Auth.Service
    yield* output(yield* strategy(auth, { providerID: args.provider, strategy: args.strategy }), args.json)
  }),
})

// The probe URL comes from the provider's model metadata, like the HTTP endpoint.
const probeURL = (providerID: string) =>
  Effect.gen(function* () {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const provider = yield* Provider.Service
    const models = Object.values(yield* provider.list()).find((item) => item.id === providerID)?.models
    return Object.values(models ?? {})
      .map((model) => model.api.url)
      .find((value) => !!value)
  })

const report = (checks: readonly Check[]) =>
  Effect.gen(function* () {
    for (const item of checks)
      yield* Prompt.log.info(
        `${item.label} ${UI.Style.TEXT_DIM}${item.status}${item.httpStatus ? ` (HTTP ${item.httpStatus})` : ""}`,
      )
    const bad = checks.filter((item) => item.status !== "ok").length
    yield* Prompt.outro(bad === 0 ? `${checks.length} accepted` : `${bad} of ${checks.length} need attention`)
  })

const ProvidersAccountVerifyCommand = effectCmd({
  command: "verify [account]",
  describe: "check stored API keys against the provider (one account or --all)",
  builder: (yargs: Argv) =>
    options(yargs)
      .positional("account", { describe: "account id or label", type: "string" })
      .option("all", { describe: "verify every account", type: "boolean", default: false }),
  handler: Effect.fn("Cli.accounts.verify")(function* (args) {
    const auth = yield* Auth.Service
    const url = yield* probeURL(args.provider)
    const checks = args.all
      ? yield* verifyAll(auth, { providerID: args.provider, url })
      : args.account
        ? [yield* verify(auth, { providerID: args.provider, query: args.account, url })]
        : yield* fail("Pass an account id/label or --all")
    if (args.json) print(checks)
    else {
      yield* Prompt.intro(`Verify ${UI.Style.TEXT_DIM}${args.provider}`)
      yield* report(checks)
    }
    if (checks.some((item) => item.status === "invalid" || item.status === "rateLimited"))
      yield* fail(
        `${checks.filter((item) => item.status !== "ok").length} of ${checks.length} account(s) are not usable.`,
      )
  }),
})

export const ProvidersAccountCommand = cmd({
  command: "account",
  describe: "manage the API-key accounts of a provider",
  builder: (yargs) =>
    yargs
      .command(ProvidersAccountListCommand)
      .command(ProvidersAccountAddCommand)
      .command(ProvidersAccountRemoveCommand)
      .command(ProvidersAccountActivateCommand)
      .command(ProvidersAccountEnableCommand)
      .command(ProvidersAccountDisableCommand)
      .command(ProvidersAccountStrategyCommand)
      .command(ProvidersAccountVerifyCommand)
      .demandCommand(),
  async handler() {},
})
