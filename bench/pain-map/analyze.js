'use strict';
// Pain-map experiment: metrics + report.
//   node bench/pain-map/analyze.js <scratch-copy-with-.carto-index>
// Reads results/baseline.json, results/sanity.json, results/raw-mutants.json.
// Writes results/REPORT.md and results/carto.json.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { builtinModules } = require('module');
const { parse } = require('@babel/parser');
const { loadGraph, closure, suiteModules } = require('./static-map');
const { prng, shuffle } = require('./mutate');

const REPO = path.resolve(__dirname, '..', '..');
const RESULTS = process.env.PAINMAP_RESULTS || path.join(__dirname, 'results');
const IDX = process.argv[2] ||
  '/tmp/claude-0/-home-user-carto/c9080dca-aded-5212-b2c2-4fe126a6b83b/scratchpad/painmap-work/idx';
const SEED = 20261117;

const baseline = JSON.parse(fs.readFileSync(path.join(RESULTS, 'baseline.json'), 'utf8'));
const sanity = JSON.parse(fs.readFileSync(path.join(RESULTS, 'sanity.json'), 'utf8'));
const raw = JSON.parse(fs.readFileSync(path.join(RESULTS, 'raw-mutants.json'), 'utf8'));
const SUITES = Object.keys(baseline.stable).sort();
const NS = SUITES.length;
const HALF = NS / 2;

// ── static side ───────────────────────────────────────────────────────
const graph = loadGraph(IDX);
const sm = suiteModules(path.join(REPO, 'test', 'test.js'), REPO, graph.files);
const unattributed = SUITES.filter((s) => !sm.suites.has(s) || sm.suites.get(s).modules.size === 0);
const suitesNotInSource = SUITES.filter((s) => !sm.suites.has(s));

// test/test.js is NOT in Carto's index (IGNORE_DIRS contains 'test'), so Carto's
// native blast radius can never contain a test file. For the augmented
// STATIC-FILE we take test/test.js's own imports via Carto's extractImports.
const { extractImports } = require(path.join(REPO, 'src', 'extractors', 'imports'));
const testJsDeps = extractImports(fs.readFileSync(path.join(REPO, 'test', 'test.js'), 'utf8'),
  path.join(REPO, 'test', 'test.js'), REPO).filter((p) => graph.files.includes(p));

