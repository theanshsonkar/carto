'use strict';

/**
 * aggregate.js — Walk per-task scored results, compute pass-rate per arm
 * + per-kind split, run a paired bootstrap to get a 95% confidence
 * interval on the delta, and emit a markdown report.
 *
 * Input: JSONL where each line is one task×arm result row:
 *   {
 *     runId, taskId, arm: 'control'|'carto', model,
 *     outcome: 'PASS'|'PARTIAL'|'FAIL', coverage: number,
 *     filesTouched: [...], missingFiles: [...], elapsedMs, ...
 *   }
 *
 * Output:
 *   - markdown report (string) for stdout
 *   - JSON summary object (returned) for programmatic consumers
 *
 * Statistics:
 *
 *   We treat PASS as 1.0, PARTIAL as 0.5, FAIL as 0.0. The arm's
 *   "score" on a task is its outcome value. The delta is
 *   mean(carto_scores) − mean(control_scores). The 95% CI is the
 *   2.5th and 97.5th percentile of 1000 paired-bootstrap resamples
 *   of (control, carto) score pairs.
 *
 *   Paired (not unpaired) because the two arms run the *same* tasks
 *   — pairing reduces variance by removing task-difficulty noise from
 *   the delta. Same task harder than expected? Both arms drop. Pair
 *   subtracts that out.
 *
 *   Seed is fixed to make CI reproducible.
 */

const OUTCOME_TO_SCORE = { PASS: 1.0, PARTIAL: 0.5, FAIL: 0.0 };
const BOOTSTRAP_N = 1000;
const SEED = 0x1234abcd;

/** Mulberry32 — small fast deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * pairedBootstrapCI(controlScores, cartoScores, n, rng) → { lo, hi, mean }
 *
 * Returns the 2.5/97.5 percentile of (carto − control) across `n`
 * paired resamples. Input arrays must be the same length and aligned
 * task-by-task. Percentiles returned as percentage points (× 100).
 */
function pairedBootstrapCI(controlScores, cartoScores, n, rng) {
  const N = controlScores.length;
  if (N === 0) return { lo: 0, hi: 0, mean: 0 };
  const deltas = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < N; j++) {
      const idx = Math.floor(rng() * N);
      sum += cartoScores[idx] - controlScores[idx];
    }
    deltas[i] = sum / N;
  }
  const sorted = Array.from(deltas).sort((a, b) => a - b);
  const loIdx = Math.max(0, Math.floor(0.025 * n));
  const hiIdx = Math.min(n - 1, Math.floor(0.975 * n));
  const meanDelta =
    cartoScores.reduce((s, v, i) => s + (v - controlScores[i]), 0) / N;
  return {
    lo: Number((sorted[loIdx] * 100).toFixed(1)),
    hi: Number((sorted[hiIdx] * 100).toFixed(1)),
    mean: Number((meanDelta * 100).toFixed(1)),
  };
}

/**
 * splitByArm(rows) → { control: rows[], carto: rows[] }
 *
 * Each row must have an `arm` field. Rows with arms we don't recognize
 * are dropped (warning emitted by the caller).
 */
function splitByArm(rows) {
  const control = [], carto = [];
  for (const r of rows) {
    if (r.arm === 'control') control.push(r);
    else if (r.arm === 'carto') carto.push(r);
  }
  return { control, carto };
}

/**
 * alignByTask(controlRows, cartoRows) → { tasks: string[],
 *                                          controlScores: number[],
 *                                          cartoScores: number[] }
 *
 * Tasks present in *both* arms only. A task missing from either arm
 * is excluded — there's no honest way to score an unrun pair.
 */
function alignByTask(controlRows, cartoRows) {
  const controlByTask = new Map(controlRows.map((r) => [r.taskId, r]));
  const cartoByTask = new Map(cartoRows.map((r) => [r.taskId, r]));
  const tasks = [...controlByTask.keys()].filter((t) => cartoByTask.has(t)).sort();
  return {
    tasks,
    controlScores: tasks.map((t) => OUTCOME_TO_SCORE[controlByTask.get(t).outcome] ?? 0),
    cartoScores: tasks.map((t) => OUTCOME_TO_SCORE[cartoByTask.get(t).outcome] ?? 0),
    controlByTask,
    cartoByTask,
  };
}

