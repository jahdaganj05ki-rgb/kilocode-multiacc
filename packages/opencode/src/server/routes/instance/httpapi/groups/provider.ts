import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth" // kilocode_change - multi-account management

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ProviderV2 } from "@opencode-ai/core/provider"

const root = "/provider"

const ProviderAuthErrorName = Schema.Union([
  Schema.Literal("BadRequest"),
  Schema.Literal("ProviderAuthOauthMissing"),
  Schema.Literal("ProviderAuthOauthCodeMissing"),
  Schema.Literal("ProviderAuthOauthCallbackFailed"),
  Schema.Literal("ProviderAuthValidationFailed"),
])
export class ProviderAuthApiError extends Schema.ErrorClass<ProviderAuthApiError>("ProviderAuthError")(
  {
    name: ProviderAuthErrorName,
    data: Schema.Struct({
      providerID: Schema.optional(ProviderV2.ID),
      field: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 400 },
) {}

// kilocode_change start - API-key account management. Keys are always masked on the wire.
export const ProviderAccountView = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  maskedKey: Schema.String,
  enabled: Schema.Boolean,
  status: Schema.optional(Auth.AccountStatus),
  createdAt: Schema.optional(Schema.Finite),
  lastUsedAt: Schema.optional(Schema.Finite),
  cooldownUntil: Schema.optional(Schema.Finite),
  usage: Schema.optional(Auth.AccountUsage),
  quota: Schema.optional(Auth.AccountQuota),
})

export const ProviderAccountInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
})

export const ProviderAccountsInput = Schema.Struct({
  accounts: Schema.Array(ProviderAccountInput),
  active: Schema.optional(Schema.String),
  strategy: Schema.optional(Auth.Strategy),
})

export const ProviderAccountsResult = Schema.Struct({
  providerID: ProviderV2.ID,
  accounts: Schema.Array(ProviderAccountView),
  active: Schema.optional(Schema.String),
  strategy: Auth.Strategy,
})

export const ProviderAccountsStrategyInput = Schema.Struct({
  strategy: Auth.Strategy,
})

export const ProviderAccountVerifyInput = Schema.Struct({
  accountID: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
})

export const ProviderAccountVerifyResult = Schema.Struct({
  status: Schema.Literals(["ok", "invalid", "rateLimited", "unknown"]),
  httpStatus: Schema.optional(Schema.Finite),
})

export const ProviderModelsFetchInput = Schema.Struct({
  baseURL: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export const ProviderModelsFetchResult = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
    }),
  ),
})
// kilocode_change end

export const ProviderApi = HttpApi.make("provider")
  .add(
    HttpApiGroup.make("provider")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ListResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.list",
            summary: "List providers",
            description: "Get a list of all available AI providers, including both available and connected ones.",
          }),
        ),
        HttpApiEndpoint.get("auth", `${root}/auth`, {
          query: WorkspaceRoutingQuery,
          success: described(ProviderAuth.Methods, "Provider auth methods"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.auth",
            summary: "Get provider auth methods",
            description: "Retrieve available authentication methods for all AI providers.",
          }),
        ),
        HttpApiEndpoint.post("authorize", `${root}/:providerID/oauth/authorize`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAuth.AuthorizeInput,
          success: described(Schema.UndefinedOr(ProviderAuth.Authorization), "Authorization URL and method"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.authorize",
            summary: "Start OAuth authorization",
            description: "Start the OAuth authorization flow for a provider.",
          }),
        ),
        // kilocode_change start - account management endpoints
        HttpApiEndpoint.get("accounts", `${root}/:providerID/accounts`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(ProviderAccountsResult, "Accounts of an API-key provider, keys masked"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.accounts.list",
            summary: "List provider accounts",
            description: "List the API-key accounts of a provider. Keys are masked.",
          }),
        ),
        HttpApiEndpoint.put("accountsSet", `${root}/:providerID/accounts`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAccountsInput,
          success: described(ProviderAccountsResult, "Updated accounts of an API-key provider, keys masked"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.accounts.set",
            summary: "Replace provider accounts",
            description:
              "Create, update or remove API-key accounts in one call. Omitted accounts are removed; omitted keys keep the stored credential.",
          }),
        ),
        HttpApiEndpoint.delete("accountsRemove", `${root}/:providerID/accounts/:accountID`, {
          params: { providerID: ProviderV2.ID, accountID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ProviderAccountsResult, "Remaining accounts, keys masked"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.accounts.remove",
            summary: "Remove a provider account",
            description: "Remove one API-key account from a provider.",
          }),
        ),
        HttpApiEndpoint.post("accountsActivate", `${root}/:providerID/accounts/:accountID/activate`, {
          params: { providerID: ProviderV2.ID, accountID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ProviderAccountsResult, "Accounts with the newly active account, keys masked"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.accounts.activate",
            summary: "Activate a provider account",
            description: "Make one API-key account the active account for its provider.",
          }),
        ),
        HttpApiEndpoint.put("accountsStrategy", `${root}/:providerID/accounts/strategy`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAccountsStrategyInput,
          success: described(ProviderAccountsResult, "Accounts with the updated strategy, keys masked"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.accounts.strategy",
            summary: "Set the account strategy",
            description: "Choose how accounts rotate: manual, failover on auth/quota errors, or round robin per turn.",
          }),
        ),
        HttpApiEndpoint.post("modelsFetch", `${root}/:providerID/models`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderModelsFetchInput,
          success: described(ProviderModelsFetchResult, "Model ids the provider reports for its stored credential"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.models.fetch",
            summary: "Fetch provider models with the stored credential",
            description:
              "List models from a provider's OpenAI-compatible /models endpoint using the active account key. Only allowed for the provider's stored base URL, so a stored key can never be redirected elsewhere.",
          }),
        ),
        HttpApiEndpoint.post("accountsVerify", `${root}/:providerID/accounts/verify`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAccountVerifyInput,
          success: described(ProviderAccountVerifyResult, "Verification outcome for a stored or supplied API key"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.accounts.verify",
            summary: "Verify a provider API key",
            description:
              "Probe the provider's model endpoint with a stored account key or a supplied key and classify the result.",
          }),
        ),
        // kilocode_change end
        HttpApiEndpoint.post("callback", `${root}/:providerID/oauth/callback`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAuth.CallbackInput,
          success: described(Schema.Boolean, "OAuth callback processed successfully"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.callback",
            summary: "Handle OAuth callback",
            description: "Handle the OAuth callback from a provider after user authorization.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "provider",
          description: "Experimental HttpApi provider routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