const staticCache = new Map();
function staticFor(file) {
  if (staticCache.has(file)) return staticCache.get(file);
  const clo = closure(graph, file);
  const touches = (m) => m === file || clo.has(m);
  const suiteSel = SUITES.filter((s) => {
    const e = sm.suites.get(s);
    if (!e || e.modules.size === 0) return true; // conservative
    for (const m of e.modules) if (touches(m)) return true;
    return false;
  });
  const native = [...(graph.blast5.get(file) || [])].filter((f) => /(^|\/)test\//.test(f));
  const testJsReaches = testJsDeps.some(touches);
  const r = {
    closureSize: clo.size,
    blast5Size: (graph.blast5.get(file) || new Set()).size,
    fileNative: native.length ? SUITES.slice() : [],
    fileAug: testJsReaches ? SUITES.slice() : [],
    testJsReaches,
    suite: suiteSel,
  };
  staticCache.set(file, r);
  return r;
}

// ── edge resolution check: Babel-scan src for literal relative requires ─
function edgeResolution() {
  const fileSet = new Set(graph.files);
  let literalRel = 0; let inGraph = 0; const missing = [];
  // Re-read Carto edges as from->to pairs
  const Database = require(path.join(IDX, 'node_modules', 'better-sqlite3'));
  const db = new Database(path.join(IDX, '.carto', 'carto.db'), { readonly: true });
  const pairs = new Set(db.prepare(`SELECT a.path AS f, b.path AS t FROM imports i
    JOIN files a ON a.id = i.from_file_id JOIN files b ON b.id = i.to_file_id`).all().map((r) => `${r.f}->${r.t}`));
  const unresolved = db.prepare('SELECT to_path FROM imports WHERE to_file_id IS NULL').all().map((r) => r.to_path);
  db.close();
  const builtin = new Set(builtinModules);
  let unBuiltin = 0; let unPkg = 0; let unOther = 0; const unOtherEx = [];
  for (const u of unresolved) {
    const base = u.replace(/^node:/, '');
    if (builtin.has(base) || builtin.has(base.split('/')[0])) unBuiltin++;
    else if (/^(@[\w.-]+\/)?[\w.-]+(\/.*)?$/.test(u) && fs.existsSync(path.join(REPO, 'node_modules', u.startsWith('@') ? u.split('/').slice(0, 2).join('/') : u.split('/')[0]))) unPkg++;
    else { unOther++; if (unOtherEx.length < 8) unOtherEx.push(u); }
  }
  for (const f of graph.files.filter((x) => x.startsWith('src/') && x.endsWith('.js'))) {
    let ast;
    try { ast = parse(fs.readFileSync(path.join(REPO, f), 'utf8'), { sourceType: 'unambiguous', allowReturnOutsideFunction: true, allowHashBang: true }); } catch { continue; }
    const visit = (n) => {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' &&
        n.arguments[0] && n.arguments[0].type === 'StringLiteral' && /^\.\.?\//.test(n.arguments[0].value)) {
        const spec = n.arguments[0].value;
        const base = path.resolve(REPO, path.dirname(f), spec);
        let target = null;
        for (const c of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) { target = path.relative(REPO, c).split(path.sep).join('/'); break; }
        }
        if (target && fileSet.has(target)) {
          literalRel++;
          if (pairs.has(`${f}->${target}`)) inGraph++; else missing.push(`${f} -> ${spec}`);
        }
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc') continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string') visit(v);
      }
    };
    visit(ast.program);
  }
  return { literalRelativeRequiresToIndexedFiles: literalRel, presentInCartoGraph: inGraph, missing: [...new Set(missing)],
    unresolvedEdgeBreakdown: { builtin: unBuiltin, npmPackage: unPkg, other: unOther, otherExamples: unOtherEx } };
}

