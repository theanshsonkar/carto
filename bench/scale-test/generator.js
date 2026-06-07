'use strict';

/**
 * Synthetic repo generator for the scale validation harness.
 *
 * Produces a deterministic-for-seed TypeScript repo of arbitrary size
 * (1K → 1M files) whose import graph has the shape of a real codebase:
 *
 *   - 5 domain-like top-level directories (auth, payments, database,
 *     events, core) so Leiden+CPM has signal to recover named clusters.
 *   - Pareto(α=2) fan-out per file, clipped to [1, 8]. Median 1, mean
 *     ~2, p99 hits the cap. Edge density ≈ 2N — close to real codebases
 *     (vscode 1.77 edges/file, supabase 0.84, prisma 1.44).
 *   - Targets sampled with `hi × rand()^4` bias so the first ~10% of
 *     file ids accumulate most of the in-edges. This produces the
 *     non-uniform blast-radius distribution that makes `highImpactFiles`,
 *     `simulate_change_impact`, and the popcount-index sort meaningful
 *     at scale.
 *   - 75% same-domain / 25% cross-domain so `crossDomain` has real
 *     work to do at the bitmap layer.
 *   - Imports always reference an EARLIER file id — the graph is
 *     acyclic by construction so `reverse_deps` BFS terminates cleanly.
 *
 * Files are tiny (5-15 lines each) — synth is about graph shape, not
 * source-line volume. Disk usage scales as ~250 bytes/file:
 *     1K  → ~250 KB
 *     10K → ~2.5 MB
 *     100K → ~25 MB
 *     1M  → ~250 MB raw + ~1 GB for the .carto index after carto init.
 *
 * The generator is pure: it only writes files, never invokes carto.
 * Pair with `runner.js` to measure init/sync/query latency.
 */

const fs = require('fs');
const path = require('path');

const DOMAINS = ['auth', 'payments', 'database', 'events', 'core'];

/**
 * Mulberry32 — small, fast, well-distributed seedable PRNG. Same family
 * V8's Math.random uses internally; deterministic across Node versions.
 * 32-bit state, period 2^32 (sufficient for ≤1B file ids per run).
 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pareto(α) fan-out, clipped to [minK, maxK]. With minK=1, α=2 produces
 * median 1, mean ~2, p99 ≈ 10 (clipped to maxK).
 */
function sampleFanOut(rand, minK = 1, maxK = 8) {
  const alpha = 2.0;
  const u = Math.max(1e-9, 1 - rand());
  const k = Math.floor(minK / Math.pow(u, 1 / alpha));
  return Math.min(maxK, Math.max(minK, k));
}

/**
 * Sample a target id in [0, hi) biased toward smaller ids.
 * `bias = 4` concentrates most edges in the first ~10% of file ids,
 * producing the blast-radius hotspots real codebases exhibit.
 */
function sampleHotspot(rand, hi, bias = 4) {
  if (hi <= 0) return -1;
  const u = rand();
  return Math.min(hi - 1, Math.floor(hi * Math.pow(u, bias)));
}

/** Round-robin assignment — file id `i` lives in domain `i % 5`. */
function domainOf(id) { return DOMAINS[id % DOMAINS.length]; }

/** Project-relative path for file `id`. Carto's discoverFiles picks up `.ts`. */
function relPathOf(id) { return `src/${domainOf(id)}/file_${id}.ts`; }

/**
 * generateRepo(outDir, { size, seed=42, withinDomainProb=0.75 })
 *   → { size, seed, edgeCount, outDir }
 *
 * Writes `size` `.ts` files plus a placeholder `package.json` to `outDir`.
 * Pre-existing files in `outDir` are NOT cleared — caller's responsibility.
 *
 * Returns metadata only; the actual paths/edges are reconstructible from
 * (size, seed) so we don't keep them in memory at 1M-file scale.
 */
function generateRepo(outDir, opts = {}) {
  const size = opts.size;
  const seed = opts.seed != null ? opts.seed : 42;
  const withinDomainProb = opts.withinDomainProb != null ? opts.withinDomainProb : 0.75;
  const onProgress = opts.onProgress; // optional (writtenCount) → void

  if (!Number.isInteger(size) || size < 1) throw new Error('size must be a positive integer');
  if (!Number.isInteger(seed)) throw new Error('seed must be integer');

  fs.mkdirSync(outDir, { recursive: true });
  const srcDir = path.join(outDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const d of DOMAINS) fs.mkdirSync(path.join(srcDir, d), { recursive: true });

  const rand = mulberry32(seed);
  const stride = DOMAINS.length;
  let totalEdges = 0;

  // We write one file at a time but progress-report every 5K so callers
  // (CLI + tests) can render a counter for the long N=1M case.
  const PROGRESS_EVERY = 5000;

  for (let i = 0; i < size; i++) {
    const myDomain = domainOf(i);
    const myDomainOffset = i % stride; // == DOMAINS.indexOf(myDomain) by construction
    const k = sampleFanOut(rand, 1, 8);
    const imports = new Set();

    for (let j = 0; j < k && i > 0; j++) {
      let target = -1;
      if (rand() < withinDomainProb) {
        // Same-domain — earlier same-domain count is floor(i / stride).
        // The cnt-th earlier same-domain id is `myDomainOffset + idx*stride`.
        const cnt = Math.floor(i / stride);
        if (cnt > 0) {
          const idx = sampleHotspot(rand, cnt);
          target = myDomainOffset + idx * stride;
        }
      } else {
        // Cross-domain — any earlier id, hotspot-biased.
        target = sampleHotspot(rand, i);
      }

      if (target < 0 || target >= i || target === i) continue;
      imports.add(target);
    }

    // Build the file. Real `import { fn<id> } from '...'` lines so the
    // tree-sitter typescript plugin produces the same import edges
    // Carto would extract from a hand-written file.
    const lines = [];
    for (const t of imports) {
      const tDom = domainOf(t);
      const rel = (tDom === myDomain) ? `./file_${t}` : `../${tDom}/file_${t}`;
      lines.push(`import { fn${t} } from '${rel}';`);
    }
    lines.push('');
    lines.push(`export function fn${i}() {`);
    // Reference up to the first 3 imports inside the body so a downstream
    // tooling pass that drops unused-import lines wouldn't degrade the graph.
    const callIds = Array.from(imports).slice(0, 3);
    for (const t of callIds) lines.push(`  fn${t}();`);
    lines.push(`  return ${i};`);
    lines.push('}');

    fs.writeFileSync(path.join(outDir, relPathOf(i)), lines.join('\n') + '\n');
    totalEdges += imports.size;

    if (onProgress && (i % PROGRESS_EVERY === 0 || i === size - 1)) {
      onProgress(i + 1);
    }
  }

  // Placeholder package.json so the dir looks like a real project root
  // and `carto init` doesn't trip on heuristic checks.
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({
    name: 'carto-scale-test',
    version: '0.0.0',
    private: true,
    description: `Synthetic repo: ${size} files, seed ${seed}`,
  }, null, 2) + '\n');

  return { size, seed, edgeCount: totalEdges, outDir };
}

module.exports = {
  generateRepo,
  DOMAINS,
  domainOf,
  relPathOf,
  // Exported for tests + reproducibility checks:
  mulberry32,
  sampleFanOut,
  sampleHotspot,
};
