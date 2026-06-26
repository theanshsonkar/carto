# Concept: Import Graph

> The foundation. Every other Carto feature is computed from this one structure.

## What's in it

For each source file Carto parses, it records:

| Source field | Meaning |
|--------------|---------|
| `id`         | Stable integer (monotonic per project) |
| `path`       | Project-relative, forward-slash-normalized |
| `language`   | `javascript`, `typescript`, `python`, `go`, `rust`, `java`, `cpp`, `csharp`, `ruby`, `r`, `prisma` |
| `hash`       | SHA-256 of content (mtime+size cache uses this) |
| `is_entry_point` | True for top-level CLIs, `main.*` files, Next.js page entries |

And for each import the parser finds:

| Edge field | Meaning |
|------------|---------|
| `from_file_id` | The importer |
| `to_file_id`   | The importee (null if unresolved — e.g. a bare module name like `express`) |
| `to_path`      | The raw import specifier |
| `resolved`     | Boolean — did we successfully find the target in the index? |

## What parser does what

Two-layer extraction:

**1. Tree-sitter** (per-language plugin in `src/extractors/languages/`). Parses the file into a syntax tree, walks the tree, pulls out:

- import statements (`import x from`, `from x import`, `use crate::x`, `using A.B;`, `require 'x'`, `#include "x"`)
- exported symbols
- type definitions (interfaces, classes, structs)

For supported grammars, this is ~0.05–0.2 ms/file.

**2. Babel deep-parse** (TypeScript/JavaScript only, opt-in for route+model files). Used when the framework-specific extractor needs more than tree-sitter can give — e.g. tRPC procedures, React Router routes, Zod schemas, Prisma models. Slower (~5–20 ms/file) but reserved for the small subset of files where it matters.

## Import resolution

Local imports (`./foo`, `../utils`) are resolved relative to the importing file's directory, then tried against the index:

```
./foo                  → src/lib/foo.ts ?
                       → src/lib/foo.js ?
                       → src/lib/foo/index.ts ?
                       → src/lib/foo/index.js ?
```

The first hit wins. TypeScript `paths` aliases (`@/components/Button`) are read from `tsconfig.json` and applied before the relative search — so `@/components/Button` resolves to `src/components/Button.tsx` if that's what the alias maps to.

Bare module names (`express`, `react`, `lodash`) are *intentionally* not resolved. They're external; Carto's job is to know the *internal* structure.

## How it's stored

SQLite tables `files` + `imports`. One row per file, one row per edge. Indexes on `(from_file_id)`, `(to_file_id)`, `(path)`.

Plus a derived bitmap layer in `.carto/bitmap.bin`:

- `forward[i]` = bitmap of files that file `i` imports (1-hop)
- `reverse[i]` = bitmap of files that import file `i` (1-hop)
- `popcountIndex` = files sorted by transitive 5-hop dependent count, desc

The bitmap layer is the read path. The SQLite tables are the write path + source of truth. The bitmap is rebuilt from SQLite on first sync after upgrade.

## Path-alias support

Carto reads `paths` from:

- `tsconfig.json` → alias resolution for `.ts/.tsx`
- `jsconfig.json` → alias resolution for `.js/.jsx`

It does *not* currently read:

- `webpack.config.js` `resolve.alias` (too many variants — convert to tsconfig if you need it indexed)
- `vite.config.{js,ts}` `resolve.alias` (same)
- `next.config.{js,mjs}` `experimental.transpilePackages` (only affects bundling, not module resolution)

If you have a path alias that's not being resolved, declare it in `tsconfig.json#paths` even if you don't use TypeScript. Carto reads it; your runtime ignores it.

## Edge cases we handle

- **Type-only imports** (`import type { X }`) — counted as edges. They're real dependencies; if the type changes, the importer needs to update.
- **Dynamic imports** (`import('./foo')`) — captured when the path argument is a string literal. Computed values are not resolved (no symbolic execution).
- **Conditional imports** (inside `if (process.env.X)`) — captured statically; we don't try to evaluate the condition.
- **Barrel re-exports** (`export * from './foo'`) — captured as edges, but the barrel itself doesn't get flagged as a "consumer" (it's just a pass-through).
- **CommonJS `require()`** — captured for `.js/.cjs` files.
- **Python `from .x import y`** — relative imports resolved against the package layout. Was a bug pre-2.0.7; fixed in Spec 7.

## Edge cases we don't handle

- **Monkey-patching / runtime mutation** — no.
- **Reflection-based loading** (Python `importlib`, Java `Class.forName`) — no.
- **Cross-language imports** (TS frontend HTTP-calling a Python backend route) — handled by route extraction, not the import graph. See [`get_change_plan`](./mcp-integration.md#get_change_plan).

## What you'd want to look at

- `carto inspect` — shows file count, edge count, schema version
- `get_neighbors(file, hops)` MCP tool — exact 1- or 2-hop import neighbors of a single file
- `get_high_impact_files(n)` MCP tool — top-N by transitive dependent count
- `.carto/anci.bin` — the binary serialization of the whole graph; consumable by any AI tool via the `loadAnci()` library