// ── impact CLI spot check ─────────────────────────────────────────────
function impactSpotCheck(file) {
  const out = execFileSync('node', ['src/cli/index.js', 'impact', file], {
    cwd: IDX, env: { ...process.env, CARTO_NO_UPDATE_CHECK: '1' }, encoding: 'utf8',
  });
  const deps = out.split('\n').filter((l) => l.trim().startsWith('→')).map((l) => l.trim().slice(1).trim());
  const mine = [...(graph.blast5.get(file) || [])];
  const same = deps.length === mine.length && deps.every((d) => mine.includes(d));
  return { file, cliDependents: deps.length, ourBlast5: mine.length, identical: same,
    cliTestFiles: deps.filter((d) => /(^|\/)test\//.test(d)).length };
}

// ── metrics ───────────────────────────────────────────────────────────
const R = raw.results;
const count = (o) => R.filter((r) => r.outcome === o).length;
const killedAll = R.filter((r) => r.outcome === 'killed');

function metrics(pop, selFn) {
  let det = 0; let rec = 0; let cost = 0; let n = 0;
  for (const m of pop) {
    const sel = new Set(selFn(m));
    const hit = m.fail.filter((s) => sel.has(s)).length;
    if (hit > 0) det++;
    rec += hit / m.fail.length;
    cost += sel.size / NS;
    n++;
  }
  return n ? { n, detection: det / n, detected: det, fullRecall: rec / n, cost: cost / n, meanSelected: cost / n * NS } : { n: 0 };
}

function evaluate(killed) {
  const byFile = new Map();
  for (const m of killed) { if (!byFile.has(m.file)) byFile.set(m.file, []); byFile.get(m.file).push(m); }
  const others = (m) => byFile.get(m.file).filter((x) => x !== m);
  const union = (ms) => { const s = new Set(); for (const x of ms) for (const f of x.fail) s.add(f); return [...s]; };
  const preds = {
    'ALL': () => SUITES,
    'STATIC-FILE (Carto native)': (m) => staticFor(m.file).fileNative,
    'STATIC-FILE (test.js imports added)': (m) => staticFor(m.file).fileAug,
    'STATIC-SUITE': (m) => staticFor(m.file).suite,
    'LEARNED (LOO)': (m) => union(others(m)),
    'LEARNED-STRICT': (m) => union(others(m).filter((x) => x.site.fn !== m.site.fn)),
  };
  const table = {};
  for (const [k, fn] of Object.entries(preds)) table[k] = metrics(killed, fn);
  // LEARNED with no other killed mutant in the file selects nothing:
  table._noOtherKilled = killed.filter((m) => others(m).length === 0).length;
  table._noOtherKilledDiffFn = killed.filter((m) => others(m).filter((x) => x.site.fn !== m.site.fn).length === 0).length;
  // Learning curve on the population with >= 4 other killed mutants
  const pop = killed.filter((m) => others(m).length >= 4);
  const curve = { population: pop.length, files: new Set(pop.map((m) => m.file)).size, points: [] };
  for (const k of [1, 2, 4]) {
    let det = 0; let cost = 0; let rec = 0; let cnt = 0;
    for (let d = 0; d < 20; d++) {
      const rnd = prng(SEED + 1000 * k + d);
      for (const m of pop) {
        const pick = shuffle(others(m), rnd).slice(0, k);
        const sel = new Set(union(pick));
        const hit = m.fail.filter((s) => sel.has(s)).length;
        if (hit) det++;
        rec += hit / m.fail.length;
        cost += sel.size / NS;
        cnt++;
      }
    }
    curve.points.push({ k, detection: det / cnt, fullRecall: rec / cnt, cost: cost / cnt, draws: 20 });
  }
  const full = metrics(pop, (m) => union(others(m)));
  curve.points.push({ k: 'all others (LOO)', detection: full.detection, fullRecall: full.fullRecall, cost: full.cost, draws: 1 });
  const st = metrics(pop, (m) => staticFor(m.file).suite);
  curve.staticSuiteOnSamePop = { detection: st.detection, cost: st.cost };
  return { table, curve };
}

const broad = killedAll.filter((m) => m.fail.length > HALF);
const narrowKilled = killedAll.filter((m) => m.fail.length <= HALF);
const evalAll = evaluate(killedAll);
const evalNarrow = evaluate(narrowKilled);

function verdict(t) {
  const L = t['LEARNED (LOO)'];
  const S = t['STATIC-SUITE'];
  const reasons = [];
  let v;
  const killA = S.cost <= 1.5 * L.cost;
  const killB = L.detection < 0.80;
  if (killA) reasons.push(`STATIC-SUITE cost ${pct(S.cost)} is within 1.5x of LEARNED cost ${pct(L.cost)} (ratio ${(S.cost / L.cost).toFixed(2)})`);
  if (killB) reasons.push(`LEARNED detection ${pct(L.detection)} < 80%`);
  if (killA || killB) v = 'KILL';
  else if (L.detection >= 0.90 && L.cost <= 0.5 * S.cost) { v = 'PROMISING'; reasons.push(`LEARNED detection ${pct(L.detection)} >= 90% and cost ${pct(L.cost)} <= 50% of STATIC-SUITE cost ${pct(S.cost)}`); }
  else { v = 'INCONCLUSIVE'; reasons.push(`detection ${pct(L.detection)}, cost ratio LEARNED/STATIC-SUITE ${(L.cost / S.cost).toFixed(2)}`); }
  return { verdict: v, reasons };
}
function strictVerdict(t) {
  const L = t['LEARNED-STRICT'];
  const S = t['STATIC-SUITE'];
  if (S.cost <= 1.5 * L.cost || L.detection < 0.80) return 'KILL';
  if (L.detection >= 0.90 && L.cost <= 0.5 * S.cost) return 'PROMISING';
  return 'INCONCLUSIVE';
}

function pct(x) { return (100 * x).toFixed(1) + '%'; }

// Numb zones
const surv = R.filter((r) => r.outcome === 'survived');
const byFn = {}; const byFileSurv = {}; const byFileAll = {};
for (const r of R) { byFileAll[r.file] = (byFileAll[r.file] || 0) + 1; }
for (const r of surv) {
  const k = `${r.file} :: ${r.site.fn}`;
  byFn[k] = (byFn[k] || 0) + 1;
  byFileSurv[r.file] = (byFileSurv[r.file] || 0) + 1;
}
const topFns = Object.entries(byFn).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10);
const topFiles = Object.entries(byFileSurv).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10);
const allSurvFiles = Object.keys(byFileAll).filter((f) => byFileSurv[f] === byFileAll[f]).sort();
// files where test.js never loads them statically
const filesSampled = [...new Set(R.map((r) => r.file))].sort();
const notReachedByTestJs = filesSampled.filter((f) => !staticFor(f).testJsReaches);
const staticSuiteEmptyFiles = filesSampled.filter((f) => staticFor(f).suite.length === unattributed.length);

