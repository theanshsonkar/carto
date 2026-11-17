'use strict';
// Pain-map experiment runner.
//
//   node bench/pain-map/run.js baseline   -> baseline x2 (sequential) + concurrency check (3 copies at once)
//   node bench/pain-map/run.js sanity     -> one hand-made mutant, must fail a known suite and restore
//   node bench/pain-map/run.js mutants [--max-files N]
//
// Each test run executes in a private mount + network namespace:
//   - the worker copy is bind-mounted at /run/painmap/<worker>
//   - /tmp is a fresh tmpfs (test/test.js hard-codes /tmp/carto-test, so
//     two copies sharing the real /tmp would race on it)
//   - HOME is a fresh dir on that tmpfs (mutated init code cannot touch ~)
//   - no network (loopback only, down); CARTO_NO_UPDATE_CHECK=1
// Worker copies live under WORK (never /home/user/carto). Each mutated file
// is restored in try/finally and verified by sha256.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { listSites, applySite, chooseSites, prng, seedFor, shuffle } = require('./mutate');

const REPO = path.resolve(__dirname, '..', '..');
const WORK = process.env.PAINMAP_WORK ||
  '/tmp/claude-0/-home-user-carto/c9080dca-aded-5212-b2c2-4fe126a6b83b/scratchpad/painmap-work';
const RESULTS = path.join(__dirname, 'results');
const WORKERS = ['w1', 'w2', 'w3'];
const SEED = 20261117;
const K = 6;
const MIN_SITES = 4;
const BUDGET_SEC = 35 * 60;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (path.resolve(WORK).startsWith(REPO + path.sep)) throw new Error('WORK must be outside the repo');

function listSrcFiles(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = path.posix.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.isFile() && rel.endsWith('.js')) out.push(rel);
    }
  };
  walk('src');
  return out.sort();
}

// Snapshot of the code a run could depend on (src/, test/, index.js) in a copy.
function snapshot(copy) {
  const files = [...listSrcFiles(copy)];
  for (const f of fs.readdirSync(path.join(copy, 'test'))) files.push('test/' + f);
  files.push('index.js', 'package.json');
  const m = {};
  for (const f of files.sort()) {
    const p = path.join(copy, f);
    if (fs.statSync(p).isFile()) m[f] = sha(fs.readFileSync(p));
  }
  return m;
}

function diffSnap(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]);
}

// Repair any drift in a worker copy from the pristine repo (read-only use of REPO).
function repairCopy(copy, keys) {
  for (const k of keys) {
    const src = path.join(REPO, k);
    const dst = path.join(copy, k);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    else if (fs.existsSync(dst)) fs.rmSync(dst);
  }
}

function parseSummary(stdout) {
  const suites = {};
  const re = /^([✓✗]) (.+) — (\d+)\/(\d+)\s*$/;
  for (const line of stdout.split('\n')) {
    const m = re.exec(line);
    if (m) suites[m[2]] = { ok: m[1] === '✓', pass: +m[3], total: +m[4] };
  }
  return suites;
}

function runTests(worker, timeoutMs) {
  const copy = path.join(WORK, worker);
  const mnt = `/run/painmap/${worker}`;
  fs.mkdirSync(mnt, { recursive: true });
  const script = [
    'set -e',
    `mount --bind '${copy}' '${mnt}'`,
    'mount -t tmpfs -o size=2g tmpfs /tmp',
    'mkdir -p /tmp/home',
    `cd '${mnt}'`,
    'exec env HOME=/tmp/home CARTO_NO_UPDATE_CHECK=1 TMPDIR=/tmp node test/test.js',
  ].join('\n');
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('unshare', ['-m', '-n', '--propagation', 'private', 'sh', '-c', script], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { if (err.length < 200000) err += d; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, ms: Date.now() - t0, stdout: out, stderr: err, suites: parseSummary(out) });
    });
  });
}

// A suite "feels pain" if marked ✗ or passes fewer tests than at baseline.
function failingSuites(res, baseline) {
  const failed = [];
  for (const [name, b] of Object.entries(baseline)) {
    const s = res.suites[name];
    if (!s) { failed.push(name); continue; }
    if (!s.ok || s.pass < b.pass) failed.push(name);
  }
  return failed.sort();
}

function classify(res, baseline) {
  const reported = Object.keys(res.suites).length > 0;
  if (res.timedOut) return { outcome: 'timeout', fail: [] };
  if (!reported) return { outcome: 'crash', fail: [] };
  const fail = failingSuites(res, baseline);
  if (fail.length) return { outcome: 'killed', fail };
  if (res.code !== 0) return { outcome: 'killed-nosuite', fail: [] };
  return { outcome: 'survived', fail: [] };
}

function tailOf(s, n = 600) { return s.length > n ? s.slice(-n) : s; }

