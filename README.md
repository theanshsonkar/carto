# carto

[![npm version](https://img.shields.io/npm/v/carto-md)](https://www.npmjs.com/package/carto-md)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/carto-md)](https://www.npmjs.com/package/carto-md)

**The codebase intelligence layer every AI tool queries instead of guessing.**

```bash
npm install -g carto-md
```

Carto maps your codebase — routes, models, import graph, domain context — and exposes it as a live MCP server that Kiro, Cursor, and Claude can query mid-task. No hallucinations about your own project. No rebuilding context every session.

---

## The problem

AI coding tools are blind to your actual project. Every session starts from zero.

- Claude hallucinates your schema
- Copilot suggests wrong field names
- Kiro asks what framework you're using
- You rebuild context manually, every time

`AGENTS.md` fixes this — a standard file every AI tool reads. But it's static. You write it manually. It gets stale the moment your code changes.

**Carto makes it live. And queryable.**

---

## Proof — cal.com (800k lines)

Same task, two Claude sessions: *"Add a `notes` field to the booking model."*

**Without Carto:**
- Wrong API route: suggested `POST /api/bookings` → actual is `POST /v2/bookings`
- Wrong handler: suggested `handleNewBooking.ts` → not the creation path
- Wrong file paths: pointed to v1 API → v1 is legacy
- Wrong tRPC file: `bookings.tsx` → actual is `bookings/_router.tsx`
- Field list: ~15 fields guessed → missing 20+ real fields

**With Carto:**
- Correct API route ✅
- Correct controller path ✅
- Correct tRPC file ✅
- All 35+ booking fields returned accurately ✅
- Answered in one shot. No follow-up needed.

**4 wrong file paths → 0. 20 missing fields → 0. Zero follow-up clarifications.**

Not smarter AI. The same AI with accurate facts.

---

## How it works

```
carto init
      ↓
Carto maps your codebase
  → AGENTS.md (79 lines — lean map every AI reads)
  → .carto/context/AUTH.md, PAYMENTS.md, TRPC.md, DATABASE.md
  → .carto/map.json (import graph, routes, blast radius)
  → MCP server auto-wired into Kiro, Cursor, Claude Desktop
      ↓
carto watch  (keeps everything live on every file save)
carto serve  (MCP server — AI tools query graph mid-task)
```

---

## MCP — AI queries your codebase live

`carto init` auto-wires the MCP config into Kiro, Cursor, and Claude Desktop automatically. When Kiro or Cursor is mid-task, it can call Carto directly instead of guessing:

**`get_blast_radius("src/lib/payments.ts")`**
```
Files affected:
  → apps/web/app/api/checkout/route.ts
  → apps/web/app/api/webhook/route.ts
  → packages/trpc/routers/billing.ts

Routes at risk:
  → POST /api/checkout
  → POST /api/webhook
  → POST /trpc/createSubscription
```

**`get_routes()`**
```
| Method | Path                        | Handler             |
|--------|-----------------------------|---------------------|
| POST   | /api/auth/signup            | POST                |
| GET    | /api/auth/oauth/me          | GET                 |
| POST   | /trpc/createBooking         | createBooking       |
| GET    | /trpc/getAvailability       | getAvailability     |
| ...    | ...                         | ...                 |
```

**`get_domain("AUTH")`**
Returns `AUTH.md` — all auth routes, session models, JWT functions, env vars.

**`get_structure()`**
Returns import graph, entry points, high impact files, tech stack.

### Manual MCP config (if auto-wire didn't detect your IDE)

**Kiro** — add to `~/.kiro/settings/mcp.json`:
```json
{
  "mcpServers": {
    "carto": {
      "command": "carto",
      "args": ["serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

**Cursor** — add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "carto": {
      "command": "carto",
      "args": ["serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "carto": {
      "command": "carto",
      "args": ["serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Then run `carto serve` in your project directory alongside `carto watch`.

---

## Domain context files

Large codebases kill AI accuracy. A 2900-line AGENTS.md means AI reads 500 lines and guesses the rest.

Carto splits context by domain automatically:

```
AGENTS.md                  → 79 lines, always loaded
.carto/context/
  AUTH.md                  → auth routes, session models, JWT functions
  PAYMENTS.md              → Stripe routes, billing models
  TRPC.md                  → all tRPC procedures
  DATABASE.md              → every model, schema, table
  EVENTS.md                → webhooks, queues, cron jobs
  CORE.md                  → shared utilities
```

AI reads AGENTS.md always. Then reads only the relevant domain file for the current task. 400 lines of exact context instead of 2900 lines of everything.

Domain assignment uses your import graph — files that import each other cluster together, regardless of folder names.

---

## Know what breaks before you break it

```bash
carto impact apps/web/app/api/auth/signup/route.ts

# Impact analysis: apps/web/app/api/auth/signup/route.ts
#
# Imported by:
#   → apps/web/app/api/auth/signup/handlers/calcomSignupHandler.ts
#   → apps/web/app/api/auth/signup/handlers/selfHostedHandler.ts
#
# Routes at risk:
#   → POST /api/auth/signup
#   → ALL /api/auth/signup/handlers
#
# Risk: MEDIUM
```

No AI. No cloud. Runs in under a second. From your live import graph.

---

## Install

```bash
npm install -g carto-md
```

Or without installing:

```bash
npx carto-md init
```

---

## Usage

```bash
cd your-project
carto init
```

That's it. Carto:
- Maps your codebase
- Generates AGENTS.md + domain context files
- Auto-wires MCP into Kiro, Cursor, Claude Desktop
- Installs a git hook — syncs on every commit

Run `carto watch` in background for live updates on every file save.
Run `carto serve` to start the MCP server manually if needed.

---

## Commands

| Command | What it does |
|---------|-------------|
| `carto init` | Map codebase, generate context files, wire MCP into IDEs |
| `carto watch` | Live updates on every file save |
| `carto sync` | One-time manual refresh |
| `carto serve` | Start MCP server for Kiro/Cursor/Claude queries |
| `carto impact <file>` | Show blast radius before touching a file |
| `carto remove` | Remove AGENTS.md and .carto/ from this project |
| `carto --version` | Show version |

---

## Works with

| Language | Frameworks |
|----------|------------|
| Python | FastAPI, Pydantic |
| JavaScript | Express, Next.js |
| TypeScript | Express, Next.js, Prisma, tRPC |
| R | Plumber, Shiny, R6, S7 |
| HTML | fetch() calls |

More languages via community — open an issue or see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## What gets extracted

- API routes — FastAPI, Express, Next.js App Router, tRPC procedures
- Data models — Pydantic, Prisma, TypeScript interfaces
- Function signatures — across all files
- Import graph — which files depend on which
- Domain clusters — AUTH, PAYMENTS, TRPC, DATABASE, EVENTS
- Blast radius — what breaks if you change a file
- Environment variable names — never values
- Database tables — SQLAlchemy, Django ORM, Prisma

---

## What Carto never touches

Your manual sections stay yours forever. Carto only rewrites between its own markers:

```
<!-- CARTO:AUTO:START -->
... auto-generated content ...
<!-- CARTO:AUTO:END -->

Your manual notes here. Never touched.
```

---

## What Carto fixes

Carto fixes **factual hallucination about your own project**:

- AI guessing wrong routes → fixed
- AI guessing wrong field names → fixed
- AI assuming wrong framework → fixed
- AI guessing wrong DB schema → fixed
- AI not knowing blast radius → fixed

What Carto does not fix: AI reasoning badly, wrong implementation logic, misunderstanding what you want. Carto makes AI **accurate** about your project. Not smarter. Accurate. Different thing.

---

## AI tools that read AGENTS.md

- **Cursor** — via context rules + MCP
- **GitHub Copilot** — via workspace instructions
- **Kiro** — natively + MCP
- **Claude Desktop** — via MCP
- **Claude Code** — natively
- **Codex** — natively
- **VS Code** — via workspace context
- **Gemini CLI** — natively
- **Devin** — natively
- **Jules** — natively

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

Python, JS/TS, and R today. Want Go, Ruby, Django, Rails? Open an issue — or read [CONTRIBUTING.md](CONTRIBUTING.md) to add it yourself.

---

## Origin

I was building [Emfirge](https://emfirge.cloud) — a cloud security agent for AWS.

To make the AI inside Emfirge understand infrastructure, I wrote a module called `cartography.py`. It mapped AWS resources, built a graph of how they connected, and wrote it into a structured map. The AI stopped hallucinating. It worked with accurate facts — not guesses.

Halfway through, I switched AI tools. Opened a new session. Had to explain everything again from scratch.

I thought: *I just built a cartography system so AI can understand infrastructure. Why doesn't this exist for codebases?*

Carto is that. Same insight, different domain.

---

## License

MIT — free forever.

---

*Built because AGENTS.md won. Someone had to keep it alive — and make it queryable.*
