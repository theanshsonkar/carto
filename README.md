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

**Works with:** Cursor · Claude Code · Codex · Kiro · Claude Desktop · Windsurf · VS Code Copilot · JetBrains · Zed

---

## Use it with your AI tool

`carto init` auto-wires the MCP server into every AI tool it detects. If yours wasn't detected, here's the manual config — **one block, copy-paste, done.**

### Cursor

`carto init` writes this for you. Manual: `~/.cursor/mcp.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

### Claude Code (CLI)

`carto init` writes `<project>/.mcp.json` for you when Claude Code is detected (`claude` binary on PATH or `~/.claude/` exists). Manual:
```bash
claude mcp add carto -- carto serve
```
Or create `.mcp.json` at the project root:
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"] } } }
```

### Codex (CLI)

`carto init` writes `~/.codex/config.toml` for you when Codex is detected (`codex` binary on PATH or `~/.codex/` exists). Manual:
```bash
codex mcp add carto -- carto serve
```
Or edit `~/.codex/config.toml`:
```toml
[mcp_servers.carto]
command = "carto"
args = ["serve"]
cwd = "/your/project"
enabled = true
```

### Kiro

`carto init` writes this for you. Manual: `~/.kiro/settings/mcp.json`
```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

### Claude Desktop

`carto init` writes this for you (cross-platform). Manual paths:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json` (community Linux builds)

```json
{ "mcpServers": { "carto": { "command": "carto", "args": ["serve"], "cwd": "/your/project" } } }
```

### VS Code Copilot

`carto init` writes `<project>/.vscode/mcp.json` for you when the `code` binary is on PATH. Manual: `.vscode/mcp.json` in your project root, or Command Palette → `MCP: Add Server`. Note: VS Code uses `servers` (not `mcpServers`) and requires `"type": "stdio"`.
```json
{ "servers": { "carto": { "type": "stdio", "command": "carto", "args": ["serve"] } } }
```

### Windsurf

`carto init` writes this for you when Windsurf is detected. Manual: `~/.codeium/windsurf/mcp_config.json`
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

### Catching bad changes before save

The harder problem isn't finding the right file — it's stopping a confident-sounding AI from writing a refactor that breaks the rest of the repo. Carto exposes a diff-shaped query the AI can call before the user accepts a change:

> *AI proposes a 12-line patch to `packages/pg-meta/src/pg-format/index.ts`. Before showing the diff, it calls `validate_diff(patch)`.*

```
# Diff Validation

**Risk:** 🔴 HIGH
**Files changed:** 1
**Union blast radius:** 83 transitive dependents

## Violations (1)

| Severity | Kind        | File                                   | Detail                                                          |
|----------|-------------|----------------------------------------|-----------------------------------------------------------------|
| HIGH     | high_blast  | `packages/pg-meta/src/pg-format/index.ts` | Modifying this file affects 83 transitive dependents (>50). |
```

The AI sees this *before* it proposes the diff. It revises its plan, splits the change, or asks the user. The bad refactor never makes it to the screen. Sub-millisecond on a 7,000-file repo — see the **Benchmarks** section below.

Every `validate_diff` call is also written to a local SQLite log, so a session that runs five hours later can ask `did_we_discuss_this("snake_case naming")` and get back the prior decision. The AI stops re-deciding settled questions.

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

## The 22 MCP tools

Once carto is wired in, your AI tool can call any of these mid-task. You don't need to memorize them — your AI will pick the right ones.

| Tool | What it returns |
|------|----------------|
| `get_architecture()` | 500-word project overview: domains, entry points, stack, key patterns. **Use this first.** |
| `get_change_plan(intent)` | Given "add rate limiting to /api/users" → files to touch, domains affected, blast radius, similar patterns |
| `get_blast_radius(file)` | All files affected by changing a given file, with hop distance |
| `simulate_change_impact(files)` | Union of all files transitively affected by changing **multiple** files at once. Powered by the bitmap engine — sub-millisecond on 7K-file repos. |
| `validate_diff(diff)` | Given a unified diff: violations (cross-domain imports, high-blast files), blast radius per file, risk level (SAFE/LOW/MEDIUM/HIGH), suggestions. Each call is recorded in the **episodic memory** log so other tools can ask "did we discuss this?". Sub-15ms p99. |
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
| `get_recent_decisions(time_range, kind?)` | Recent validation decisions and architectural choices the AI has made in this project |
| `get_session_context(session_id?)` | Full context for an AI session: every decision and intervention, ordered chronologically |
| `did_we_discuss_this(topic)` | Substring search over the episodic memory log — avoid re-deciding settled questions |
| `get_intervention_history(file?)` | Past Carto-issued violations and suggestions, optionally filtered by file |

