# Guide: Onboarding a new engineer

> Day 1, hour 1, productive. Without 47 Slack DMs to teammates.

## The cold start

New engineer joins. The repo has 50K lines, three years of history, no architecture docs. The standard onboarding pattern is:

- Day 1–3: Set up tooling. Read README. Get the app running locally.
- Day 4–10: Get assigned a "starter ticket" — a tiny bug fix in a dark corner. Realize you have no idea where to begin.
- Day 11–20: Slack DMs. *"Where does session validation live?"* *"What does this file do?"* *"Is this safe to change?"*
- Day 21+: Maybe starting to feel productive.

That's 3 weeks × $5K/week = $15K of ramp time per hire. Most of it is the new engineer trying to build the mental model of the codebase that everyone else already has.

## What Carto does instead

`carto init` produces three things the new engineer can read on day 1:

1. **`AGENTS.md`** at the project root. Plain markdown. Architecture overview, domain list with file counts, top high-impact files. Skim in 5 minutes.

2. **`.carto/context/<DOMAIN>.md`** for each detected domain. Per-domain context: entry points, key files, common patterns. Read just the ones relevant to your starter ticket.

3. **A live MCP server** their AI tool (Cursor/Claude/Kiro/etc.) is already wired to. Every question the new engineer would have asked in Slack — "where does session validation live?", "what does this file do?", "what's the blast radius of this change?" — is one MCP call away.

## A literal day-1 walk-through

```bash
# new engineer just cloned the repo
git clone …
cd …

# carto is probably already installed; if not:
npm install -g carto-md

# first command they run:
carto init
```

The init banner gives the mirror moment:

```
┌─ Carto · indexed ─────────────────────────────────────────
│  3,847 files · 7 domains · 142 routes · 8,201 import edges
│
│  Top domains:
│    CORE          (1,940 files)
│    DATABASE      (412 files)
│    AUTH          (287 files)
│    PAYMENTS      (235 files)
│
│  💡 Highest-risk file: src/lib/db/client.ts
│     (94 files depend on it — try `carto why src/lib/db/client.ts`)
└───────────────────────────────────────────────────────────
```

They now know:

- This repo has ~4K source files (real size, not the inflated package.json claim)
- It's split into 7 domains they should learn one at a time
- The single most important file is `src/lib/db/client.ts`

Five minutes in, they've replaced 30 minutes of clicking around.

## What to ask first

Three questions every new engineer should ask their AI tool in the first hour:

1. *"Give me the architectural overview of this project."* → calls `get_architecture()`. 500-word summary.

2. *"What's in the AUTH domain?"* (or whichever they're working on) → calls `get_domain("AUTH")`. Routes, models, key files.

3. *"What does `src/lib/db/client.ts` do and what depends on it?"* → calls `get_file_summary()` + `get_blast_radius()`. Now they know the danger zone.

## When they pick up their first ticket

They start with:

```bash
carto explain "fix the bug in user signup where email validation is skipped"
```

This calls `get_change_plan()` — same engine the AI uses. Output:

```
## Plan: fix bug in user signup where email validation is skipped

### Relevant routes
- POST /auth/signup   src/auth/signup.ts:42

### Files to touch
- src/auth/signup.ts        — the route handler (15 direct dependents)
- src/auth/validators.ts    — email validation lives here

### Similar patterns
- src/auth/login.ts already validates email format using validateEmail()
- src/auth/reset-password.ts also uses validateEmail()

### Blast radius
- src/auth/signup.ts: 15 dependent files. Test coverage in
  src/auth/__tests__/signup.test.ts — re-run after change.
```

A new engineer who's never opened `signup.ts` can read this, open the 3 files it names, find the bug, fix it correctly the first time. No Slack DM needed.

## When they break something

Even with Carto, mistakes happen. The two tools that help most:

- **`carto diff`** before committing. Shows the architectural impact of the local change — blast radius, cross-domain violations, files-without-tests. The new engineer self-corrects.
- **The GitHub Action** ([guide](./ci-integration.md)) catches what the new engineer didn't. The PR gets an impact comment; reviewers spot risky changes before merge.

## The team multiplier

Onboarding is the cost the *team* pays for a hire, not just the hire. Every Slack DM from a new engineer is an interruption to a senior. A 1-week ramp instead of a 3-week ramp doesn't just save the new engineer's time — it saves the senior's too.

## Related

- [`docs/quickstart.md`](../quickstart.md) — install + init
- [`docs/concepts/domains.md`](../concepts/domains.md) — how domains are named
- [`docs/guides/adding-feature-safely.md`](./adding-feature-safely.md) — the workflow for the second week onward
