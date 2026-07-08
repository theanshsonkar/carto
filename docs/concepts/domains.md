# Concept: Domains

> Named groupings of related files — Carto's "AUTH", "PAYMENTS", "DATABASE". Declared in config when you want them exact, inferred from the code when you don't.

## The intuition

A *domain* is a slice of the codebase that hangs together: the auth code, the billing code, the database layer. Carto assigns every file to exactly one domain and everything downstream — `get_cross_domain`, `get_data_flow`, the impact report, `validate_diff`'s cross-boundary signal — reads off that single assignment.

There are two ways a file gets its domain, in strict priority order:

1. **Declared** — you told Carto in `carto.config.json`. Deterministic, always wins.
2. **Inferred** — Carto guessed from path keywords and the import graph. The fallback for anything you didn't declare.

## Source of truth (why the numbers always agree)

Domain assignments live in the `domain_assignments` table. The `files.domain_id` column is a **denormalized mirror** of that table, written in the same call (`assignFileToDomain`) and cleared in the same call (`clearDomainAssignments`) — the two can never drift. Every tool resolves a file's domain through one accessor, `store.getDomainOf(fileIdOrPath)`, so `get_data_flow` and `get_cross_domain` can never report different domains for the same file. (Before v2.1 they could: `data_flow` read the never-populated `files.domain_id` and showed blank while `cross_domain` read `domain_assignments` and showed a domain — that split is now closed.)

## 1. Declared domains (primary)

Two override shapes, both under `domains` in `carto.config.json`.

**Globs → domain (recommended for monorepos).** Any file whose path matches a domain's globs is assigned that domain regardless of what inference would have guessed. First matching domain in declaration order wins.

```json
{
  "domains": {
    "EDITOR":    { "globs": ["src/editor/**", "packages/*/editor/**"] },
    "WORKBENCH": { "globs": ["src/workbench/**"] }
  }
}
```

Supported glob syntax: `**` (any number of path segments), `*` (any run of characters except `/`), `?` (a single non-`/` character). Everything else matches literally, paths are compared with `/` separators, and the match is anchored (full-path).

**Keywords + anchors (finer control).**

```json
{
  "domains": {
    "AUTH": {
      "keywords": ["auth", "login", "session"],
      "anchor":   ["src/auth/session.ts", "src/auth/middleware.ts"]
    }
  }
}
```

- `keywords` feed the inference seed list (below) — hints, not hard rules.
- `anchor` files are *pinned*: they always land in the named domain. Anchors are the most specific override and win even over globs.

Precedence: **anchors > globs > inference.** Declared assignments are recorded with confidence `1.0`.

## 2. Inference (the fallback)

For everything not covered by config, Carto picks a strategy based on repo size and import-graph density (`selectClusteringStrategy` in `src/store/sync.js`):

| Condition | Strategy |
|---|---|
| `< 100` files | keyword + vote |
| import density `< 1.5` edges/file (sparse graphs, most monorepos) | keyword + vote |
| otherwise (dense, larger repos) | Leiden+CPM graph clustering |

> The docs used to claim Leiden ran on *every* repo. It doesn't — sparse and small repos (which includes big monorepos like supabase, whose graph is sparse) use the keyword-and-vote path. Leiden is reserved for dense graphs where community detection actually beats keywords.

### 2a. Keyword + vote (small / sparse repos)

Implemented in `buildFileAssignments` (`src/agents/domains.js`):

1. **Seed by keyword** — a file is seeded into a domain when a built-in keyword matches a **path segment** of its path (`/auth/`, `/auth.`, `-auth.`, `_auth.`, `/auth-`, `/auth_`), never an arbitrary substring. Confidence `0.9`.
   The seed list is deliberately narrow: `auth/login/logout/oauth/jwt/session/password/credential` (AUTH), `payment/billing/stripe/invoice/subscription/checkout` (PAYMENTS), `trpc/procedure` (TRPC), `prisma/drizzle/migration/sqlalchemy` (DATABASE), `webhook/queue/worker/cron` (EVENTS), `notification/mailer/sms` (NOTIFICATIONS). Over-broad tokens that caused false positives — `token`, `db`, `model`, `schema`, `event`, `job`, `task`, `router` — were removed.
2. **Expand by a conservative import vote** — up to 2 hops, an unseeded file adopts a neighbor domain only when that domain has **≥ 2 votes from seed-strength neighbors**, is a **strict plurality**, and is **≥ 50 % of all domain votes** among its neighbors. Otherwise it stays unassigned. Confidence `0.5`. This is what stops a single AUTH-labelled neighbor from painting an entire import chain AUTH (the old "theme → AUTH", "byte-util → AUTH" bug).
3. **Everything left → `CORE`**, confidence `0.2`. A low-confidence file is honestly `CORE`, never a wrong specific domain.

### 2b. Leiden+CPM (dense repos)

`clusterByGraph` (`src/agents/leiden.js`) runs Leiden community detection with the Constant Potts Model quality function over the undirected import graph. Communities are then **named** — by keyword-seed match first, then by the most common distinctive path segment (stopwords like `src`, `lib`, `app`, `utils` dropped). Communities smaller than `minSize` are merged into `CORE`.

**Adaptive resolution (γ).** Higher γ → more, smaller communities.

```
γ       = min(0.10, 0.02 + 0.02 · log10(fileCount / 10))
minSize = clamp(round(sqrt(fileCount)), 5, 20)
```

See `selectClusteringStrategy` in `src/store/sync.js` for the exact formula.

## Confidence

Every assignment carries a confidence in `domain_assignments.confidence`:

| Source | Confidence |
|---|---|
| Declared glob / anchor | `1.0` |
| Keyword seed (path-segment match) | `0.9` |
| Import vote | `0.5` |
| `CORE` fallback | `0.2` |

Low confidence is a feature: Carto would rather label a file `CORE` than guess a specific domain it isn't sure about.

## Stability across syncs

Re-clustering after a code change can shuffle assignments. Carto stores the previous mapping and warns via `carto check` when > 5 % of files change domain between syncs. Declared globs and anchors give you deterministic stability where it matters.

## Where domains show up

- **`AGENTS.md`** lists them with file counts.
- **`.carto/context/<DOMAIN>.md`** holds per-domain context the AI reads when working in that area.
- **`get_domain(name)`** returns the files, routes, and models in a domain.
- **`get_cross_domain`** lists every import edge whose endpoints are in different domains.
- **`validate_diff`** treats new cross-domain edges as a risk signal.

## Related

- [`get_cross_domain`](./mcp-integration.md#get_cross_domain) — every import edge that crosses a domain boundary
- [`carto check`](../../README.md#cli) — flags new cross-domain violations and clustering instability
- [Leiden algorithm paper](https://www.nature.com/articles/s41598-019-41695-z) — the community-detection algorithm used for dense repos