**All MCP queries:** **<5ms** on every benchmarked repo.

## Episodic Memory

Carto remembers every diff it validates. The `validate_diff` tool writes one row per call into a local SQLite log (`ai_sessions`/`decisions`/`interventions` tables) — so a session that runs five hours later can still ask `did_we_discuss_this("snake_case naming")` and get back the prior decision. The log lives next to the index in `.carto/carto.db` — never sent over the network, never shared between projects.

---

## Domain detection

Carto uses **Leiden+CPM graph clustering** — files that import each other heavily cluster together. Domain names are inferred from path tokens, with keyword hints for well-known patterns (AUTH, PAYMENTS, DATABASE, etc.).

**Adaptive strategy:** Repos under 100 files use keyword-only clustering (avoids over-fragmentation). Larger repos with dense import graphs get graph-based clustering with a gamma that scales continuously with repo size.

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

Full schema with anchor pinning (forces files into a domain regardless of clustering):
```json
{
  "domains": {
    "AUTH": {
      "keywords": ["auth", "login", "session"],
      "anchor": ["src/auth/session.ts", "src/auth/middleware.ts"]
    }
  }
}
```

**Stability tracking:** Carto tracks domain assignments across syncs. If >5% of files change domain, `carto check` flags it as unstable. Two consecutive syncs with no code changes always produce 0% drift.

---

## CLI commands

