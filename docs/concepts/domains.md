# Concept: Domains

> Auto-detected clusters of tightly-coupled files. Carto's "AUTH", "PAYMENTS", "DATABASE" — without you writing a config.

## The intuition

Files that import each other heavily belong together. Files that don't, don't. Cluster the import graph and you get a set of communities — those communities are the codebase's *domains*.

Carto runs **Leiden+CPM** (Constant Potts Model) on the import graph. It's the same family of community-detection algorithms used in social-network analysis. The output: each file gets a domain id; the bitmap engine indexes by it; everything downstream (cross-domain checks, the impact report, the validation API) reads off this.

## Why not just regex on paths?

Path-based detection works for greenfield projects with a clean `src/auth/`, `src/payments/` layout. It collapses on:

- Monorepos where every package has its own `auth/` subdir
- Legacy projects where the directory structure doesn't match the actual coupling (auth code mysteriously lives in `lib/middleware/`)
- Frameworks that hide the structure (Next.js routes spread across `pages/`, `app/`, `api/`)

Graph clustering is path-agnostic. It looks at who imports whom and produces named communities whose names are derived from the path tokens *most common in that cluster*. That's the magic — the cluster is found by structure, the *name* is found by frequency on the actual file paths in it.

## Naming heuristics

After clustering, Carto picks a name for each cluster:

1. Tokenize each file path: `src/auth/login.ts` → `[src, auth, login]`
2. Drop stopwords (`src`, `lib`, `app`, `index`, `utils`, `helpers`)
3. Cross-reference with a small built-in dictionary of well-known domain hints: `AUTH`, `PAYMENTS`, `DATABASE`, `NOTIFICATIONS`, `EVENTS`, `TRPC`, `CORE`
4. Most-frequent matching token wins. Ties broken by dictionary priority (security-relevant domains first).
5. If no token matches the dictionary, the most-common path token becomes the domain name (uppercased).

The result: real repos light up with sensible labels — vscode gets `EXTENSIONS`, `EVENTS`, `DATABASE`, `CLI`, `CORE`; zed (Rust) gets `DATABASE`, `AUTH`, `EVENTS`, `CORE`. A game engine would get `RENDERER`, `PHYSICS`, `AUDIO` automatically because those tokens dominate the path namespace.

## Adaptive gamma

The Leiden+CPM algorithm has a resolution parameter γ (gamma). High γ → many small clusters. Low γ → few big clusters. Carto picks γ based on repo size:

- **<100 files:** keyword-only fallback (graph clustering over-fragments tiny repos)
- **100–1,000 files:** γ = 0.04
- **1,000–10,000 files:** γ scales linearly to 0.02
- **>10,000 files:** γ = 0.015 (large repos have dense graphs; tighter resolution prevents one giant component)

These constants come from validation on 12 real repos. See `src/store/sync.js` for the exact formula.

## Custom domains via `carto.config.json`

Override the auto-detection if your repo needs it. Two shapes:

**Simple — keyword hints:**

```json
{
  "domains": {
    "EDITOR": ["editor", "monaco", "text"],
    "WORKBENCH": ["workbench", "layout", "panel"]
  }
}
```

Files whose path tokens match the hints get pulled into the named domain even if the graph clusterer would have put them elsewhere.

**Full — keywords + anchors:**

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

Anchor files are *pinned*. They always end up in their named domain regardless of clustering. Useful when you've got a deliberately central auth file that the graph clusterer would otherwise lump into CORE.

## Stability across syncs

Re-clustering after a code change can shuffle domain assignments. Carto tracks the previous mapping and warns when >5% of files change domain between syncs (`carto check` surfaces it as "unstable clustering"). Anchor files give you a way to force stability where it matters.

## Where domains show up

- **`AGENTS.md`** lists them with file counts
- **`.carto/context/<DOMAIN>.md`** has per-domain context the AI reads when working in that area
- **`get_domain(name)`** MCP tool returns the full list of files, routes, models in a domain
- **`validate_diff`** uses cross-domain edges as a violation signal — adding `auth/login.ts → payments/billing.ts` is HIGH-risk because it crosses a sensitive boundary

## Related

- [`get_cross_domain`](./mcp-integration.md#get_cross_domain) — every import edge that crosses a domain
- [`carto check`](../../README.md#cli-commands) — flags new cross-domain violations
- [Leiden algorithm paper](https://www.nature.com/articles/s41598-019-41695-z) — the algorithm Carto uses