// |fail| distribution
const buckets = [[1, 1], [2, 2], [3, 3], [4, 5], [6, 10], [11, 20], [21, 44], [45, 88]];
const dist = buckets.map(([a, b]) => ({ range: a === b ? `${a}` : `${a}-${b}`, n: killedAll.filter((m) => m.fail.length >= a && m.fail.length <= b).length }));
const failSizes = killedAll.map((m) => m.fail.length).sort((a, b) => a - b);
const median = failSizes.length ? failSizes[Math.floor(failSizes.length / 2)] : 0;

// Pain map
const painMap = {};
for (const f of filesSampled) {
  const ms = R.filter((r) => r.file === f);
  const suites = {};
  for (const m of ms) if (m.outcome === 'killed') for (const s of m.fail) suites[s] = (suites[s] || 0) + 1;
  painMap[f] = {
    mutants: ms.length,
    outcomes: ms.reduce((o, m) => { o[m.outcome] = (o[m.outcome] || 0) + 1; return o; }, {}),
    painSuites: suites,
    numbFunctions: [...new Set(ms.filter((m) => m.outcome === 'survived').map((m) => m.site.fn))],
    staticSuiteSelected: staticFor(f).suite.length,
    cartoBlastRadius5: staticFor(f).blast5Size,
  };
}

const edges = edgeResolution();
const spot = [impactSpotCheck('src/store/path-utils.js'), impactSpotCheck('src/bitmap/bitset.js')];

const v = verdict(evalAll.table);
const vNarrow = verdict(evalNarrow.table);
const vStrict = strictVerdict(evalAll.table);
const vStrictNarrow = strictVerdict(evalNarrow.table);

const seqMs = baseline.sequential.map((r) => r.ms);
const baselineRuns = baseline.sequential.length + baseline.concurrent.flat().length;
const totalRuns = baselineRuns + 1 + R.length;
const mutantRunSec = R.reduce((a, r) => a + r.ms, 0) / 1000;

const summary = {
  verdict: v, verdictWithoutBroad: vNarrow, strictVerdict: vStrict, strictVerdictWithoutBroad: vStrictNarrow,
  suites: NS, tests: Object.values(baseline.stable).reduce((a, s) => a + s.pass, 0),
  droppedSuites: baseline.droppedOrUnstable, concurrencySafe: baseline.concurrencySafe,
  files: { src: raw.totalSrcFiles, eligible: raw.eligibleFiles, sampled: raw.sampledFiles },
  mutants: R.length,
  outcomes: { killed: count('killed'), survived: count('survived'), timeout: count('timeout'), crash: count('crash'), killedNoSuite: count('killed-nosuite') },
  broadKilled: broad.length,
  predictorsAll: evalAll.table, predictorsWithoutBroad: evalNarrow.table,
  learningCurveAll: evalAll.curve, learningCurveWithoutBroad: evalNarrow.curve,
  failSizeDistribution: dist, failSizeMedian: median,
  staticSuite: { suitesWithModules: NS - unattributed.length, unattributed, suitesNotFoundInSource: suitesNotInSource,
    nonInlineCallbacks: sm.nonInlineCallbacks, unresolvedSuiteNames: sm.unresolvedNames },
  staticFile: { testJsInCartoIndex: graph.files.includes('test/test.js'), testJsDirectDepsInGraph: testJsDeps.length,
    sampledFilesNotReachedByTestJs: notReachedByTestJs },
  graph: graph.stats, edgeResolution: edges, impactSpotCheck: spot,
  timing: { baselineSeqMs: seqMs, baselineConcurrentMaxMs: baseline.concurrentMaxMs, timeoutMs: raw.timeoutMs,
    mutationWallSec: raw.wallSec, mutationCpuSecSum: mutantRunSec, testRunsTotal: totalRuns, workers: raw.workers.length },
  safety: { drifts: raw.drifts, finalDiffs: raw.finalDiffs, sanity: { pass: sanity.pass, fail: sanity.result.fail, outcome: sanity.result.outcome } },
};
fs.writeFileSync(path.join(RESULTS, 'carto.json'), JSON.stringify({ summary, painMap }, null, 1));

