# Concept: Blast Radius

> The set of files affected by changing a given file, computed transitively over the import graph.

## The intuition

Open `src/lib/db.ts`. Other files `import` from it. Those files have other files that import *them*. And so on. Anything reachable by following reverse-import edges is in the **blast radius** of `db.ts`.

```
src/lib/db.ts
   ↑
src/store/user.ts ← src/api/users.ts
                  ← src/api/admin.ts
   ↑
src/store/order.ts ← src/api/orders.ts
                   ← src/jobs/billing.ts
```

If you change `db.ts`, six files might break. That's the blast radius.

## How carto computes it

Two layers:

**1. Direct dependents (1 hop).** The import graph stores every `from_file → to_file` edge. The reverse — *who imports me* — is one SQL query: `SELECT from_file_id FROM imports WHERE to_file_id = ?`.

**2. Transitive dependents (≤5 hops).** From the seed file, BFS over the reverse-import graph. Carto caps at 5 hops because diminishing returns: 99% of real change impact lives in the first 3 hops, hops 4–5 catch the outliers, and beyond that you're paying memory for noise.

The bitmap engine makes this fast. A 1M-edge graph fits in a few MB of Roaring Bitmaps; one transitive query is a chain of `bitmap_OR` operations executed in SIMD at ~1 cycle per 512 bits. On the vscode repo (7,567 files, 13,335 edges) a 5-hop blast-radius query returns in ~3 µs.

## What you do with it

Three places it lands:

- **`carto impact <file>`** prints the radius for a single file
- **`get_blast_radius(file)`** MCP tool gives the AI the same data
- **`validate_diff(patch)`** uses blast radius to assign a risk grade to a PR

For the last one, the rule of thumb is:

| Direct dependents | Risk (default thresholds) |
|------------------:|---------------------------|
| 0–2               | SAFE                      |
| 3–20              | LOW                       |
| 21–50             | MEDIUM                    |
| 51+               | HIGH                      |

These thresholds are tunable per project via `carto.config.json`. Cross-domain edges (e.g. AUTH importing PAYMENTS) escalate independently — see [`domains.md`](./domains.md).

## What it isn't

- **Not a behavioral analysis.** Blast radius doesn't tell you which dependents will actually break, just which ones *might*. The AI uses this as a pre-filter, not as a verdict.
- **Not call-graph reachability.** It's import-graph reachability. If A imports B but never calls anything from it (dead import), B is still in A's blast radius. We don't try to model dynamic dispatch or runtime imports.
- **Not a refactoring oracle.** A 50-dependent file isn't automatically bad. Some files (utility modules, type definitions) *should* be widely depended on. Blast radius is a signal, not a sentence.

## Why the bitmap version matters

The original SQLite-only implementation worked fine to ~10K files but slowed down rapidly past that — each transitive query is `O(hops × dependents × indexed-lookup)` which adds up. Bitmap queries are `O(hops × bitmap-width)` regardless of how many dependents each file has. On 1M-file synthetic graphs the bitmap path returns in microseconds where SQLite takes seconds.

See [`docs/scale.md`](../scale.md) for the per-tool latency table at synthetic scale and on real-world repos.

## Related

- [`get_blast_radius`](./mcp-integration.md#get_blast_radius) MCP tool reference
- [`simulate_change_impact`](./mcp-integration.md#simulate_change_impact) — union of the blast radius for multiple files
- [`validate_diff`](./mcp-integration.md#validate_diff) — diff-shaped risk grade built on blast radius
