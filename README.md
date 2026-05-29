# carto

[![npm version](https://img.shields.io/npm/v/carto-md)](https://www.npmjs.com/package/carto-md)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/carto-md)](https://www.npmjs.com/package/carto-md)

**The structural intelligence layer for AI coding tools.**

```bash
npm install -g carto-md
cd your-project
carto init
```

Carto indexes your codebase — routes, models, import graph, blast radius, domain clusters — and keeps it live via SQLite. Every AI tool you use gets accurate structural facts about your project instead of guessing.

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

**All MCP queries** (blast radius, routes, structure, domains): **<5ms** on all repos.

### Domains detected

| Repo | Domains |
|------|---------|
| prisma | DATABASE · CORE · EVENTS · AUTH |
| supabase | CORE · AUTH · DATABASE · PAYMENTS · EVENTS · NOTIFICATIONS · TRPC |
| vscode | CORE · AUTH · EVENTS · DATABASE · NOTIFICATIONS |
| zed (Rust) | CORE · DATABASE · AUTH · EVENTS · PAYMENTS · NOTIFICATIONS |

vscode at 10,565 files in under 10 seconds. Rust import graph working on zed (2,176 edges from `mod` declarations and `use crate::` paths).

---

## What it does

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
Auto-wires MCP into Kiro, Cursor, Claude Desktop
  ↓
carto watch
  ↓
File saved → debounce 50ms → re-parse 1 file → SQLite write → <50ms
```

---

## 16 MCP tools

`carto serve` exposes a local MCP server. Kiro, Cursor, and Claude query it mid-task.

| Tool | What it returns |
|------|----------------|
| `get_architecture()` | 500-word project overview: domains, entry points, stack, key patterns. **Use this first.** |
| `get_blast_radius(file)` | All files affected by changing a given file, with hop distance |
| `get_context(file)` | Everything about a file: domain, blast radius, neighbors, routes, models |
| `get_change_plan(intent)` | Given "add rate limiting to /api/users" → files to touch, domains affected, blast radius, similar patterns |
| `get_file_summary(file)` | What a file does, its role, key deps and dependents |
| `get_similar_patterns(file)` | Files with same domain, same route shape, or shared dependencies — find conventions before writing new code |
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

---

## Languages and frameworks

### Import graph + symbols (tree-sitter — works on any repo)

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

### Route extraction (framework-specific)

| Framework | Language |
|-----------|---------|
| Express, Next.js (App + Pages Router), tRPC, React Router | TypeScript / JavaScript |
| FastAPI, Flask, Django | Python |
| Gin, Echo, Chi, net/http | Go |
| Actix-web, Axum, Rocket | Rust |
| Spring MVC / Boot, JAX-RS | Java |
| ASP.NET Core (attribute routing + minimal API) | C# |
| Rails, Sinatra | Ruby |

### Model extraction

| ORM / Schema | Language |
|-------------|---------|
| Prisma, Zod, Drizzle, TypeScript interfaces | TypeScript / JavaScript |
| Pydantic, SQLAlchemy | Python |
| Go structs | Go |
| Rust structs | Rust |
| JPA `@Entity`, Java records | Java |
| EF Core classes, C# records | C# |
| ActiveRecord | Ruby |

### TypeScript path aliases

Reads `tsconfig.json` / `jsconfig.json` for `paths` config. `@/components/Button` resolves to the actual file in the import graph — blast radius works correctly for Next.js and Vite projects.

---

## Domain detection

V2 uses **Leiden+CPM graph clustering** — files that import each other heavily cluster together. Domain names are inferred from path tokens, with keyword hints for well-known patterns (AUTH, PAYMENTS, DATABASE, etc.).

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

## Commands

| Command | What it does |
|---------|-------------|
| `carto init` | Detect project, index codebase, generate AGENTS.md, wire MCP |
| `carto sync` | Full re-index (skips unchanged files via mtime+size cache) |
| `carto watch` | Incremental live re-index on every file save (<50ms) |
| `carto serve` | Start MCP server for Kiro / Cursor / Claude |
| `carto agent` | Start ACP agent mode (for Zed / JetBrains / VS Code) |
| `carto impact <file>` | Blast radius: risk level, affected files, routes at risk |
| `carto check` | Cross-domain violations, high-risk uncommitted changes, domain health |
| `carto remove` | Remove AGENTS.md and .carto/ from project |

---

## ACP Agent (Zed / JetBrains / VS Code)

Carto works as a full **ACP agent** — not just a passive tool server, but an active coding agent with architectural awareness.

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

Add to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Carto": {
      "command": "carto",
      "args": ["agent"]
    }
  }
}
```

### BYOK (Bring Your Own Key)

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

### What makes it different

Other agents are smart but blind. Carto sees the architecture:
- Auto-indexes your project on first session (1-10s depending on size)
- Injects structural context into every LLM call (blast radius, domains, routes)
- 12 internal tools the LLM can call during reasoning
- Zero cost to you beyond your own API key

---

## V1 → V2 migration

Run `carto sync` — it auto-migrates your existing `graph-cache.json` and `map.json` into SQLite and renames them to `.bak`. No manual steps.

What changed under the hood:

| | V1 | V2 |
|---|---|---|
| Storage | JSON blobs | SQLite (WAL mode, indexed queries) |
| Parsing | Babel-only | tree-sitter for all languages, Babel only for deep route/model extraction |
| File limit | 300 cap | Unlimited |
| Languages | JS/TS/Python/Go/R | + Rust/Java/C++/C#/Ruby |
| Domain detection | Hardcoded keywords | Leiden+CPM graph clustering |
| Watcher | Per-file chokidar | Single recursive directory watch (<20 file descriptors) |
| MCP startup | Re-indexes on start | Opens SQLite instantly (<10ms) |
| Path aliases | Not resolved | `@/`, `~/` resolved via tsconfig |

---

## MCP config (if auto-wire missed your IDE)

**Kiro** — `~/.kiro/settings/mcp.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

**Cursor** — `~/.cursor/mcp.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

---

## What Carto never does

- Sends your code anywhere. Local only. SQLite on disk.
- Writes secrets into AGENTS.md. `.cartoignore` blocks `.env` and credential files by default.
- Touches your manual notes. Writes only between `<!-- CARTO:AUTO:START -->` and `<!-- CARTO:AUTO:END -->`.
- Costs money. MIT license. Free forever.

---

## License

MIT. Free forever.

---

*Your code changes. Carto knows. Every AI you use knows.*
