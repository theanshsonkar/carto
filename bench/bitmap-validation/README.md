# Bitmap Engine Validation Benchmark

Measures whether a bitmap-based graph engine meaningfully outperforms SQLite for Carto's MCP tool queries.

## Run

```bash
# Ensure the target repo has been indexed
carto init   # (in the target repo)

# Run the benchmark
npm run bench:bitmap -- --repo ~/carto-test-repos/tier-b/vscode
```

## Output

- `raw-results.json` — per-call nanosecond timings for all 5 tools × 2 engines
- `REPORT.md` — formatted results with latency tables and verdict

## Verdict rules

| Median p50 speedup | Verdict | Action |
|--------------------:|---------|--------|
| ≥10× | **GO** | Proceed with bitmap engine integration |
| 3–10× | **INVESTIGATE** | Query reshape or Roaring upgrade needed |
| <3× | **DEFER** | SQLite sufficient at current scale |

## Tools benchmarked

1. `blastRadius` — BFS over reverse adjacency (vs `getBlastRadius` SQL)
2. `crossDomain` — domain-mismatch scan (vs `getCrossDomainDeps` SQL)
3. `highImpactFiles` — popcount sort (vs `getHighImpactFiles` SQL)
4. `similarPatterns` — Jaccard over import sets (vs `getNeighbors` SQL)
5. `simulateChangeImpact` — OR-aggregate union (NEW, bitmap-only)

## Implementation

- **Bitset:** 60-line `Uint32Array`-based, zero dependencies
- **No production code touched** — lives entirely in `bench/`
- **Not shipped to users** — dev-only benchmark