// ── baseline ───────────────────────────────────────────────────────────
async function baseline() {
  const report = { sequential: [], concurrent: [] };
  for (let i = 0; i < 2; i++) {
    const before = snapshot(path.join(WORK, 'w1'));
    const r = await runTests('w1', 120000);
    const drift = diffSnap(before, snapshot(path.join(WORK, 'w1')));
    report.sequential.push({ code: r.code, ms: r.ms, suites: r.suites, drift, stderrTail: tailOf(r.stderr) });
    console.log(`sequential run ${i + 1}: exit=${r.code} ${r.ms}ms suites=${Object.keys(r.suites).length} drift=${drift.length}`);
  }
  for (let i = 0; i < 2; i++) {
    const rs = await Promise.all(WORKERS.map((w) => runTests(w, 120000)));
    report.concurrent.push(rs.map((r, j) => ({ worker: WORKERS[j], code: r.code, ms: r.ms, suites: r.suites })));
    console.log(`concurrent round ${i + 1}: ` + rs.map((r, j) => `${WORKERS[j]} exit=${r.code} ${r.ms}ms`).join(', '));
  }
  // Stable suite set: green and identical (pass/total) across all 8 runs.
  const all = [...report.sequential.map((r) => r.suites), ...report.concurrent.flat().map((r) => r.suites)];
  const names = new Set(all.flatMap((s) => Object.keys(s)));
  const stable = {};
  const dropped = [];
  for (const n of [...names].sort()) {
    const xs = all.map((s) => s[n]);
    const ok = xs.every((x) => x && x.ok && x.pass === xs[0].pass && x.total === xs[0].total);
    const seqOk = report.sequential.every((r) => r.suites[n] && r.suites[n].ok) &&
      report.sequential[0].suites[n].pass === report.sequential[1].suites[n].pass;
    if (seqOk) stable[n] = { pass: xs[0].pass, total: xs[0].total };
    if (!ok) dropped.push({ suite: n, seqOk, runs: xs });
  }
  const concurrencySafe = dropped.every((d) => !d.seqOk) &&
    report.concurrent.flat().every((r) => r.code === 0);
  report.stable = stable;
  report.droppedOrUnstable = dropped;
  report.concurrencySafe = concurrencySafe;
  const seqMs = report.sequential.map((r) => r.ms);
  const conMs = report.concurrent.flat().map((r) => r.ms);
  report.baselineMs = Math.max(...seqMs);
  report.concurrentMaxMs = Math.max(...conMs);
  fs.writeFileSync(path.join(RESULTS, 'baseline.json'), JSON.stringify(report, null, 2));
  console.log(`stable suites: ${Object.keys(stable).length}; dropped/unstable: ${dropped.length}; concurrencySafe=${concurrencySafe}`);
}

function loadBaseline() {
  return JSON.parse(fs.readFileSync(path.join(RESULTS, 'baseline.json'), 'utf8'));
}

// ── one mutant ─────────────────────────────────────────────────────────
async function runMutant(worker, file, site, timeoutMs, stable) {
  const copy = path.join(WORK, worker);
  const abs = path.join(copy, file);
  const orig = fs.readFileSync(abs);
  const origHash = sha(orig);
  const pristineHash = sha(fs.readFileSync(path.join(REPO, file)));
  if (origHash !== pristineHash) throw new Error(`${worker}:${file} differs from repo before mutation`);
  let res;
  try {
    fs.writeFileSync(abs, applySite(orig.toString('utf8'), site));
    res = await runTests(worker, timeoutMs);
  } finally {
    fs.writeFileSync(abs, orig);
    const after = sha(fs.readFileSync(abs));
    if (after !== origHash) throw new Error(`RESTORE FAILED for ${worker}:${file}`);
  }
  const c = classify(res, stable);
  return {
    file, site: { id: site.id, op: site.op, line: site.line, fn: site.fn, original: site.original.slice(0, 80) },
    worker, outcome: c.outcome, fail: c.fail, exit: res.code, signal: res.signal, ms: res.ms,
    stderrTail: c.outcome === 'crash' || c.outcome === 'killed-nosuite' ? tailOf(res.stderr, 400) : undefined,
  };
}