/**
 * passRate(scores) → number (0..1)
 *   PASS counts as 1, PARTIAL as 0.5, FAIL as 0. So pass-rate is the
 *   mean score — same as a fractional outcome.
 */
function passRate(scores) {
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * aggregate(rows, taskKindLookup) → { summary, markdown }
 *
 *   - rows               : array of scored result rows
 *   - taskKindLookup     : Map<taskId, 'single_file'|'multi_file'|'architectural'>
 */
function aggregate(rows, taskKindLookup) {
  const rng = mulberry32(SEED);
  const { control, carto } = splitByArm(rows);
  const aligned = alignByTask(control, carto);

  // Per-kind splits — same alignment, filtered by task kind.
  const kinds = ['single_file', 'multi_file', 'architectural', 'all'];
  const perKind = {};
  for (const kind of kinds) {
    const idxs = aligned.tasks.map((t, i) => ({ t, i })).filter(({ t }) =>
      kind === 'all' || (taskKindLookup.get(t) === kind),
    );
    if (idxs.length === 0) {
      perKind[kind] = { n: 0, control: 0, carto: 0, delta: 0, lo: 0, hi: 0 };
      continue;
    }
    const cScores = idxs.map(({ i }) => aligned.controlScores[i]);
    const kScores = idxs.map(({ i }) => aligned.cartoScores[i]);
    const ctrl = passRate(cScores);
    const cart = passRate(kScores);
    const ci = pairedBootstrapCI(cScores, kScores, BOOTSTRAP_N, rng);
    perKind[kind] = {
      n: idxs.length,
      control: Number((ctrl * 100).toFixed(1)),
      carto: Number((cart * 100).toFixed(1)),
      delta: Number(((cart - ctrl) * 100).toFixed(1)),
      lo: ci.lo,
      hi: ci.hi,
    };
  }

  // Pull a model+runId hint from the rows.
  const model = rows.find((r) => r.model) ? rows.find((r) => r.model).model : 'unknown';
  const runId = rows.find((r) => r.runId) ? rows.find((r) => r.runId).runId : 'adhoc';

  const summary = {
    runId,
    model,
    taskCount: aligned.tasks.length,
    perKind,
  };

  const md = renderMarkdown(summary);
  return { summary, markdown: md };
}

function renderMarkdown(summary) {
  const { runId, model, taskCount, perKind } = summary;
  const row = (label, k) => {
    const p = perKind[k];
    if (!p || p.n === 0) return `| ${label} | _no data_ | _no data_ | _no data_ | _no data_ |`;
    const bold = Math.abs(p.delta) >= 10 ? '**' : '';
    return `| ${label} (n=${p.n}) | ${p.control.toFixed(1)}% | ${p.carto.toFixed(1)}% | ${bold}${p.delta > 0 ? '+' : ''}${p.delta.toFixed(1)}pp${bold} | [${p.lo > 0 ? '+' : ''}${p.lo.toFixed(1)}, ${p.hi > 0 ? '+' : ''}${p.hi.toFixed(1)}] |`;
  };

  return [
    `# Carto · SWE-bench results`,
    ``,
    `Run id: \`${runId}\``,
    `Model:  ${model}`,
    `Tasks:  ${taskCount}`,
    ``,
    `| Metric | control | carto | delta | 95% CI |`,
    `|--------|--------:|------:|------:|-------:|`,
    row('Pass rate (all)',           'all'),
    row('Pass rate (single-file)',   'single_file'),
    row('Pass rate (multi-file)',    'multi_file'),
    row('Pass rate (architectural)', 'architectural'),
    ``,
    `_Pass = 1.0, Partial = 0.5, Fail = 0.0. CI = paired bootstrap, n=${BOOTSTRAP_N} resamples, seed pinned for reproducibility._`,
    ``,
  ].join('\n');
}

module.exports = {
  aggregate,
  pairedBootstrapCI,
  passRate,
  OUTCOME_TO_SCORE,
  BOOTSTRAP_N,
  SEED,
};
