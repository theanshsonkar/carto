# Carto scale validation harness

Drives Carto end-to-end at sizes far beyond the corpus repos in `~/carto-test-repos` (the largest of which is vscode at 7,567 indexed files). The harness produces the data that backs `docs/scale.md` and the bitmap-1000× blog post.

## Synth

Generates a deterministic-for-seed TypeScript repo with a real-shaped import graph (Pareto fan-out, hotspot-biased targets, 5 domain-like dirs) at any size, then runs `runSync` cold + warm and benchmarks the bitmap query path.

```bash
# Quick smoke (1K files, ~5s)
npm run bench:scale -- --size 1000

# Mid-scale validation
npm run bench:scale -- --size 10000
npm run bench:scale -- --size 100000

# Maintainer-machine runs (multi-GB disk, 5-25 min walltime)
npm run bench:scale -- --size 500000 --keep --out /tmp/carto-500k
npm run bench:scale -- --size 1000000 --keep --out /tmp/carto-1m
```

Flags:

| Flag | Default | Effect |
|------|---------|--------|
| `--size N` | required | Number of files to synthesise |
| `--out PATH` | `$TMPDIR/carto-scale-<size>` | Where to write the synth + .carto |
| `--seed N` | 42 | PRNG seed (generator + query inputs) |
| `--queries-only` | off | Skip init/sync; only run the query benchmark |
| `--keep` | off | Don't delete the output dir on completion |
| `--regen` | off | Force regeneration even if outDir already exists |

Each run writes `bench/scale-test/results/synth-<size>-<ts>.json` and refreshes `bench/scale-test/REPORT.md` (latest run per size kept).

## Real-world (Linux kernel, Chromium, anything else huge)

The driver does **not** clone for you — too easy to nuke a maintainer's disk. Clone first, then point the runner at the result:

```bash
# Linux kernel (~75K source files, 28-30M LOC; clone is multi-GB)
git clone --depth=1 https://github.com/torvalds/linux ~/clones/linux
node bench/scale-test/real-world.js --repo ~/clones/linux --name linux-kernel

# Chromium (~75K-100K source files; clone is 20+ GB; follow Chromium docs)
node bench/scale-test/real-world.js --repo ~/clones/chromium/src --name chromium
```

Output shape matches synth — both kinds end up in the same `REPORT.md` table.

## What gets measured

- **Init time** — full `runSync` from a wiped `.carto/`
- **Sync time** — second `runSync` immediately after, no files changed
- **DB size** — `.carto/carto.db` bytes on disk
- **bitmap.bin size** — the sidecar bytes
- **Sidecar (RAM)** — sum of all bitmap word-array byte lengths
- **Peak RSS** — sampled during init and during query workloads
- **Per-tool p50 / p99** — 1000 calls each, with 50-call warmup, on the 5 production bitmap tools (`blastRadius`, `crossDomain`, `highImpactFiles`, `similarPatterns`) plus `simulate_change_impact`. Random inputs are seeded so two runs at the same `--seed` produce identical workloads.

The query stage opens the SQLite store **read-only** — invariant honored. Bitmap rebuild from the disk file is timed separately as `sidecar.loadNs` so a missing-`bitmap.bin` cold-start cost is visible distinct from steady-state query latency.

## Why bitmap-only at this scale

The bitmap-validation harness in `bench/bitmap-validation` already produced a SQLite-vs-bitmap comparison on the 12 corpus repos. At 100K+ files the SQLite path becomes impractical to time fairly: a single `getBlastRadius` traverses 50-500K rows and produces seconds-per-call latency, which would make 1000-call timing runs take an hour and tell you nothing the 7K-file comparison didn't already establish. The job here is to demonstrate the bitmap path scales — not to re-prove it beats SQLite.