| Command | What it does |
|---------|-------------|
| `carto init` | Detect project, index codebase, generate AGENTS.md, install git hooks (pre-commit, post-checkout, post-merge, post-rewrite), auto-wire MCP into every AI tool found |
| `carto sync` | Full re-index (skips unchanged files via mtime+size cache). Called automatically by git hooks on commit/checkout/merge/rebase. |
| `carto serve` | Start MCP server (called by your AI tool — usually you don't run this directly). On every file-aware query the server mtime+size-checks the file and re-parses inline if stale. |
| `carto watch` | **Optional.** Live re-index on every file save. Not required — git hooks + lazy MCP re-parse keep the index fresh by default. Use only for AI-heavy workflows that write 50+ files between commits. |
| `carto agent` | Start ACP agent mode (for Zed / JetBrains / VS Code) |
| `carto impact <file>` | Blast radius: risk level, affected files, routes at risk |
| `carto check` | Cross-domain violations, high-risk uncommitted changes, domain health |
| `carto inspect` | Read-only diagnostic: index paths, sizes, freshness, bitmap sidecar shape, top-impact files, schema version, sync timestamps. `--json` for piping into `jq`. Never triggers a rebuild. |
| `carto remove` | Remove AGENTS.md and .carto/ from project |

---

## Benchmarks

Measured on real open-source repos. Apple M-series, 8 CPUs, 8GB RAM. SHAs pinned in `~/carto-test-repos`. Reproducible via `~/carto-test-repos/run-bench.sh`.

### Indexing speed

| Repo | Language | Indexed Files | First Run | Second Run | DB Size | Import Edges |
|------|----------|---------------|-----------|------------|---------|--------------|
| [prisma/prisma](https://github.com/prisma/prisma) | TypeScript | 961 | **961ms** | **431ms** | 0.7 MB | 1,387 |
| [supabase/supabase](https://github.com/supabase/supabase) | TypeScript | 6,330 | **5.4s** | **1.2s** | 4.0 MB | 5,321 |
| [microsoft/vscode](https://github.com/microsoft/vscode) | TypeScript | 7,567 | **7.7s** | **1.0s** | 6.7 MB | 13,420 |
| [zed-industries/zed](https://github.com/zed-industries/zed) | Rust | 1,752 | **3.0s** | **491ms** | 4.4 MB | 2,113 |

**Indexed Files** counts what Carto actually parses — `.ts/.js/.py/.go/.rs/...` after excluding `node_modules`, build output, and per-file `*.test.*` / `*.spec.*` / `*.stories.*` / `test_*.py` patterns. The on-disk file count of the repo is larger.

**Second Run** = `carto sync` after no changes. mtime+size checked before reading content — if nothing changed, nothing is re-parsed.

### MCP query latency (bitmap engine vs SQLite)

Carto's MCP query path is bitmap-backed on five tools, plus a sixth (`simulate_change_impact`) that's only feasible with bitmap OR-aggregation. Speedups measured against the same data, same DB, same machine — bitmap path vs the equivalent SQLite path.

| Tool | vscode (7,567 files) | Speedup vs SQLite |
|------|---------------------:|------------------:|
| `get_blast_radius` | sub-ms | **10.7×** |
| `get_cross_domain` | 2.1ms | **6.2×** |
| `get_high_impact_files` | sub-ms | **559×** |
| `get_similar_patterns` | sub-ms | **73×** |
| `simulate_change_impact` | sub-ms | **6.5×** (no SQLite equivalent at this latency) |

Median speedup across all five tools on vscode: **10.7×**. Smaller repos hit higher peaks — laravel-framework `get_high_impact_files` clocks at 155× on the smaller graph. Reproducible via `npm run bench:bitmap -- --repo <path>`.

### `validate_diff` latency

The new diff-shaped query that lets the AI ask "is this patch safe?" before showing it to the user. Profiled with a representative 20-line diff against 20 random mid-blast-radius files per repo, 1000 calls each.

| Repo | Files | p50 | p99 |
|------|-------|----:|----:|
| supabase | 6,259 | **0.082ms** | **0.298ms** |
| vscode | 7,567 | **0.084ms** | **0.489ms** |

Budget was p50 ≤ 5ms, p99 ≤ 15ms. Both targets are cleared by 30-60×. The bitmap engine handles every blast-radius and cross-domain query in microseconds; what's left is diff parsing + result aggregation. Reproducible via `node bench/validation-perf/index.js --repo <path>`.

### Domains detected

| Repo | Domains |
|------|---------|
| prisma | CORE · DATABASE · AUTH · EVENTS |
| supabase | CORE · AUTH · DATABASE · PAYMENTS · NOTIFICATIONS · EVENTS · TRPC |
| vscode | EXTENSIONS · AUTH · EVENTS · DATABASE · EXTENSION · CLI · CORE |
| zed (Rust) | CORE · DATABASE · AUTH · EVENTS · PAYMENTS · TRPC · NOTIFICATIONS |

vscode at 7,567 indexed files in under 8 seconds. Rust import graph working on zed (2,113 edges from `mod` declarations and `use crate::` paths).

### Accuracy

12 corpus repos pass `node test/accuracy-corpus.js --samples 100` — full parity between the bitmap path and the SQLite path on `blastRadius`, `crossDomain`, `highImpactFiles`, and `simulateChangeImpact`. The bitmap layer is a speedup, never a behavior change.

---

## How it works

```
carto init
  ↓
Discovers all files (no cap — SQLite handles the volume)
mtime+size check → skip unchanged files
tree-sitter parse → imports + symbols (0.05–0.2ms/file)
Babel deep parse → routes + models (API handler files only)
Leiden+CPM graph clustering → auto-detects domains
Computes reverse deps → blast radius for every file
Writes AGENTS.md + .carto/context/*.md (lazy, on-demand)
Auto-wires MCP into every AI tool found
Installs 4 git hooks: pre-commit, post-checkout, post-merge, post-rewrite
  ↓
[no daemon, no watcher, no background process]
  ↓
─── Freshness mechanism 1: git hooks (90% of cases) ───
You commit / pull / switch branches / rebase
  → hook runs `carto sync` quietly in <1s
  → only changed files re-parsed
  ↓
─── Freshness mechanism 2: lazy mtime check (the gap) ───
You edit files between commits, AI asks "blast radius of db.ts?"
  → MCP server stats db.ts (mtime+size vs DB row)
  → if stale, re-parses just that file inline (<50ms)
  → returns fresh answer
  ↓
─── Optional: carto watch (AI-heavy workflows only) ───
File saved → debounce 50ms → re-parse 1 file → SQLite write → <50ms
```

---

## What Carto never does

- **Sends your code anywhere.** Local only. SQLite on disk.
- **Writes secrets into AGENTS.md.** `.cartoignore` blocks `.env` and credential files by default.
- **Touches your manual notes.** Writes only between `<!-- CARTO:AUTO:START -->` and `<!-- CARTO:AUTO:END -->`.
- **Costs money.** MIT license. Free forever.

---

## Origin

I was building [Emfirge](https://www.emfirge.cloud) — a cloud security agent that maps AWS infrastructure into a graph and simulates the blast radius of every change.

To make the AI inside Emfirge understand infrastructure, I wrote a module called `cartography.py`. It mapped AWS resources, built a graph of how they connected, and wrote it into a structured map. The AI stopped hallucinating. It worked with facts, not guesses.

Carto is the same idea, applied to source code. Same insight: AI agents stop guessing once they can query the architecture.

---

## License

MIT. Free forever.

---

*Your code changes. Carto knows. Every AI you use knows.*