// ── REPORT.md ─────────────────────────────────────────────────────────
const L = [];
const row = (name, m) => `| ${name} | ${m.n} | ${pct(m.detection)} (${m.detected}/${m.n}) | ${pct(m.fullRecall)} | ${pct(m.cost)} (${m.meanSelected.toFixed(1)}/${NS}) |`;
function tableMd(t) {
  const out = ['| Predictor | n | Detection | Full recall | Cost (mean suites selected) |', '|---|---|---|---|---|'];
  for (const [k, m] of Object.entries(t)) if (!k.startsWith('_')) out.push(row(k, m));
  out.push('', `Killed mutants with no other killed mutant in the same file (LEARNED selects nothing): ${t._noOtherKilled}. With none in a different function (LEARNED-STRICT selects nothing): ${t._noOtherKilledDiffFn}.`);
  return out.join('\n');
}
function curveMd(c) {
  const out = [`Population: killed mutants with >= 4 other killed mutants in their file (n = ${c.population} mutants in ${c.files} files); 20 seeded draws per k.`, '',
    '| Map built from k other killed mutants | Detection | Full recall | Cost |', '|---|---|---|---|'];
  for (const p of c.points) out.push(`| ${p.k} | ${pct(p.detection)} | ${pct(p.fullRecall)} | ${pct(p.cost)} |`);
  out.push(`| STATIC-SUITE (same population) | ${pct(c.staticSuiteOnSamePop.detection)} | - | ${pct(c.staticSuiteOnSamePop.cost)} |`);
  return out.join('\n');
}

L.push('# Pain map vs static blast radius: experiment report', '');
L.push(`Generated by \`bench/pain-map/analyze.js\`. Repository: Carto (this repo), test command \`node test/test.js\`, ${NS} suites / ${summary.tests} tests.`, '');
L.push('## Verdict (pre-registered rule)', '');
L.push('Rule, as given before data: *Compare LEARNED against STATIC-SUITE (the fair baseline). PROMISING if LEARNED detection >= 90% at cost <= 50% of STATIC-SUITE\'s cost. KILL if STATIC-SUITE\'s cost is already within 1.5x of LEARNED\'s, or LEARNED detection < 80%, or building the map is impractical at this repo size. Otherwise INCONCLUSIVE.*', '');
L.push(`**Verdict: ${v.verdict}** (all killed mutants, n = ${evalAll.table['LEARNED (LOO)'].n}). ${v.reasons.join('; ')}.`, '');
L.push(`- Without broad mutants (|fail| > ${HALF}): **${vNarrow.verdict}** (n = ${evalNarrow.table['LEARNED (LOO)'].n}). ${vNarrow.reasons.join('; ')}.`);
L.push(`- Harder test, LEARNED-STRICT under the same rule: **${vStrict}** (all), **${vStrictNarrow}** (without broad).`);
L.push(`- Practicality: ${R.length} mutant runs took ${(raw.wallSec / 60).toFixed(1)} min wall on 3 workers (4 CPUs); the map is practical to build at this repo size.`);
L.push('- Scope: one repository, one test file. The strongest possible outcome here is "promising on one repo", not proof.', '');