async function sanity() {
  const b = loadBaseline();
  const file = 'src/store/path-utils.js';
  const sites = listSites(fs.readFileSync(path.join(REPO, file), 'utf8'));
  // Hand-picked: first `if` test in normalizeFileArg -> false.
  const site = sites.find((s) => s.fn === 'normalizeFileArg' && s.op === 'if->false');
  const before = snapshot(path.join(WORK, 'w1'));
  const r = await runMutant('w1', file, site, b.baselineMs * 3, b.stable);
  const drift = diffSnap(before, snapshot(path.join(WORK, 'w1')));
  const out = { file, site, result: r, drift, expectSuite: 'Path normalization', pass: r.outcome === 'killed' && r.fail.includes('Path normalization') && drift.length === 0 };
  fs.writeFileSync(path.join(RESULTS, 'sanity.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ outcome: r.outcome, fail: r.fail, drift, pass: out.pass }));
}

// ── mutation campaign ──────────────────────────────────────────────────
function planMutants(maxFiles) {
  const files = listSrcFiles(REPO);
  const eligible = [];
  const siteCounts = {};
  for (const f of files) {
    const sites = listSites(fs.readFileSync(path.join(REPO, f), 'utf8'));
    siteCounts[f] = sites.length;
    if (sites.length >= MIN_SITES) eligible.push({ file: f, sites });
  }
  let chosenFiles = eligible;
  if (maxFiles && maxFiles < eligible.length) {
    const rnd = prng(SEED);
    chosenFiles = shuffle(eligible, rnd).slice(0, maxFiles).sort((a, b) => (a.file < b.file ? -1 : 1));
  }
  const plan = [];
  for (const { file, sites } of chosenFiles) {
    const rnd = prng(seedFor(file, SEED));
    for (const s of chooseSites(sites, K, rnd)) plan.push({ file, site: s });
  }
  return { plan, eligible: eligible.length, totalFiles: files.length, sampledFiles: chosenFiles.length, siteCounts };
}

async function mutants(maxFiles) {
  const b = loadBaseline();
  const workers = b.concurrencySafe ? WORKERS : ['w1'];
  const timeoutMs = Math.round(b.concurrentMaxMs * 3);
  const { plan, eligible, totalFiles, sampledFiles, siteCounts } = planMutants(maxFiles);
  console.log(`files=${totalFiles} eligible=${eligible} sampled=${sampledFiles} mutants=${plan.length} workers=${workers.length} timeout=${timeoutMs}ms`);
  const rawPath = path.join(RESULTS, 'raw-mutants.json');
  const results = [];
  const snaps = {};
  for (const w of workers) snaps[w] = snapshot(path.join(WORK, w));
  const pristine = snapshot(REPO);
  for (const w of workers) {
    const d = diffSnap(pristine, snaps[w]);
    if (d.length) throw new Error(`${w} differs from repo: ${d.join(',')}`);
  }
  const drifts = [];
  const t0 = Date.now();
  let next = 0;
  async function loop(w) {
    while (next < plan.length) {
      const i = next++;
      const { file, site } = plan[i];
      const r = await runMutant(w, file, site, timeoutMs, b.stable);
      r.index = i;
      results.push(r);
      const d = diffSnap(snaps[w], snapshot(path.join(WORK, w)));
      if (d.length) { drifts.push({ index: i, worker: w, files: d }); repairCopy(path.join(WORK, w), d); }
      const done = results.length;
      if (done % 10 === 0 || done === plan.length) {
        const el = (Date.now() - t0) / 1000;
        console.log(`[${done}/${plan.length}] ${el.toFixed(0)}s eta ${(el / done * (plan.length - done)).toFixed(0)}s`);
        fs.writeFileSync(rawPath, JSON.stringify({ partial: true, results }, null, 0));
      }
    }
  }
  await Promise.all(workers.map(loop));
  const wallSec = (Date.now() - t0) / 1000;
  results.sort((a, b2) => a.index - b2.index);
  // Final check: every worker copy matches the pristine repo.
  const finalDiffs = {};
  for (const w of workers) finalDiffs[w] = diffSnap(pristine, snapshot(path.join(WORK, w)));
  const out = {
    seed: SEED, K, minSites: MIN_SITES, workers, timeoutMs, wallSec,
    totalSrcFiles: totalFiles, eligibleFiles: eligible, sampledFiles,
    siteCounts, drifts, finalDiffs, results,
  };
  fs.writeFileSync(rawPath, JSON.stringify(out, null, 1));
  console.log(`done in ${wallSec.toFixed(0)}s; drifts=${drifts.length}; finalDiffs=${JSON.stringify(finalDiffs)}`);
}

async function estimate() {
  const b = loadBaseline();
  const { plan, eligible } = planMutants();
  const per = b.concurrentMaxMs / 1000 / (b.concurrencySafe ? WORKERS.length : 1);
  console.log(`eligible=${eligible} mutants=${plan.length} est=${(plan.length * per / 60).toFixed(1)} min (per-run concurrent ${b.concurrentMaxMs}ms)`);
}

const cmd = process.argv[2];
const mfIdx = process.argv.indexOf('--max-files');
const maxFiles = mfIdx > 0 ? parseInt(process.argv[mfIdx + 1], 10) : 0;
const fns = { baseline, sanity, mutants: () => mutants(maxFiles), estimate };
if (!fns[cmd]) { console.error('usage: run.js baseline|sanity|estimate|mutants [--max-files N]'); process.exit(2); }
fs.mkdirSync(RESULTS, { recursive: true });
fns[cmd]().catch((e) => { console.error(e); process.exit(1); });
