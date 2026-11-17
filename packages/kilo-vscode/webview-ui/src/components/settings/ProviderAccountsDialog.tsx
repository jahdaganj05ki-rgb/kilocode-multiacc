import { Button } from "@kilocode/kilo-ui/button"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { ProviderIcon } from "@kilocode/kilo-ui/provider-icon"
import { Select } from "@kilocode/kilo-ui/select"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { Switch } from "@kilocode/kilo-ui/switch"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { showToast } from "@kilocode/kilo-ui/toast"
import { For, Show, batch, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import type {
  ExtensionMessage,
  ProviderAccount,
  ProviderAccountAction,
  ProviderAccountErrorMessage,
  ProviderAccountStrategy,
  ProviderAccountVerifiedMessage,
  ProviderAccountsMessage,
  WebviewMessage,
} from "../../types/messages"

type Reply =
  | { kind: "accounts"; message: ProviderAccountsMessage }
  | { kind: "verified"; message: ProviderAccountVerifiedMessage }
  | { kind: "error"; message: ProviderAccountErrorMessage }

type Request =
  | Omit<Extract<WebviewMessage, { type: "listProviderAccounts" }>, "requestId">
  | Omit<Extract<WebviewMessage, { type: "saveProviderAccounts" }>, "requestId">
  | Omit<Extract<WebviewMessage, { type: "activateProviderAccount" }>, "requestId">
  | Omit<Extract<WebviewMessage, { type: "removeProviderAccount" }>, "requestId">
  | Omit<Extract<WebviewMessage, { type: "setProviderAccountStrategy" }>, "requestId">
  | Omit<Extract<WebviewMessage, { type: "verifyProviderAccount" }>, "requestId">

const REPLY_TIMEOUT_MS = 20_000

const ACTION_OF: Record<Request["type"], ProviderAccountAction> = {
  listProviderAccounts: "list",
  saveProviderAccounts: "save",
  activateProviderAccount: "activate",
  removeProviderAccount: "remove",
  setProviderAccountStrategy: "strategy",
  verifyProviderAccount: "verify",
}

const STRATEGIES: ProviderAccountStrategy[] = ["manual", "failover", "roundRobin"]

export interface ProviderAccountsDialogProps {
  providerID: string
  name: string
}

const ProviderAccountsDialog = (props: ProviderAccountsDialogProps) => {
  const dialog = useDialog()
  const language = useLanguage()
  const vscode = useVSCode()

  const [accounts, setAccounts] = createSignal<ProviderAccount[]>([])
  const [active, setActive] = createSignal<string>()
  const [strategy, setStrategy] = createSignal<ProviderAccountStrategy>("manual")
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal<string>()
  const [verifying, setVerifying] = createSignal<string>()
  const [label, setLabel] = createSignal("")
  const [key, setKey] = createSignal("")
  const [now, setNow] = createSignal(Date.now())

  const pending = new Map<string, (reply: Reply) => void>()

  onCleanup(
    vscode.onMessage((message: ExtensionMessage) => {
      if (
        message.type !== "providerAccounts" &&
        message.type !== "providerAccountVerified" &&
        message.type !== "providerAccountError"
      )
        return
      const resolve = pending.get(message.requestId)
      if (!resolve) return
      pending.delete(message.requestId)
      resolve(
        message.type === "providerAccounts"
          ? { kind: "accounts", message }
          : message.type === "providerAccountVerified"
            ? { kind: "verified", message }
            : { kind: "error", message },
      )
    }),
  )

  function ask(message: Request): Promise<Reply> {
    const requestId = crypto.randomUUID()
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve({
          kind: "error",
          message: {
            type: "providerAccountError",
            requestId,
            providerID: props.providerID,
            action: ACTION_OF[message.type],
            message: language.t("provider.accounts.timeout"),
          },
        })
      }, REPLY_TIMEOUT_MS)
      pending.set(requestId, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      vscode.postMessage({ ...message, requestId } as WebviewMessage)
    })
  }

  /** Apply an account list reply; returns false when the reply was an error. */
  function apply(reply: Reply): boolean {
    if (reply.kind === "error") {
      setError(reply.message.message)
      return false
    }
    if (reply.kind !== "accounts") return false
    batch(() => {
      setAccounts(reply.message.accounts)
      setActive(reply.message.active)
      setStrategy(reply.message.strategy)
      setError(undefined)
      setLoading(false)
    })
    return true
  }

  async function load() {
    setLoading(true)
    const ok = apply(await ask({ type: "listProviderAccounts", providerID: props.providerID }))
    if (!ok) setLoading(false)
  }

  /** Send the full account list, keeping stored keys for accounts without one. */
  async function save(
    next: Array<{ id?: string; label?: string; key?: string; enabled?: boolean }>,
    extra?: { active?: string; strategy?: ProviderAccountStrategy },
  ) {
    setBusy("save")
    const reply = await ask({
      type: "saveProviderAccounts",
      providerID: props.providerID,
      accounts: next,
      active: extra?.active ?? active(),
      strategy: extra?.strategy ?? strategy(),
    })
    setBusy(undefined)
    return apply(reply)
  }

  async function add() {
    const value = key().trim()
    if (!value) return
    // An empty label lets the backend pick the next free "Account N".
    const next = [
      ...accounts().map((item) => ({ id: item.id, label: item.label, enabled: item.enabled })),
      { label: label().trim() || undefined, key: value },
    ]
    if (!(await save(next))) return
    setLabel("")
    setKey("")
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.accounts.toast.added.title", { provider: props.name }),
      description: language.t("provider.accounts.toast.added.description", { provider: props.name }),
    })
  }

  async function toggle(id: string, enabled: boolean) {
    const next = accounts().map((item) =>
      item.id === id
        ? { id: item.id, label: item.label, enabled }
        : { id: item.id, label: item.label, enabled: item.enabled },
    )
    await save(next)
  }

  async function activate(id: string) {
    setBusy(id)
    const reply = await ask({ type: "activateProviderAccount", providerID: props.providerID, accountID: id })
    setBusy(undefined)
    apply(reply)
  }

  async function remove(id: string) {
    setBusy(id)
    const reply = await ask({ type: "removeProviderAccount", providerID: props.providerID, accountID: id })
    setBusy(undefined)
    apply(reply)
  }

  async function pick(node: ProviderAccountStrategy) {
    const reply = await ask({
      type: "setProviderAccountStrategy",
      providerID: props.providerID,
      strategy: node,
    })
    apply(reply)
  }

  async function move(id: string, delta: number) {
    const list = [...accounts()]
    const from = list.findIndex((item) => item.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= list.length) return
    const [item] = list.splice(from, 1)
    if (!item) return
    list.splice(to, 0, item)
    await save(list.map((entry) => ({ id: entry.id, label: entry.label, enabled: entry.enabled })))
  }

  async function verifyAll() {
    setBusy("verify-all")
    const counts = { ok: 0, invalid: 0, rateLimited: 0, unknown: 0 }
    let failed = false
    for (const account of accounts()) {
      setVerifying(account.id)
      const reply = await ask({ type: "verifyProviderAccount", providerID: props.providerID, accountID: account.id })
      if (reply.kind === "error") {
        setError(reply.message.message)
        failed = true
        break
      }
      if (reply.kind === "verified") counts[reply.message.status] += 1
    }
    setVerifying(undefined)
    setBusy(undefined)
    apply(await ask({ type: "listProviderAccounts", providerID: props.providerID }))
    if (failed) return
    const problems = counts.invalid + counts.rateLimited + counts.unknown
    showToast({
      variant: problems === 0 ? "success" : undefined,
      icon: problems === 0 ? "circle-check" : undefined,
      title: language.t("provider.accounts.verifyAll.done", {
        ok: String(counts.ok),
        count: String(counts.ok + problems),
      }),
      description:
        problems === 0
          ? undefined
          : language.t("provider.accounts.verifyAll.problems", {
              invalid: String(counts.invalid),
              cooling: String(counts.rateLimited),
              unknown: String(counts.unknown),
            }),
    })
  }

  async function verify(id: string) {
    setVerifying(id)
    const reply = await ask({ type: "verifyProviderAccount", providerID: props.providerID, accountID: id })
    setVerifying(undefined)
    if (reply.kind === "error") {
      setError(reply.message.message)
      return
    }
    if (reply.kind !== "verified") return
    const status = reply.message.status
    apply(await ask({ type: "listProviderAccounts", providerID: props.providerID }))
    showToast({
      variant: status === "ok" ? "success" : undefined,
      icon: status === "ok" ? "circle-check" : undefined,
      title: language.t(`provider.accounts.verify.${status}`),
      description: reply.message.httpStatus ? `HTTP ${reply.message.httpStatus}` : undefined,
    })
  }

  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
    void load()
  })

  /** Compact duration, e.g. "42s" or "3h". */
  const span = (ms: number) => {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`
    if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
    return `${Math.round(seconds / 86_400)}d`
  }

  const used = (account: ProviderAccount) =>
    account.lastUsedAt
      ? language.t("provider.accounts.lastUsed", { time: span(now() - account.lastUsedAt) })
      : language.t("provider.accounts.neverUsed")

  const usage = (account: ProviderAccount) => {
    const value = account.usage
    if (!value) return undefined
    return language.t("provider.accounts.usage", {
      turns: String(value.turns),
      tokens: new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
        value.input + value.output,
      ),
      cost: value.cost.toFixed(2),
    })
  }

  /** Quota the provider reported, with the time until it resets. */
  const quota = (account: ProviderAccount) => {
    const value = account.quota
    if (!value || value.remaining === undefined) return undefined
    const left =
      value.limit === undefined
        ? language.t("provider.accounts.quota.left", { remaining: String(value.remaining) })
        : language.t("provider.accounts.quota.of", { remaining: String(value.remaining), limit: String(value.limit) })
    if (value.resetAt === undefined || value.resetAt <= now()) return left
    return `${left} · ${language.t("provider.accounts.quota.reset", { time: span(value.resetAt - now()) })}`
  }

  /** Remaining cooldown in milliseconds, or undefined when the account is not cooling. */
  const cooling = (account: ProviderAccount) => {
    const until = account.cooldownUntil
    return until !== undefined && until > now() ? until : undefined
  }

  /** A cooling or rejected account can be used anyway; the user knows better. */
  const overridden = (account: ProviderAccount) => account.status === "invalid" || cooling(account) !== undefined

  const statusLabel = (account: ProviderAccount) => {
    if (account.enabled === false) return language.t("provider.accounts.status.disabled")
    const left = cooling(account)
    if (left !== undefined) return language.t("provider.accounts.coolingFor", { time: span(left) })
    if (account.status === "invalid") return language.t("provider.accounts.status.invalid")
    if (account.status === "ok") return language.t("provider.accounts.status.ok")
    return language.t("provider.accounts.status.unknown")
  }

  const statusColor = (account: ProviderAccount) => {
    if (account.enabled === false) return "var(--text-weak-base, var(--vscode-descriptionForeground))"
    if (account.status === "invalid" || cooling(account) !== undefined) return "var(--vscode-errorForeground, #f14c4c)"
    if (account.status === "ok") return "var(--vscode-testing-iconPassed, #3fb950)"
    return "var(--text-weak-base, var(--vscode-descriptionForeground))"
  }

  return (
    <Dialog size="large" title={props.name} transition>
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "16px",
          padding: "0 16px 16px 16px",
          "overflow-y": "auto",
          flex: 1,
          width: "100%",
          "box-sizing": "border-box",
        }}
      >
        <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
          <ProviderIcon id={props.providerID} width={20} height={20} />
          <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
            <span style={{ "font-size": "var(--kilo-font-size-14)", "font-weight": "500" }}>
              {language.t("provider.accounts.description")}
            </span>
            <span
              style={{
                "font-size": "var(--kilo-font-size-12)",
                color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
              }}
            >
              {language.t("provider.accounts.strategy.description")}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
          <label
            style={{ "font-size": "var(--kilo-font-size-12)", "font-weight": "500", color: "var(--text-weak-base)" }}
          >
            {language.t("provider.accounts.strategy.label")}
          </label>
          <Select
            options={STRATEGIES}
            current={strategy()}
            value={(item) => item}
            label={(item) => language.t(`provider.accounts.strategy.${item}`)}
            onSelect={(item) => {
              if (item) void pick(item)
            }}
            variant="secondary"
            triggerVariant="settings"
          />
          <Button
            size="small"
            variant="secondary"
            onClick={() => void verifyAll()}
            disabled={loading() || busy() === "verify-all" || accounts().length === 0}
          >
            <Show when={busy() === "verify-all"} fallback={language.t("provider.accounts.action.verifyAll")}>
              <Spinner style={{ width: "12px", height: "12px" }} />
            </Show>
          </Button>
        </div>

        <Show when={!loading()} fallback={<Spinner style={{ width: "16px", height: "16px" }} />}>
          <Show when={accounts().length > 0} fallback={<span>{language.t("provider.accounts.empty")}</span>}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
              <For each={accounts()}>
                {(account, index) => (
                  <div
                    style={{
                      border: "1px solid var(--border-weak-base, var(--vscode-panel-border))",
                      "border-radius": "6px",
                      padding: "10px 12px",
                      display: "flex",
                      "flex-direction": "column",
                      gap: "6px",
                      opacity: account.id === active() ? "1" : "0.9",
                    }}
                  >
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}>
                      <span style={{ "font-size": "var(--kilo-font-size-13)", "font-weight": "500" }}>
                        {account.label}
                      </span>
                      <Show when={account.id === active()}>
                        <span
                          style={{
                            "font-size": "var(--kilo-font-size-11)",
                            padding: "0 6px",
                            "border-radius": "999px",
                            background: "var(--vscode-badge-background)",
                            color: "var(--vscode-badge-foreground)",
                          }}
                        >
                          {language.t("provider.accounts.active")}
                        </span>
                      </Show>
                      <span
                        style={{
                          "font-size": "var(--kilo-font-size-12)",
                          color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                          "font-family": "var(--vscode-editor-font-family, monospace)",
                        }}
                      >
                        {account.maskedKey}
                      </span>
                      <span style={{ "font-size": "var(--kilo-font-size-12)", color: statusColor(account) }}>
                        {statusLabel(account)}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: "10px",
                        "flex-wrap": "wrap",
                        "font-size": "var(--kilo-font-size-12)",
                        color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                      }}
                    >
                      <span>{used(account)}</span>
                      <Show when={quota(account)}>{(text) => <span>{text()}</span>}</Show>
                      <Show when={usage(account)}>{(text) => <span>{text()}</span>}</Show>
                    </div>
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}>
                      <IconButton
                        icon="arrow-up"
                        variant="ghost"
                        aria-label={language.t("provider.accounts.action.moveUp")}
                        disabled={index() === 0 || busy() === "save"}
                        onClick={() => void move(account.id, -1)}
                      />
                      <IconButton
                        icon="arrow-down"
                        variant="ghost"
                        aria-label={language.t("provider.accounts.action.moveDown")}
                        disabled={index() === accounts().length - 1 || busy() === "save"}
                        onClick={() => void move(account.id, 1)}
                      />
                      <Show when={account.id !== active()}>
                        <Button
                          size="small"
                          variant="ghost"
                          onClick={() => void activate(account.id)}
                          disabled={busy() === account.id}
                        >
                          {overridden(account)
                            ? language.t("provider.accounts.action.useAnyway")
                            : language.t("provider.accounts.action.activate")}
                        </Button>
                      </Show>
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => void verify(account.id)}
                        disabled={verifying() === account.id || busy() === account.id}
                      >
                        <Show
                          when={verifying() === account.id}
                          fallback={language.t("provider.accounts.action.verify")}
                        >
                          <Spinner style={{ width: "12px", height: "12px" }} />
                        </Show>
                      </Button>
                      <Switch
                        checked={account.enabled !== false}
                        onChange={(checked: boolean) => void toggle(account.id, checked)}
                        hideLabel
                      >
                        {language.t("provider.accounts.enabled")}
                      </Switch>
                      <Show when={accounts().length > 1}>
                        <IconButton
                          icon="trash"
                          variant="ghost"
                          aria-label={language.t("provider.accounts.action.remove")}
                          disabled={busy() === account.id}
                          onClick={() => void remove(account.id)}
                        />
                      </Show>
                    </div>
                  </div>
                )}
              </For>
              <Show when={strategy() === "failover"}>
                <span
                  style={{
                    "font-size": "var(--kilo-font-size-12)",
                    color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                  }}
                >
                  {language.t("provider.accounts.order.description")}
                </span>
              </Show>
            </div>
          </Show>
        </Show>

        <Show when={error()}>
          {(message) => (
            <span style={{ "font-size": "var(--kilo-font-size-12)", color: "var(--vscode-errorForeground, #f14c4c)" }}>
              {message()}
            </span>
          )}
        </Show>

        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "8px",
            "border-top": "1px solid var(--border-weak-base, var(--vscode-panel-border))",
            "padding-top": "12px",
          }}
        >
          <span
            style={{ "font-size": "var(--kilo-font-size-12)", "font-weight": "500", color: "var(--text-weak-base)" }}
          >
            {language.t("provider.accounts.add.title")}
          </span>
          <div style={{ display: "flex", gap: "8px", "align-items": "stretch" }}>
            <TextField
              label={language.t("provider.accounts.add.label")}
              hideLabel
              placeholder={language.t("provider.accounts.add.labelPlaceholder")}
              value={label()}
              onChange={setLabel}
            />
            <div style={{ flex: 1 }}>
              <TextField
                type="password"
                label={language.t("provider.accounts.add.key")}
                hideLabel
                placeholder={language.t("provider.accounts.add.keyPlaceholder")}
                value={key()}
                onChange={setKey}
              />
            </div>
            <Button
              size="large"
              variant="primary"
              onClick={() => void add()}
              disabled={!key().trim() || busy() === "save"}
            >
              {language.t("provider.accounts.add.submit")}
            </Button>
          </div>
        </div>

        <Button size="large" variant="secondary" onClick={() => dialog.close()}>
          {language.t("common.close")}
        </Button>
      </div>
    </Dialog>
  )
}

export default ProviderAccountsDialog
