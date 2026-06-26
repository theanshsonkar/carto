# Guide: Monorepo setup

> The realities of indexing a 30K-file monorepo with carto. Knobs, gotchas, expected sizes.

## The default behavior

`carto init` at the monorepo root indexes *everything*. No file cap. SQLite handles the volume; the bitmap engine handles the queries.

Real numbers from the corpus runs (see [`docs/scale.md`](../scale.md)):

| Repo | Indexed files | First run | Re-sync (no changes) | DB size |
|------|--------------:|----------:|---------------------:|--------:|
| prisma     |  961 | 1.0s  | 350ms | 1.1 MB |
| zed        | 1,752 | 2.9s  | 468ms | 4.8 MB |
| supabase   | 6,330 | 5.4s  | 1.2s  | 4.8 MB |
| vscode     | 7,567 | 8.0s  | 935ms | 14.3 MB |

For a 30–50K-file monorepo, expect ~30–50s first run, ~3–5s incremental. Beyond 100K files Carto prints an ETA and runs in 1–2 minutes.

## What gets excluded by default

`carto init` writes a `.cartoignore` if one doesn't exist. Defaults exclude:

- `node_modules/`, `vendor/`, `dist/`, `build/`, `target/`, `out/`
- `.git/`, `.svn/`, `.hg/`
- Test files matching common conventions:
  - `*.test.*`, `*.spec.*`, `*.stories.*` (JS/TS)
  - `test_*.py`, `*_test.py` (Python)
  - `test_*`, `*_test.r` (R)
  - Subdirs named `test/`, `tests/`, `__tests__/`, `spec/`
- Secrets / credentials: `.env*`, `*secret*`, `*credential*`, `*private_key*`, `*.pem`, `*.key`, SSH keys, AWS/GCP creds, kubeconfig, token files
- Binaries: images, media, archives
- Cache directories

If your monorepo has unusual layout (a separately-managed `vendor/` you do want indexed, e.g.), edit `.cartoignore` to allow it back in.

## Submodules

If `.gitmodules` is present, `carto init` warns:

```
[CARTO] Detected 3 git submodules. Add their paths to .cartoignore
        if you don't want them indexed.
```

Default behavior: submodule directories *are* descended into. If your submodules are external/vendored packages, you almost certainly want them excluded — add their paths to `.cartoignore`.

## Per-workspace domain hints

Monorepos with `packages/auth/`, `packages/payments/`, `packages/db/` produce good auto-detected domains because the path tokens line up with what the Leiden+CPM clusterer finds in the graph.

If you have a flatter layout (`apps/web/src/{auth,payments,db}/`), use `carto.config.json` to pin domains:

```json
{
  "domains": {
    "AUTH": {
      "keywords": ["auth", "login", "session"],
      "anchor": ["apps/web/src/auth/session.ts"]
    },
    "PAYMENTS": {
      "keywords": ["payment", "billing", "checkout"],
      "anchor": ["apps/web/src/payments/charge.ts"]
    }
  }
}
```

The `anchor` files force those paths into the named domain regardless of clustering. See [`domains.md`](../concepts/domains.md).

## TypeScript path aliases

Carto reads `tsconfig.json#paths` and `jsconfig.json#paths` for import resolution. In a monorepo with workspace references (e.g. `tsconfig.json#references`), each workspace's `tsconfig.json` is read independently. The aliases declared in `apps/web/tsconfig.json` apply when resolving imports *inside* `apps/web/`, etc.

If you use TypeScript project references with `"composite": true`, this just works. If you use a monorepo tool that bypasses tsconfig (some Nx setups), declare the equivalent paths in a top-level `tsconfig.json` for Carto's benefit even if the build doesn't use them.

## Cross-package imports

When `@company/auth` is published locally (npm workspaces, pnpm workspaces, yarn workspaces), imports of `@company/auth` resolve via the workspace symlink — which Carto follows. So `import { sessionFor } from '@company/auth'` from `apps/web/src/api/users.ts` correctly resolves to `packages/auth/src/index.ts`, and the edge ends up in the graph.

What this enables:

- `get_blast_radius('packages/auth/src/session.ts')` returns dependents across *every* workspace
- Cross-domain checks fire on workspace-to-workspace edges
- The `simulate_change_impact` MCP tool correctly unions blast radius across packages

## Excluding individual workspaces

`carto.config.json` can pin which directories to index:

```json
{
  "include": ["apps/", "packages/"],
  "exclude": ["packages/legacy-thing/"]
}
```

`include` is rare — `.cartoignore` is usually the right tool. `exclude` is the common case for "we don't index this old workspace anymore".

## Scoped indexing (>100K files)

For *very* large monorepos (Google-scale, ~1M files), the full index gets unwieldy. The roadmap has a `--scope=packages/changed/**` flag that only indexes affected workspaces; that hasn't shipped yet. If you hit this scale, file an issue — the gating decision is "real users at this scale" rather than premature.

In the meantime, the working knob is `.cartoignore`. Exclude packages you don't change, accept a partial graph, get a usable index.

## Performance expectations

| Files | First run | Re-sync | DB | Bitmap | RSS |
|------:|----------:|--------:|---:|-------:|----:|
| 1K    | 1s        | 350ms   | 1 MB | 100 KB | 60 MB |
| 10K   | 8s        | 1s      | 14 MB | 1.2 MB | 220 MB |
| 50K   | 50s       | 4s      | 80 MB | 8 MB | 600 MB |
| 100K  | ~100s     | ~10s    | 160 MB | 20 MB | 1.1 GB |

These are from the synthetic stress harness (`bench/scale-test/`). Real repos vary depending on edge density, but the shape is the same.

## Related

- [`docs/concepts/domains.md`](../concepts/domains.md) — adaptive gamma + custom hints
- [`docs/concepts/import-graph.md`](../concepts/import-graph.md) — alias resolution details
- [`docs/scale.md`](../scale.md) — full benchmark table