L.push('## Predictors (killed mutants only)', '');
L.push('Detection = share of killed mutants whose selection contains >= 1 suite in fail(m). Full recall = mean |selected ∩ fail(m)| / |fail(m)|. Cost = mean |selected| / ' + NS + '.', '');
L.push('### All killed mutants', '', tableMd(evalAll.table), '');
L.push(`### Without broad mutants (|fail(m)| > ${HALF} suites; ${broad.length} removed from both evaluation and map-building)`, '', tableMd(evalNarrow.table), '');

L.push('## Learning curve (LEARNED)', '', '### All killed', '', curveMd(evalAll.curve), '', '### Without broad mutants', '', curveMd(evalNarrow.curve), '');

L.push('## Mutation outcomes', '');
L.push(`- Source files under src/: ${raw.totalSrcFiles}; with >= 4 candidate sites: ${raw.eligibleFiles}; sampled: ${raw.sampledFiles} (all eligible; no sub-sampling was needed).`);
L.push(`- Mutants: ${R.length} (K = 6 per file; files with only 4-5 sites contribute all of them).`);
L.push(`- Killed: ${summary.outcomes.killed}; survived: ${summary.outcomes.survived}; timeout: ${summary.outcomes.timeout}; crash before any suite reported: ${summary.outcomes.crash}; exit != 0 with all suites green: ${summary.outcomes.killedNoSuite}.`);
L.push(`- Survival rate: ${pct(summary.outcomes.survived / R.length)} of all mutants (${summary.outcomes.survived}/${R.length}).`);
L.push(`- Broad killed mutants (fail > ${HALF} of ${NS} suites): ${broad.length} of ${killedAll.length}.`, '');
L.push('Distribution of |fail(m)| over killed mutants (median ' + median + '):', '', '| suites failed | killed mutants |', '|---|---|');
for (const d of dist) L.push(`| ${d.range} | ${d.n} |`);
L.push('');
const ops = {};
for (const r of R) { const o = (ops[r.site.op] = ops[r.site.op] || { n: 0, killed: 0, survived: 0 }); o.n++; if (r.outcome === 'killed') o.killed++; if (r.outcome === 'survived') o.survived++; }
L.push('By operator:', '', '| operator | mutants | killed | survived |', '|---|---|---|---|');
for (const [k, o] of Object.entries(ops).sort((a, b) => b[1].n - a[1].n)) L.push(`| \`${k}\` | ${o.n} | ${o.killed} | ${o.survived} |`);
L.push('');

L.push('## Numb zones (surviving mutants)', '');
L.push('Top 10 functions by surviving mutants:', '', '| file :: function | survived |', '|---|---|');
for (const [k, n] of topFns) L.push(`| \`${k}\` | ${n} |`);
L.push('', 'Top 10 files by surviving mutants:', '', '| file | survived / mutants |', '|---|---|');
for (const [k, n] of topFiles) L.push(`| \`${k}\`${byFileAll[k] === n ? ' **(all survived)**' : ''} | ${n}/${byFileAll[k]} |`);
L.push('', `Files where every mutant survived (${allSurvFiles.length} of ${filesSampled.length}): ${allSurvFiles.map((f) => '`' + f + '`').join(', ') || 'none'}.`, '');

