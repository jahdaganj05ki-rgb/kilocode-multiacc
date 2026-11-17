---
title: "Multiple API Key Accounts"
description: "Keep several API keys per provider and choose how Kilo switches between them"
---

# Multiple API Key Accounts

Kilo can keep more than one API key per provider. Use it to separate work and personal
keys, to spread load over several keys of the same organisation, or to keep a spare key
ready when one runs into a rate limit.

Accounts are stored in `auth.json` next to your other credentials. Providers that
authenticate through OAuth (Kilo Gateway, for example) keep their single session and are
not affected.

## Add and manage accounts

The first account of a provider works like a normal login. `kilo auth login` replaces the
key of an existing account when you name it with `--account`; `kilo auth account add`
always adds a new one. When you leave out the key, Kilo prompts for it, so the key does
not end up in your shell history.

```bash
# Prompt for the key and add it as a second account
kilo auth account add --provider groq --label "Team B"

# Point an existing login at a named account
kilo auth login --provider groq --account "Team B"

kilo auth account list --provider groq
kilo auth account activate --provider groq --account "Team B"
kilo auth account enable --provider groq --account "Team B"
kilo auth account disable --provider groq --account "Team B"
kilo auth account verify --provider groq --all
kilo auth account remove --provider groq --account "Team B"
```

Labels are how `--account` and the VS Code dialog address an account, so they must be
unique per provider (comparison ignores case). Without `--label`, Kilo picks the next
free `Account N`.

`kilo auth account verify` sends a small request per account and records whether the key
works, was rejected, or is rate limited.

## Pick the account

`kilo auth account strategy` sets what happens when a provider has several accounts.

| Strategy | Behaviour |
| --- | --- |
| `manual` | The active account always serves requests. |
| `failover` | The active account serves until it fails; Kilo then moves to the next usable account and stays there. |
| `roundRobin` | Each turn uses the next usable account. A turn is sticky, so retries and tool calls stay on one account. |

```bash
kilo auth account strategy --provider groq failover
```

The VS Code account dialog (Settings → Providers → *n* accounts) offers the same
strategies as buttons and lets you reorder accounts; the order is the failover order.

## Health, cooldowns and quota

A rejected key (HTTP 401/403) is marked invalid. A throttled or unpaid key (HTTP 402/429)
cools down for the wait the provider advertises, and Kilo caps that wait at one hour so a
misleading header cannot lock an account out for longer.

If the provider reports its rate-limit quota in response headers, Kilo stores the
remaining requests and the reset time. An account with no requests left is skipped until
it resets. The CLI shows the quota in `--json` output, and the dialog shows it under the
key.

When every account is unusable, the active account is still tried: the request fails with
the provider's own error instead of being blocked locally. In the dialog, **Use anyway**
activates a cooling or invalid account.

## JetBrains and headless setups

JetBrains reads the same `auth.json`, so accounts added in the CLI or in VS Code are
available there. In containers and CI, `KILO_AUTH_CONTENT` can hold the full file
contents instead.
