# carto

[![npm version](https://img.shields.io/npm/v/carto-md)](https://www.npmjs.com/package/carto-md)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/carto-md)](https://www.npmjs.com/package/carto-md)

**The structural intelligence layer for AI coding tools.**

```bash
npm install -g carto-md
```

Carto indexes your codebase (routes, models, import graph, blast radius, domain clusters) and keeps it live. Every AI tool you use gets accurate structural facts about your project instead of guessing.

---

## What it does in one sentence

**Your file changes. Carto re-indexes in ~130ms. Every AI tool instantly knows what broke.**

---

## Proof: Supabase repo (6,335 files)

Fresh `carto init`. No prior knowledge of the repo.

```
Detected:   nextjs (javascript)
Indexed:    310 files in 422ms
Routes:     104 API endpoints
Models:     3,598 extracted
Domains:    AUTH · DATABASE · PAYMENTS · EVENTS · NOTIFICATIONS · TRPC · CORE
Import edges: 5,248
```

Then a file changes:

```
packages/ui/src/lib/utils/cn.ts updated

Re-indexed in 129ms.

Risk: 🔴 HIGH
Directly affected: 55 files
Potentially affected: 83 files total

Files that depend on this:
  → packages/ui/src/components/Button/Button.tsx
  → packages/ui/src/components/Modal/Modal.tsx
  → packages/ui/src/components/shadcn/ui/button.tsx
  → ...83 more
```

One file changed. Carto told you exactly what broke. In 129ms. On a 6,335 file monorepo.

---

## Proof: cal.com (800k lines)

Same task, two Claude sessions: *"Add a `notes` field to the booking model."*

**Without Carto:**

| | What AI suggested | Reality |
|--|---|---|
| API route | `POST /api/bookings` | `POST /v2/bookings` |
| Handler | `handleNewBooking.ts` | Not the creation path |
| File path | v1 API files | v1 is legacy |
| tRPC file | `bookings.tsx` | `bookings/_router.tsx` |
| Fields found | ~15 guessed | 35+ actual fields |

**With Carto:** Correct route, correct handler, correct file, all 35+ fields. One shot. Zero follow-ups.

**4 wrong paths → 0. 20 missing fields → 0.**

Not smarter AI. The same AI with accurate facts.

---

## Performance

Tested on Supabase (6,335 files, 310 watched):

| Operation | Time |
|-----------|------|
| Cold start (first `carto init`) | 422ms |
| Warm start (files cached) | 66ms |
| One file change (incremental re-index) | ~130ms |
| Blast radius lookup | <5ms |
| Route search | <1ms |

The secret: file hashes. On warm runs, Carto skips every file whose content hasn't changed. On a file save, only that one file gets re-parsed. The rest loads from disk cache in milliseconds.

---

## How it works

```
carto init
  ↓
Hashes every file → skips unchanged on re-runs
Builds import graph → knows who depends on who
Extracts routes, models, functions, env vars
Clusters into domains (AUTH, PAYMENTS, DATABASE...)
Calculates blast radius for every file
Writes AGENTS.md + .carto/context/*.md
Auto-wires MCP into Kiro, Cursor, Claude Desktop
  ↓
carto watch
  ↓
File saved → re-parse 1 file → update graph → ~130ms
```

---

## 12 MCP tools: AI queries your codebase live

`carto serve` exposes a local MCP server. Kiro, Cursor, and Claude query it mid-task instead of guessing.

| Tool | What it returns |
|------|----------------|
| `get_blast_radius(file)` | Risk level, all affected files, routes at risk per domain |
| `get_context(file)` | Everything about a file in one call: domain, blast radius, neighbors, routes, models |
| `get_routes()` | All API endpoints with file mapping |
| `get_structure()` | Import graph, entry points, high-impact files, tech stack |
| `get_domain(name)` | All routes, models, functions for AUTH / PAYMENTS / DATABASE / etc. |
| `get_neighbors(file, hops)` | Import graph neighbors: nodes and edges |
| `get_cross_domain()` | Import edges that cross domain boundaries |
| `search_routes(query)` | Search API routes by path or method |
| `get_models(domain?)` | All data models, optionally filtered by domain |
| `get_high_impact_files(n)` | Top N files by blast radius, highest-risk to change |
| `get_env_vars(domain?)` | All env vars with domain mapping |
| `get_domains_list()` | All detected domains with file, route, model counts |

---

## What gets extracted

| Category | What Carto finds |
|----------|-----------------|
| **Routes** | FastAPI, Flask, Express, Next.js App/Pages Router, React Router (JSX + createBrowserRouter), tRPC procedures, Django URLs, Gin/Echo/Chi/Fiber (Go) |
| **Models** | Prisma, Pydantic, SQLAlchemy, Django ORM, TypeScript interfaces/types, Zod schemas, Drizzle tables, Go structs |
| **Graph** | Full import graph: who imports what, transitive dependencies up to 5 hops — JS/TS, Python, Go, R |
| **Blast radius** | Risk level (HIGH/MEDIUM/LOW) per file and per route |
| **Domains** | AUTO-clustered from imports. Defaults: AUTH, PAYMENTS, DATABASE, EVENTS, TRPC, NOTIFICATIONS, CORE. Custom domains via `carto.config.json`. |
| **Events** | EventEmitter listeners, webhook handlers, queue jobs, cron schedules |
| **Env vars** | Every `process.env` / `os.Getenv` call (names only, never values) |
| **Functions** | Signatures with param names and return types |

---

## Languages and frameworks

| Language | Frameworks |
|----------|------------|
| TypeScript / JavaScript | Express, Next.js (App + Pages Router), React Router, tRPC, Drizzle, Zod |
| Python | FastAPI, Flask, Pydantic, SQLAlchemy, Django |
| Go | Gin, Echo, Chi, Fiber, net/http — including full import graph |
| R | Plumber, Shiny, R6, S7 |
| Schema | Prisma |
| HTML | fetch() calls |

More via community. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Custom domains (`carto.config.json`)

By default Carto clusters into web-app domains (AUTH, PAYMENTS, etc.). For any other architecture — desktop apps, CLIs, compilers, monorepos — define your own:

```json
{
  "domains": {
    "EDITOR": ["editor", "monaco", "text", "cursor"],
    "WORKBENCH": ["workbench", "layout", "panel", "sidebar"],
    "PLATFORM": ["platform", "service", "registry"],
    "BASE": ["base", "common", "util"]
  }
}
```

Drop `carto.config.json` in your project root. Carto picks it up on the next `carto init` or `carto sync`. The import graph and blast radius always work regardless — custom domains only affect how files are clustered and labeled.

---

## Commands

| Command | What it does |
|---------|-------------|
| `carto init` | Detect project, index codebase, generate AGENTS.md, wire MCP |
| `carto watch` | Incremental live re-index on every file save (~130ms) |
| `carto sync` | One-time manual re-index |
| `carto impact <file>` | Blast radius: risk level, affected files, routes at risk |
| `carto check` | Cross-domain violations, high-risk uncommitted changes, domain health |
| `carto serve` | Start MCP server for Kiro / Cursor / Claude |
| `carto remove` | Remove AGENTS.md and .carto/ from project |
| `carto --version` | Show version |

---

## `carto check`

Run before committing. Tells you what's risky before you push.

```
── Carto Check ───────────────────────────────────────

  Files indexed : 310
  Routes found  : 104
  Import edges  : 5,248
  Domains       : AUTH · DATABASE · PAYMENTS · EVENTS · CORE

  ⚠️  High-risk uncommitted changes (1):
     🔴 src/lib/auth.service.ts
        11 files depend on this, blast risk: HIGH

  ✅ No cross-domain dependency violations

  🔥 Top high-impact files:
      83 dependents - packages/ui/src/lib/utils/cn.ts
      35 dependents - packages/pg-meta/src/pg-format/index.ts
      34 dependents - packages/icons/src/createSupabaseIcon.ts
```

---

## `carto impact`

```bash
carto impact src/middleware.ts

Impact analysis: src/middleware.ts

Risk: 🔴 HIGH
Directly affected: 11 files across 2 domain(s)
Domains impacted: AUTH, PAYMENTS

Files that depend on this (11):
  → src/routes/auth.ts
  → src/routes/billing.ts
  → ...

Routes at risk (4):
  🔴 POST /api/auth/login
  🔴 POST /api/billing/checkout
  🟡 GET  /api/users/me
  🟢 GET  /api/health
```

---

## Programmatic API

Use Carto as a module, no CLI required. This is how tools embed it.

```js
const { Carto } = require('carto-md');

const carto = new Carto();
await carto.index('/path/to/project');

// Everything about a file in one call
const ctx = carto.getContextForFile('src/auth/auth.service.ts');
// {
//   domain: 'AUTH',
//   routes: ['POST /api/auth/login', 'GET /api/auth/me'],
//   models: ['User', 'Session'],
//   blastRadius: { risk: 'HIGH', directlyAffected: { files: 8, domains: 2 } },
//   neighbors: { nodes: [...], edges: [...] },  // React Flow compatible
//   crossDomainDeps: [...],
//   domainContext: '...AUTH.md content...'
// }

// Live updates
carto.on('updated', ({ file, blastRadius }) => {
  console.log(`${file} changed, blast risk: ${blastRadius.risk}`);
});

await carto.reindex('src/auth/auth.service.ts'); // ~130ms
```

**Full API:**

```js
carto.getBlastRadius(file)       // Risk + affected files + routes
carto.getNeighbors(file, hops)   // Import graph, React Flow nodes/edges
carto.getCrossDomainDeps()       // Cross-boundary import edges
carto.getHighImpactFiles(n)      // Top N by blast radius
carto.searchRoutes(query)        // Route search
carto.getRoutes()                // All API routes
carto.getDomain(name)            // Domain cluster + context file
carto.getDomainsList()           // All domains with counts
carto.getModels(domain?)         // All models
carto.getEnvVars(domain?)        // Env vars with domain mapping
carto.getMeta()                  // Index stats
```

Events: `status` · `indexed` · `updated`

---

## Domain context files

Large codebases kill AI accuracy. A 2,900-line AGENTS.md means the AI reads 500 lines and guesses the rest.

Carto splits context by domain automatically:

```
AGENTS.md                 → lean map, always loaded by every AI
.carto/context/
  AUTH.md                 → auth routes, session models, JWT functions, middleware
  PAYMENTS.md             → Stripe routes, billing models, webhook handlers
  DATABASE.md             → every model, schema, table, migration pattern
  EVENTS.md               → webhooks, queues, cron jobs, event emitters
  TRPC.md                 → all procedures with input/output schemas
  CORE.md                 → shared utilities
```

AI reads AGENTS.md always. Then fetches only the domain file relevant to the task. 400 lines of exact context instead of 2,900 lines of everything.

Domain assignment runs on your import graph: files that import each other cluster together, regardless of folder names.

---

## MCP config (if auto-wire missed your IDE)

**Kiro**: `~/.kiro/settings/mcp.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

**Cursor**: `~/.cursor/mcp.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

**Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

---

## AI tools that read AGENTS.md natively

Cursor · GitHub Copilot · Kiro · Claude Desktop · Claude Code · Codex · VS Code · Gemini CLI · Devin · Jules

Carto generates the file they all read. One source of truth. Every tool stays accurate.

---

## What Carto fixes

Carto fixes **factual hallucination about your own project**:

- AI guessing wrong routes → fixed
- AI guessing wrong field names → fixed
- AI assuming wrong framework → fixed
- AI not knowing blast radius → fixed
- AI losing context between sessions → fixed
- Rebuilding project context every session → gone

What Carto does not fix: AI reasoning badly, wrong implementation logic, misunderstanding requirements. Carto makes AI **accurate** about your project. Not smarter. Accurate. Different thing.

---

## What Carto never does

- Sends your code anywhere. Local only.
- Writes secrets into AGENTS.md. `.cartoignore` blocks `.env` and credential files by default.
- Touches your manual notes. It writes only between `<!-- CARTO:AUTO:START -->` and `<!-- CARTO:AUTO:END -->`.
- Costs money. MIT license. Free forever.

---

## Install

```bash
npm install -g carto-md
```

```bash
cd your-project
carto init
```

That's it.

---

## Origin

I was building Emfirge, a cloud security agent for AWS.

To make the AI understand infrastructure, I built a module that mapped AWS resources into a graph. The AI stopped hallucinating. It worked with facts.

Then I switched AI tools. New session. Had to explain the whole project again from scratch.

I thought: *I just built a cartography system for infrastructure. Why doesn't this exist for codebases?*

Carto is that.

---

## License

MIT. Free forever.

---

*Your code changes. Carto knows. Every AI you use knows.*
