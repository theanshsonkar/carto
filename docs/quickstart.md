# Quickstart — 10 minutes from install to first MCP query

Get carto wired into your AI tool and answering questions about your codebase in under ten minutes.

## 1. Install (30 seconds)

```bash
npm install -g carto-md
```

Carto ships prebuilt native binaries for macOS arm64/x64, Linux x64 (glibc + musl), and Windows x64. If you're on a platform without prebuilds you'll fall back to compiling from source — see [troubleshooting.md](./troubleshooting.md#native-build-fails) if that breaks.

Verify the install:

```bash
carto --version
```

## 2. Index your project (1 minute)

```bash
cd ~/your-project
carto init
```

You'll see something like:

```
[CARTO] Detecting project...
[CARTO] Detected: nextjs (typescript)
[CARTO] Found 847 JS/TS files (847 total)
[CARTO] Discovered 847 source files
[CARTO] Computing reverse dependencies...
[CARTO] Indexed 847 files in 1.8s
[CARTO] MCP auto-wired into: Cursor, Claude Code, Kiro
[CARTO] AGENTS.md generated.

┌─ Carto · indexed ─────────────────────────────────────────
│  847 files · 5 domains · 23 routes · 1,204 import edges
│
│  Top domains:
│    CORE          (677 files)
│    AUTH          (42 files)
│    PAYMENTS      (38 files)
│    DATABASE      (67 files)
│
│  💡 Highest-risk file: src/lib/db.ts
│     (34 files depend on it — try `carto why src/lib/db.ts`)
└───────────────────────────────────────────────────────────
```

What just happened:

- Carto walked the project, parsed every source file with tree-sitter
- Built an import graph, clustered files into domains (Leiden+CPM), extracted routes + models
- Wrote `.carto/` containing the SQLite index, the bitmap sidecar, the per-domain context files
- Wrote `AGENTS.md` at the project root
- Installed 4 git hooks so the index re-syncs on commit/checkout/merge/rebase
- Detected your installed AI tools and wrote MCP config files for each

## 3. Restart your AI tool

The MCP wiring lands when the AI tool starts fresh. Kill it and reopen, then verify carto loaded — most tools log MCP server connections.

## 4. Ask your first question

Open any prompt your AI tool exposes and try one of:

> *"What's the blast radius of `src/lib/db.ts`?"*

> *"Show me the architecture overview."*

> *"What files would I need to change to add rate limiting to /api/users?"*

The AI calls Carto's MCP tools (`get_blast_radius`, `get_architecture`, `get_change_plan`) and answers with structural facts instead of grepping.

## 5. Try the CLI too

While you're here:

```bash
carto status                              # one-screen health view
carto why src/lib/db.ts                   # 3-line summary of a file
carto explain "add rate limiting"         # natural-language → plan
carto check                               # cross-domain violations
carto doctor                              # diagnose any setup issues
```

## What's next

- [`docs/concepts/blast-radius.md`](./concepts/blast-radius.md) — what "blast radius" means and how it's computed
- [`docs/concepts/domains.md`](./concepts/domains.md) — how the Leiden clusterer infers AUTH/PAYMENTS/etc. without config
- [`docs/concepts/mcp-integration.md`](./concepts/mcp-integration.md) — every MCP tool with an example call
- [`docs/guides/adding-feature-safely.md`](./guides/adding-feature-safely.md) — the workflow this whole thing enables
- [`docs/guides/ci-integration.md`](./guides/ci-integration.md) — drop the GitHub Action onto every PR
