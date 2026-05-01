# carto

[![npm version](https://img.shields.io/npm/v/carto-md)](https://www.npmjs.com/package/carto-md)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/carto-md)](https://www.npmjs.com/package/carto-md)

**Your code changes. AGENTS.md updates. Every AI always knows.**

Carto auto-generates and auto-maintains your `AGENTS.md` file each and every time you save, your routes, models, functions, and dependencies are extracted and written into the standard file every AI coding tool already reads.

---

## Origin

I was building [Emfirge](https://emfirge.cloud) — A Cloud Security Agent.

To make the AI inside Emfirge understand infrastructure, I wrote a module called `cartography.py`. It mapped AWS resources, built a graph of how they connected, and wrote it into a structured map. The AI stopped hallucinating. It worked with accurate facts about the actual infrastructure and just not guesses.

Halfway through, I switched AI tools. Opened a new session. Had to explain everything again from scratch.

I thought: *I just built a cartography system so AI can understand infrastructure. Why doesn't this exist for codebases?*

Carto is that thing with Same insight, different domain. It Map your codebase once and every AI session starts with accurate facts. You never explain your project again.

---

## The problem

AI coding tools are blind to your actual project & every session starts from zero.

> Claude hallucinates your schema
> Copilot suggests the wrong field names
> Kiro asks what framework you're using
> You rebuild context manually, every time

`AGENTS.md` is the standard that fixes this — a file in your project root that every AI tool reads for project context. But it's static. You write it manually. It gets stale the moment your code changes.

**Carto makes it live.**

---

## Why not just paste your code?

Context windows are large now. But pasting code means:

- You decide what's relevant — you're often wrong
- AI sees a snapshot, not your live state
- Bigger context ≠ better context

Carto gives AI the map. You give AI the problem. Different jobs.

---

## How it works

```
You save a file
      ↓
Carto extracts routes, models, functions, env vars
      ↓
AGENTS.md updated in 300ms
      ↓
Cursor, Copilot, Kiro, Codex, Claude — all read current truth
```

---

## Install

```bash
npm install -g carto-md
```

Or run without installing:

```bash
npx carto-md init
```

---

## Usage

```bash
# 1. Go to your project
cd your-project

# 2. Generate AGENTS.md (run once)
carto init

# 3. Keep it live while you work
carto watch
```

Leave `carto watch` running in a background terminal. Every file save updates AGENTS.md automatically.

---

## Commands

| Command | What it does |
|---------|-------------|
| `carto init` | Detect stack, generate AGENTS.md, install git hook |
| `carto watch` | Watch files, update AGENTS.md on every save |
| `carto sync` | One-time refresh, no watcher |
| `carto impact <file>` | Show blast radius before touching a file |
| `carto --version` | Show version |

**When to use each:**
- `init` — once, when you add Carto to a project
- `watch` — every work session, leave it running
- `sync` — if you skipped watch and just want a fresh snapshot
- `impact` — before editing anything critical

---

## What gets extracted automatically

- API routes — FastAPI, Express, Next.js App Router
- Data models — Pydantic, Prisma
- Function signatures — across all files
- Dependencies — from `package.json` / `requirements.txt`
- Environment variable names — never values
- Frontend API calls — from `fetch()` patterns
- Import graph — which files depend on which
- Database tables

---

## What Carto never touches

The manual sections you write directly into `AGENTS.md` — architecture decisions, active bugs, business rules, coding conventions — stay yours forever. Carto only rewrites content between its own markers:

```
<!-- CARTO:AUTO:START -->
... auto-generated content ...
<!-- CARTO:AUTO:END -->

Your manual notes here. Never touched.
```

---

## carto impact

Before touching any file, know the blast radius:

```bash
carto impact app/models.py

# Impact analysis: app/models.py
#
# Imported by:
#   → app/main.py
#   → app/rules.py
#   → app/scoring.py
#   → app/aws_collector.py
#   → tests/conftest.py
#
# Routes affected:
#   → POST /analyze
#   → GET /history
#   → POST /simulate
#   → ... 12 more
#
# Risk: HIGH — 5 files depend on this
```

Most production bugs aren't logic errors. They're *"I didn't know X depended on Y."* Carto makes that invisible knowledge visible before you break something.

---

## What Carto fixes

Carto fixes **factual hallucination about your own project**:

- AI guessing wrong routes → fixed
- AI guessing wrong field names → fixed
- AI assuming wrong framework → fixed
- AI guessing wrong DB schema → fixed

What Carto does not fix: AI reasoning badly, wrong implementation logic, misunderstanding what you want. Carto makes AI **accurate** about your project. Not smarter. Accurate. Different thing.

---

## Real test — cal.com (800k lines)

We ran the same task in two Claude sessions: *"Add a `notes` field to the booking model."*

**Without AGENTS.md:**
- Wrong API route: suggested `POST /api/bookings` → actual is `POST /v2/bookings`
- Wrong handler: suggested `handleNewBooking.ts` → not the creation path
- Wrong file paths: pointed to v1 API (`apps/api/v1/...`) → v1 is legacy
- Wrong tRPC file: `bookings.tsx` → actual is `bookings/_router.tsx`
- Field list: ~15 fields guessed → missing 20+ real fields
- Couldn't proceed without follow-up: *"Want me to write the exact diffs once you confirm the codebase location?"*

**With AGENTS.md (generated by Carto):**
- Correct API route: `POST /v2/bookings` ✅
- Correct controller path ✅
- Correct tRPC file ✅
- All 35+ booking fields returned accurately ✅
- Answered in one shot. No follow-up needed.

**4 wrong file paths → 0. 20 missing fields → 0. Zero follow-up clarifications.**

This is what Carto does. Not smarter AI. The same AI with accurate facts.

---

## AI tools that read AGENTS.md

Drop the file in your project root. Each tool picks it up via its own context config:

- **Cursor** — via context rules
- **GitHub Copilot** — via workspace instructions
- **Kiro** — natively
- **Codex** — natively
- **VS Code** — via workspace context
- **Gemini CLI** — natively
- **Devin** — natively
- **Jules** — natively

---

## Tested on

- FastAPI + Python projects
- Next.js App Router
- Next.js + Prisma
- React + FastAPI monorepos
- Large monorepos (5000+ files — tested on Supabase and cal.com for stability, caps at 50 most important files on projects this scale)

---

## What it does NOT do

- No cloud. No servers. No telemetry. No tracking.
- Your code never leaves your machine.
- No paid tiers. Free forever. MIT license.

---

## Security

Carto never writes secrets into AGENTS.md. `.cartoignore` blocks `.env` files, secret files, key files, and credential files by default. The sanitizer strips API key patterns from extracted code.

---

## Contributing

Python and JS/TS today. Want Go, Ruby, Django, Rails? Open an issue — or read [CONTRIBUTING.md](CONTRIBUTING.md) to add it yourself.

---

## License

MIT — free forever.

---

*Built because AGENTS.md won. Someone had to keep it alive.*
