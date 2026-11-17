// Subprocess test for `kilo auth login --account <label>`: the whole path from
// argv parsing through the key prompt (answered via KILO_TEST_PROMPT_PASSWORD,
// there is no TTY here) into the stored account list.
import { describe, expect } from "bun:test"
import stripAnsi from "strip-ansi"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

// The CLI writes its own credential store in the tmp home, so the harness'
// inline KILO_AUTH_CONTENT override has to be switched off for these runs.
const env = { KILO_AUTH_CONTENT: "" }

describe("kilo auth login --account (subprocess)", () => {
  cliIt.concurrent(
    "replaces the key of the named account instead of adding one",
    ({ opencode }) =>
      Effect.gen(function* () {
        const added = yield* opencode.spawn(
          ["auth", "account", "add", "sk-original-1111", "--provider", "groq", "--label", "Team B"],
          { env, timeoutMs: 60_000 },
        )
        opencode.expectExit(added, 0)

        const login = yield* opencode.spawn(["auth", "login", "--provider", "groq", "--account", "Team B"], {
          env: { ...env, KILO_TEST_PROMPT_PASSWORD: "sk-replaced-2222" },
          timeoutMs: 60_000,
        })
        opencode.expectExit(login, 0)

        const listed = yield* opencode.spawn(["auth", "account", "list", "--provider", "groq", "--json"], {
          env,
          timeoutMs: 60_000,
        })
        opencode.expectExit(listed, 0)
        const body = JSON.parse(listed.stdout) as { accounts: Array<{ label?: string; maskedKey: string }> }
        // Replaced in place: one account, same label, new key.
        expect(body.accounts).toHaveLength(1)
        expect(body.accounts[0]!.label).toBe("Team B")
        expect(body.accounts[0]!.maskedKey).toBe("••••2222")
      }),
    150_000,
  )

  cliIt.concurrent(
    "prompts for the key when it is omitted from the command line",
    ({ opencode }) =>
      Effect.gen(function* () {
        const added = yield* opencode.spawn(["auth", "account", "add", "--provider", "groq", "--label", "Team C"], {
          env: { ...env, KILO_TEST_PROMPT_PASSWORD: "sk-prompted-4444" },
          timeoutMs: 60_000,
        })
        opencode.expectExit(added, 0)

        const listed = yield* opencode.spawn(["auth", "account", "list", "--provider", "groq", "--json"], {
          env,
          timeoutMs: 60_000,
        })
        opencode.expectExit(listed, 0)
        const body = JSON.parse(listed.stdout) as { accounts: Array<{ label?: string; maskedKey: string }> }
        // Nothing on argv: the key came from the prompt.
        expect(body.accounts).toHaveLength(1)
        expect(body.accounts[0]!.label).toBe("Team C")
        expect(body.accounts[0]!.maskedKey).toBe("••••4444")
      }),
    150_000,
  )

  cliIt.concurrent(
    "rejects an unknown label and leaves the stored key alone",
    ({ opencode }) =>
      Effect.gen(function* () {
        const added = yield* opencode.spawn(
          ["auth", "account", "add", "sk-original-1111", "--provider", "groq", "--label", "Team B"],
          { env, timeoutMs: 60_000 },
        )
        opencode.expectExit(added, 0)

        const login = yield* opencode.spawn(["auth", "login", "--provider", "groq", "--account", "Missing"], {
          env: { ...env, KILO_TEST_PROMPT_PASSWORD: "sk-other-3333" },
          timeoutMs: 60_000,
        })
        expect(login.exitCode).not.toBe(0)
        expect(stripAnsi(login.stderr)).toContain('Unknown account "Missing"')

        const listed = yield* opencode.spawn(["auth", "account", "list", "--provider", "groq", "--json"], {
          env,
          timeoutMs: 60_000,
        })
        opencode.expectExit(listed, 0)
        const body = JSON.parse(listed.stdout) as { accounts: Array<{ maskedKey: string }> }
        expect(body.accounts).toHaveLength(1)
        expect(body.accounts[0]!.maskedKey).toBe("••••1111")
      }),
    150_000,
  )
})