L.push('## Static baselines: how they were built', '');
L.push(`- Carto import graph from a scratch-copy index built with \`runSync\` (src/store/sync.js): ${graph.stats.files} files, ${graph.stats.edges} import rows, ${graph.stats.resolvedEdges} resolved to an indexed file (${pct(graph.stats.resolvedEdges / graph.stats.edges)}). Unresolved rows: ${edges.unresolvedEdgeBreakdown.builtin} Node builtins, ${edges.unresolvedEdgeBreakdown.npmPackage} npm packages, ${edges.unresolvedEdgeBreakdown.other} other (${edges.unresolvedEdgeBreakdown.otherExamples.map((x) => '`' + x + '`').join(', ')}).`);
L.push(`- Independent check: a Babel scan of src/ finds ${edges.literalRelativeRequiresToIndexedFiles} literal relative \`require()\` edges to indexed files; ${edges.presentInCartoGraph} of them (${pct(edges.presentInCartoGraph / Math.max(1, edges.literalRelativeRequiresToIndexedFiles))}) are in Carto's graph.${edges.missing.length ? ' Missing: ' + edges.missing.slice(0, 10).map((x) => '`' + x + '`').join(', ') + (edges.missing.length > 10 ? ', ...' : '') : ''}`);
L.push(`- **STATIC-FILE (Carto native)**: test/test.js is not in Carto's index at all (\`IGNORE_DIRS\` in src/store/sync.js contains \`test\`), so Carto's blast radius never contains a test file and selects 0 suites for every file. Spot check with \`node src/cli/index.js impact <file>\` in the scratch copy: ${spot.map((s) => `\`${s.file}\`: CLI lists ${s.cliDependents} dependents, our reading of reverse_deps (<= 5 hops) ${s.ourBlast5}, identical = ${s.identical}, test files listed = ${s.cliTestFiles}`).join('; ')}.`);
L.push(`- **STATIC-FILE (test.js imports added)**: deviation to give the native idea a fair reading: test/test.js is added as a node whose edges are Carto's own \`extractImports\` output for it (${testJsDeps.length} indexed files); it then selects all ${NS} suites when F is in that closure (unbounded hops). Sampled files NOT in test/test.js's dependency closure: ${notReachedByTestJs.length} of ${filesSampled.length}${notReachedByTestJs.length ? ' (' + notReachedByTestJs.map((f) => '`' + f + '`').join(', ') + ')' : ''}.`);
L.push(`- **STATIC-SUITE**: Babel scan of test/test.js; scope-aware mapping of \`require()\` bindings (declarators incl. destructuring and \`require(..).x\`, plus \`x = require(..)\` assignments), and require calls inside the callback. Relative requires to any indexed file count (this includes \`../index.js\` and \`../bench/...\`, not only \`../src/...\`). Suite selected if a used module equals F or transitively (unbounded) depends on F in Carto's graph. Suites with no module attribution: ${unattributed.length} (${unattributed.map((s) => '`' + s + '`').join(', ')}), always selected. Callback references only; helper functions and setup code outside \`test()\` callbacks are not followed (as specified).`);
L.push(`- Carto's native blast radius is capped at 5 hops; unbounded closure differs from the 5-hop set for ${graph.files.filter((f) => closure(graph, f).size !== (graph.blast5.get(f) || new Set()).size).length} of ${graph.files.length} indexed files.`, '');

L.push('## Runtime', '');
L.push(`- Baseline: sequential ${seqMs.join(' ms, ')} ms; concurrent (3 copies) max ${baseline.concurrentMaxMs} ms. Timeout per mutant run: ${raw.timeoutMs} ms (3x concurrent baseline).`);
L.push(`- Mutation phase: ${(raw.wallSec / 60).toFixed(1)} min wall, ${raw.workers.length} workers, ${(mutantRunSec / 60).toFixed(1)} min summed run time.`);
L.push(`- Full test-suite runs: ${totalRuns} (${baselineRuns} baseline, 1 sanity, ${R.length} mutants), i.e. ${totalRuns * NS} suite executions.`, '');

L.push('## Sanity checks', '');
L.push(`- Baseline green twice sequentially and twice x 3 copies concurrently; all ${NS} suites stable and identical (dropped suites: ${baseline.droppedOrUnstable.length}). Concurrency safe: ${baseline.concurrencySafe}.`);
L.push(`- Hand-made mutant \`${sanity.file}\` L${sanity.site.line} \`${sanity.site.op}\` in \`${sanity.site.fn}\`: outcome ${sanity.result.outcome}, failing suites ${JSON.stringify(sanity.result.fail)}; expected \`Path normalization\`; worker copy restored (drift ${sanity.drift.length}). Pass: ${sanity.pass}.`);
L.push(`- Restoration: every mutated file restored in try/finally and verified by sha256; whole-tree drift checks after each run: ${raw.drifts.length} drift events; final worker-copy diffs vs repo: ${JSON.stringify(raw.finalDiffs)}.`, '');

