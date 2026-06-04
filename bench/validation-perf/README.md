# Validation API performance benchmark

Performance gate. Measures `validateDiff(store, sidecar, diff)` latency
on a real corpus repo (e.g. vscode) with a representative 20-line diff.

## Usage

```
node bench/validation-perf/index.js --repo ~/carto-test-repos/tier-b/vscode
```

Targets (vscode, 7K files):
- p50 ≤ 5ms
- p99 ≤ 15ms

The harness picks 20 random target files in the repo (mid-blast-radius —
not the highest-impact file, not pure leaves) and benchmarks 1000
calls per target with a synthetic 20-line diff that adds an import line
crossing into a different domain. This stresses both code paths
(blast_radius lookup + cross_domain detection).

Reads `.carto/carto.db` directly (read-only) — does NOT trigger an
index rebuild. Run `carto sync` first if the repo is stale.
