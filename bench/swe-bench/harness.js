#!/usr/bin/env node
'use strict';

/**
 * harness.js — Per-task SWE-bench runner.
 *
 * Usage (via run.sh; argv parsing is mirrored here so the script
 * can also be invoked directly):
 *
 *   node bench/swe-bench/harness.js --task-set sample --arm both [--out <dir>] [--limit N]
 *
 * Flow:
 *
 *   1. Load tasks (mini-suite or external JSONL — verified TBD).
 *   2. For each arm × each task:
 *        a. Materialize task.repo into a tmp directory (scratch).
 *        b. Instantiate agent via getAgent(arm, {taskSet}).
 *        c. agent.solve(task, scratchDir) → { diff, elapsedMs, ... }.
 *        d. score(diff, task.expected) → outcome + coverage.
 *        e. Append one row to <out>/<run-id>.jsonl.
 *   3. After both arms finish, call aggregate() and write REPORT.md.
 *
 * No I/O parallelism — tasks are short and JSONL row ordering is
 * easier to read when serial.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { TASKS: MINI_TASKS } = require('./mini-suite');
const { getAgent } = require('./agent');
const { scoreDiff } = require('./score');
const { aggregate } = require('./aggregate');

function parseArgs(argv) {
  const args = {
    taskSet: 'sample',
    arm: 'both',         // 'control' | 'carto' | 'both'
    outDir: path.join(__dirname, 'results'),
    limit: Infinity,
    runId: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--task-set': args.taskSet = argv[++i]; break;
      case '--arm':      args.arm = argv[++i]; break;
      case '--out':      args.outDir = path.resolve(argv[++i]); break;
      case '--limit':    args.limit = parseInt(argv[++i], 10); break;
      case '--run-id':   args.runId = argv[++i]; break;
      case '--help':
      case '-h':         args.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!['sample', 'verified'].includes(args.taskSet)) {
    throw new Error(`--task-set must be 'sample' or 'verified' (got '${args.taskSet}')`);
  }
  if (!['control', 'carto', 'both'].includes(args.arm)) {
    throw new Error(`--arm must be 'control' | 'carto' | 'both' (got '${args.arm}')`);
  }
  return args;
}

function printUsage() {
  process.stdout.write(`
Usage: harness.js [options]

Options:
  --task-set <s>   sample | verified              (default sample)
  --arm <s>        control | carto | both         (default both)
  --out <dir>      results directory               (default bench/swe-bench/results)
  --limit <n>      max tasks (sample only)
  --run-id <s>     override run id (default = timestamp)
  --help, -h       show this help

`);
}

function loadTasks(taskSet, opts = {}) {
  if (taskSet === 'sample') return MINI_TASKS;
  if (taskSet === 'verified') {
    // Verified tasks come from a local SWE-bench-Verified JSONL —
    // load-verified.js owns the path resolution + parsing + error
    // messaging.
    const { loadVerified } = require('./load-verified');
    return loadVerified({ limit: opts.limit });
  }
  throw new Error(`unknown task set: ${taskSet}`);
}

function materializeRepo(task, scratchDir) {
  for (const [rel, content] of Object.entries(task.repo || {})) {
    const abs = path.join(scratchDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/**
 * runOneTask(task, arm, opts) → resultRow
 *
 * Pure-ish: materializes repo into a fresh tmp dir, runs the agent,
 * scores the diff, returns the row. Always cleans up scratchDir.
 */
async function runOneTask(task, arm, opts) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), `carto-swe-${task.id}-${arm}-`));
  try {
    materializeRepo(task, scratchDir);
    const agent = getAgent(arm, { taskSet: opts.taskSet, stub: opts.stub });
    const t0 = Date.now();
    const out = await agent.solve(task, scratchDir);
    const elapsedMs = out.elapsedMs ?? (Date.now() - t0);
    const score = scoreDiff(out.diff || '', task.expected);
    return {
      runId: opts.runId,
      taskId: task.id,
      kind: task.kind,
      arm,
      model: out.model || 'unknown',
      outcome: score.outcome,
      coverage: score.coverage,
      elapsedMs,
      toolCalls: out.toolCalls || 0,
      tokensUsed: out.tokensUsed || 0,
      filesTouched: score.filesTouched,
      missingFiles: score.missingFiles,
      missingAdded: score.missingAdded,
      missingRemoved: score.missingRemoved,
    };
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

/**
 * run({ argv, stdout, stderr }) → exitCode
 *
 * The main harness entry point. Returns 0 on success, 1 on a fatal
 * error (e.g. unknown task set, bad flag).
 */
async function run({ argv, stdout, stderr } = {}) {
  argv = argv || process.argv.slice(2);
  stdout = stdout || process.stdout;
  stderr = stderr || process.stderr;

  let args;
  try { args = parseArgs(argv); }
  catch (err) { stderr.write(`[harness] ${err.message}\n`); return 1; }

  if (args.help) { printUsage(); return 0; }

  let tasks;
  try { tasks = loadTasks(args.taskSet, { limit: args.limit }); }
  catch (err) { stderr.write(`[harness] ${err.message}\n`); return 1; }
  if (Number.isFinite(args.limit)) tasks = tasks.slice(0, args.limit);

  const runId = args.runId || isoStamp();
  fs.mkdirSync(args.outDir, { recursive: true });
  const jsonlPath = path.join(args.outDir, `${runId}.jsonl`);
  const append = (row) => fs.appendFileSync(jsonlPath, JSON.stringify(row) + '\n');

  const arms = args.arm === 'both' ? ['control', 'carto'] : [args.arm];

  stdout.write(`[harness] run=${runId} task-set=${args.taskSet} arms=${arms.join(',')} tasks=${tasks.length}\n`);

  const rows = [];
  for (const arm of arms) {
    for (const task of tasks) {
      try {
        const row = await runOneTask(task, arm, { runId, taskSet: args.taskSet });
        rows.push(row);
        append(row);
        stdout.write(
          `  ${arm.padEnd(8)} ${task.id.padEnd(10)} ${row.outcome.padEnd(8)} ` +
          `cov=${(row.coverage * 100).toFixed(0).padStart(3)}% ` +
          `${row.elapsedMs}ms\n`,
        );
      } catch (err) {
        const row = {
          runId, taskId: task.id, kind: task.kind, arm, model: 'error',
          outcome: 'FAIL', coverage: 0, elapsedMs: 0,
          error: err && err.message ? err.message : String(err),
        };
        rows.push(row);
        append(row);
        stderr.write(`  ${arm.padEnd(8)} ${task.id.padEnd(10)} FAIL — ${row.error}\n`);
      }
    }
  }

  // Aggregate when we have at least one row from both arms.
  const kindLookup = new Map(tasks.map((t) => [t.id, t.kind]));
  const agg = aggregate(rows, kindLookup);
  const reportPath = path.join(args.outDir, `${runId}.REPORT.md`);
  fs.writeFileSync(reportPath, agg.markdown);
  stdout.write(`\n[harness] wrote results ${jsonlPath}\n`);
  stdout.write(`[harness] wrote report  ${reportPath}\n\n`);
  stdout.write(agg.markdown);
  stdout.write('\n');
  return 0;
}

function isoStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    'mini-' +
    d.getUTCFullYear() + '-' +
    pad(d.getUTCMonth() + 1) + '-' +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + '-' +
    pad(d.getUTCMinutes()) + '-' +
    pad(d.getUTCSeconds()) + 'Z'
  );
}

module.exports = { run, parseArgs, runOneTask, loadTasks };

if (require.main === module) {
  run().then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[harness] fatal: ${err.message}\n`);
      process.exit(1);
    });
}