L.push('## Isolation and deviations from the brief', '');
L.push('- Each test run executes in a private mount + network namespace (`unshare -m -n`): worker copy bind-mounted, fresh tmpfs on /tmp, HOME on that tmpfs, no network, `CARTO_NO_UPDATE_CHECK=1`. Reason: test/test.js hard-codes `/tmp/carto-test`, which two copies sharing /tmp would race on; this made parallel workers safe without editing the test file. HOME/network isolation keeps mutated init/provider code from touching the real home directory or the network. The baseline is green under this isolation.');
L.push('- A suite counts as failing if it is marked ✗ **or** passes fewer tests than at baseline (catches suites that silently register fewer tests). Decided before the mutation run.');
L.push('- Crashes (no suite line printed) and timeouts are excluded from prediction metrics, since fail(m) is unknown for them.');
L.push('- "Enclosing function" = nearest named enclosing function (`<anon:Lnn>` if only anonymous, `<top>` outside functions); LEARNED-STRICT uses this.');
L.push('- STATIC-FILE reported twice: Carto-native (literally 0 test files) and with test/test.js\'s imports added (see above).');
L.push('- STATIC-SUITE accepts relative requires to any indexed file, not only `../src/...`.');
L.push('- Learning curve evaluated on killed mutants with >= 4 other killed mutants in the file, so k = 1, 2, 4 share one population.');
L.push('- "Without broad mutants" removes them from both the evaluated set and the maps.', '');

L.push('## Known limitations', '');
L.push('- Held-out mutants in the same file are easier to predict than real agent edits: they are small, local, and share call paths with the mutants that built the map. Real edits add new code, change signatures and touch several files.');
L.push(`- Mutants that break module load or a shared fixture fail nearly everything: ${broad.length} of ${killedAll.length} killed mutants failed more than half of all suites. Headline metrics are given with and without them.`);
L.push('- One test file with many suites that share module-level fixtures; static suite attribution misses setup code outside callbacks and helper indirection.');
L.push('- Survived mutants include equivalent mutants (e.g. `true`->`false` on a value no code path observes); survival is an upper bound on true numbness.');
L.push('- One repository, one seed.', '');

{
  // Post-hoc, non-binding: LEARNED among killed mutants that have >= 1 other killed mutant in their file.
  const byF = {};
  for (const m of killedAll) (byF[m.file] = byF[m.file] || []).push(m);
  let n = 0; let d = 0;
  for (const m of killedAll) {
    const o = byF[m.file].filter((x) => x !== m);
    if (!o.length) continue;
    n++;
    const s = new Set(o.flatMap((x) => x.fail));
    if (m.fail.some((f) => s.has(f))) d++;
  }
  L.push('## Post-hoc observations (not part of the pre-registered verdict)', '');
  L.push(`- Of the ${killedAll.length - evalAll.table['LEARNED (LOO)'].detected} LEARNED misses, ${evalAll.table._noOtherKilled} are cold starts: the mutant is the only killed one in its file, so the map is empty. Conditional on >= 1 other killed mutant in the file, LEARNED detects ${d}/${n} (${pct(d / n)}). This conditioning was not pre-registered and does not change the verdict.`);
  L.push(`- Killed mutants occur in ${Object.keys(byF).length} of ${filesSampled.length} sampled files; ${allSurvFiles.length} files had every mutant survive, so a pain map is empty there too (no test feels them).`);
  L.push('- The analysis script was dry-run once on a partial result file (first 130 mutants) to check it ran; no operator, sample, predictor or threshold was changed afterwards.', '');
}

L.push('## Files', '', '- `bench/pain-map/mutate.js`, `run.js`, `static-map.js`, `analyze.js`', '- `bench/pain-map/results/baseline.json`, `sanity.json`, `raw-mutants.json`, `carto.json` (summary + measured pain map per file), `REPORT.md`');
fs.writeFileSync(path.join(RESULTS, 'REPORT.md'), L.join('\n') + '\n');
console.log(JSON.stringify({ verdict: v, vNarrow, vStrict, vStrictNarrow, outcomes: summary.outcomes, broad: broad.length }, null, 1));
for (const [k, m] of Object.entries(evalAll.table)) if (!k.startsWith('_')) console.log(row(k, m));
for (const [k, m] of Object.entries(evalNarrow.table)) if (!k.startsWith('_')) console.log('narrow', row(k, m));
