# carto

[![CI](https://github.com/theanshsonkar/carto/actions/workflows/test.yml/badge.svg)](https://github.com/theanshsonkar/carto/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/carto-md)](https://www.npmjs.com/package/carto-md)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/carto-md)](https://www.npmjs.com/package/carto-md)

**The structural intelligence layer for AI coding tools.**

Your AI coding tool sees files. Carto sees architecture — domains, blast radius, import graph, routes. Every AI tool you use stops guessing about your codebase and starts knowing it.

```bash
npm install -g carto-md
cd your-project
carto init
```

That's it. Carto auto-wires itself into every AI tool you have installed. Restart your AI tool and it now knows your codebase architecturally.

**Works with:** Cursor · Claude Code · Kiro · Claude Desktop · Windsurf · VS Code Copilot · JetBrains · Zed

---

## Use it with your AI tool

`carto init` auto-wires the MCP server into every AI tool it detects. If yours wasn't detected, here's the manual config — **one block, copy-paste, done.**

### Cursor

`carto init` writes this for you. Manual: `~/.cursor/mcp.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

### Claude Code (CLI)

One command from your project root:
```bash
claude mcp add carto -- carto serve
```
Or create `.mcp.json` at the project root:
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"] } } }
```

### Kiro

`carto init` writes this for you. Manual: `~/.kiro/settings/mcp.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

### Claude Desktop

`carto init` writes this for you. Manual: `~/Library/Application Support/Claude/claude_desktop_config.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

### VS Code Copilot

`.vscode/mcp.json` in your project root, or Command Palette → `MCP: Add Server`
```json
{ "servers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

### Windsurf

`~/.windsurf/mcp.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

### Zed / JetBrains / VS Code (full agent mode)

Carto also runs as a full **ACP agent** — not just a passive MCP server, but an active coding agent with architectural awareness. See [ACP Agent](#acp-agent-zed--jetbrains--vs-code) below.

---

## What changes for your AI

Without carto, your AI greps text and guesses. With carto, it queries structural facts:

> *"Add rate limiting to /api/users"*

**Without carto:** AI grep-searches your codebase, finds 12 files mentioning "users", picks 3 at random, hopes for the best.

**With carto:** AI calls `get_change_plan("add rate limiting to /api/users")` and gets back:
- The exact route handler file
- All 7 files that import it (blast radius)
- The AUTH domain it lives in
- Similar middleware patterns already in the codebase
- Cross-domain dependencies that could break

Your AI's response goes from "here's a guess" to "here's the right change with the architectural context."

### In the wild

![Claude Code reviewing the supabase repo through carto's MCP server](docs/screenshots/claude-code-supabase.png)

*Claude Code analyzing the [supabase](https://github.com/supabase/supabase) repo via carto. Real session, no editing — 5,974 files indexed in ~780ms, 86 routes, 4,839 import edges, 7 domains. The agent's own verdict at the bottom: "useful, especially for a large codebase like supabase. The blast radius + cross-domain tools are the most valuable."*

---

## Languages and frameworks

### Import graph + symbols (any repo)

| Language | Extensions |
|----------|-----------|
| JavaScript / TypeScript | `.js` `.jsx` `.ts` `.tsx` `.mjs` `.cjs` |
| Python | `.py` |
| Go | `.go` |
| Rust | `.rs` |
| Java | `.java` |
| C / C++ | `.cpp` `.cc` `.cxx` `.h` `.hpp` |
| C# | `.cs` |
| Ruby | `.rb` |

### Route extraction (framework-aware)

| Framework | Language |
|-----------|---------|
| Express, Next.js (App + Pages), tRPC, React Router | TypeScript / JavaScript |
| FastAPI, Flask, Django | Python |
| Gin, Echo, Chi, net/http | Go |
| Actix-web, Axum, Rocket | Rust |
| Spring MVC / Boot, JAX-RS | Java |
| ASP.NET Core | C# |
| Rails, Sinatra | Ruby |

### Model extraction

| ORM / Schema | Language |
|-------------|---------|
| Prisma, Zod, Drizzle, TypeScript interfaces | TypeScript / JavaScript |
| Pydantic, SQLAlchemy | Python |
| Go structs | Go |
| Rust structs | Rust |
| JPA `@Entity`, Java records | Java |
| EF Core, C# records | C# |
| ActiveRecord | Ruby |

### TypeScript path aliases

Reads `tsconfig.json` / `jsconfig.json` `paths` config. `@/components/Button` resolves to the actual file in the import graph — blast radius works correctly for Next.js and Vite projects.

---

## ACP Agent (Zed / JetBrains / VS Code)

Beyond MCP, Carto runs as a full **ACP agent** — an active coding agent with built-in architectural awareness.

```
User: "Add rate limiting to /api/users"
  ↓
Carto auto-queries its own SQLite:
  - Blast radius of relevant files
  - Domain context (AUTH)
  - Similar patterns in codebase
  ↓
Builds rich prompt with structural context
  ↓
Sends to LLM (your API key) → streams answer + diffs back to editor
```

### Setup in Zed

`~/.config/zed/settings.json`:
```json
{
  "agent_servers": {
    "Carto": { "command": "carto", "args": ["agent"] }
  }
}
```

### Bring Your Own Key

Carto supports any LLM provider — configure in your editor:

| Provider | Models |
|----------|--------|
| Anthropic | Claude Sonnet 4, Haiku |
| OpenAI | GPT-4o, GPT-4o-mini, o1, o3 |
| Google Gemini | Gemini 2.5 Pro, 2.5 Flash |
| Ollama | Any local model (free) |
| OpenRouter | Any model via single API |
| Groq | Ultra-fast inference |
| Together AI | Open-source models |
| Azure OpenAI | Enterprise deployments |

---

## The 16 MCP tools

Once carto is wired in, your AI tool can call any of these mid-task. You don't need to memorize them — your AI will pick the right ones.

| Tool | What it returns |
|------|----------------|
| `get_architecture()` | 500-word project overview: domains, entry points, stack, key patterns. **Use this first.** |
| `get_change_plan(intent)` | Given "add rate limiting to /api/users" → files to touch, domains affected, blast radius, similar patterns |
| `get_blast_radius(file)` | All files affected by changing a given file, with hop distance |
| `get_context(file)` | Everything about a file: domain, blast radius, neighbors, routes, models |
| `get_file_summary(file)` | What a file does, its role, key deps and dependents |
| `get_similar_patterns(file)` | Files with same domain, route shape, or shared deps — find conventions before writing new code |
| `get_routes()` | All API endpoints with file mapping |
| `get_structure()` | Import graph, entry points, high-impact files, tech stack |
| `get_domain(name)` | All routes, models, functions for a domain. Lazily regenerated when stale. |
| `get_neighbors(file, hops)` | Import graph neighbors: nodes and edges |
| `get_cross_domain()` | Import edges that cross domain boundaries |
| `search_routes(query)` | Search API routes by path or method |
| `get_models(domain?)` | All data models, optionally filtered by domain |
| `get_high_impact_files(n)` | Top N files by blast radius |
| `get_env_vars(domain?)` | All env vars with domain mapping |
| `get_domains_list()` | All detected domains with file, route, model counts |

**All MCP queries:** **<5ms** on every benchmarked repo.

---

## Domain detection

Carto uses **Leiden+CPM graph clustering** — files that import each other heavily cluster together. Domain names are inferred from path tokens, with keyword hints for well-known patterns (AUTH, PAYMENTS, DATABASE, etc.).

Works on any repo — not just SaaS apps. vscode gets AUTH/EVENTS/DATABASE. zed (Rust) gets DATABASE/AUTH/EVENTS. A game engine would get RENDERER/PHYSICS/AUDIO.

Custom domains via `carto.config.json`:
```json
{
  "domains": {
    "EDITOR": ["editor", "monaco", "text"],
    "WORKBENCH": ["workbench", "layout", "panel"]
  }
}
```

---

## CLI commands

| Command | What it does |
|---------|-------------|
| `carto init` | Detect project, index codebase, generate AGENTS.md, auto-wire MCP into every AI tool found |
| `carto sync` | Full re-index (skips unchanged files via mtime+size cache) |
| `carto watch` | Incremental live re-index on every file save (<50ms) |
| `carto serve` | Start MCP server (called by your AI tool — usually you don't run this directly) |
| `carto agent` | Start ACP agent mode (for Zed / JetBrains / VS Code) |
| `carto impact <file>` | Blast radius: risk level, affected files, routes at risk |
| `carto check` | Cross-domain violations, high-risk uncommitted changes, domain health |
| `carto remove` | Remove AGENTS.md and .carto/ from project |

---

## Benchmarks

Measured on real open-source repos. Apple M-series, 8 CPUs, 8GB RAM.

| Repo | Language | Source Files | Indexed | First Run | Second Run | DB Size | Import Edges |
|------|----------|-------------|---------|-----------|------------|---------|--------------|
| [prisma/prisma](https://github.com/prisma/prisma) | TypeScript | 3,303 | 3,303 | **1.6s** | **178ms** | 2.2 MB | 3,590 |
| [supabase/supabase](https://github.com/supabase/supabase) | TypeScript | 6,818 | 6,746 | **4.9s** | **725ms** | 4.3 MB | 5,754 |
| [microsoft/vscode](https://github.com/microsoft/vscode) | TypeScript | 10,565 | 10,565 | **9.7s** | **1.2s** | 10.6 MB | 19,769 |
| [zed-industries/zed](https://github.com/zed-industries/zed) | Rust | 1,837 | 1,837 | **2.7s** | **83ms** | 4.7 MB | 2,176 |

**Second run** = only changed files re-parsed. mtime+size checked before reading content — if nothing changed, nothing is re-parsed.

### Domains detected

| Repo | Domains |
|------|---------|
| prisma | DATABASE · CORE · EVENTS · AUTH |
| supabase | CORE · AUTH · DATABASE · PAYMENTS · EVENTS · NOTIFICATIONS · TRPC |
| vscode | CORE · AUTH · EVENTS · DATABASE · NOTIFICATIONS |
| zed (Rust) | CORE · DATABASE · AUTH · EVENTS · PAYMENTS · NOTIFICATIONS |

vscode at 10,565 files in under 10 seconds. Rust import graph working on zed (2,176 edges from `mod` declarations and `use crate::` paths).

---

## How it works

```
carto init / carto sync
  ↓
Discovers all files (no cap — SQLite handles the volume)
mtime+size check → skip unchanged files
tree-sitter parse → imports + symbols (0.05–0.2ms/file)
Babel deep parse → routes + models (API handler files only)
Leiden+CPM graph clustering → auto-detects domains
Computes reverse deps → blast radius for every file
Writes AGENTS.md + .carto/context/*.md (lazy, on-demand)
Auto-wires MCP into every AI tool found
  ↓
carto watch (optional)
  ↓
File saved → debounce 50ms → re-parse 1 file → SQLite write → <50ms
```

---

## What Carto never does

- **Sends your code anywhere.** Local only. SQLite on disk.
- **Writes secrets into AGENTS.md.** `.cartoignore` blocks `.env` and credential files by default.
- **Touches your manual notes.** Writes only between `<!-- CARTO:AUTO:START -->` and `<!-- CARTO:AUTO:END -->`.
- **Costs money.** MIT license. Free forever.

---

## License

MIT. Free forever.

---

*Your code changes. Carto knows. Every AI you use knows.*
