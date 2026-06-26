#!/usr/bin/env node
'use strict';

/**
 * `carto validate` — diff-shaped validation CLI.
 *
 * Reads a unified diff from stdin (or `--diff-file <path>`) and prints
 * the JSON result of `validateDiff()` to stdout. Designed for IDE
 * extensions and middleware proxies that already speak diffs but don't
 * want to import Carto internals.
 *
 * Contract:
 *
 *   Input  — unified diff text on stdin.
 *   Output — single JSON object on stdout (per `validateDiff()` shape).
 *   Exit   — 0 on success regardless of risk, 1 on error (no index, bad
 *            input, etc.), 2 when `--fail-on <severity>` trips.
 *
 * Read-only: opens the SQLite store with readonly=true and never
 * records side-effects to the episodic-memory tables. That persistence
 * is owned by the MCP `validate_diff` tool — the IDE/middleware paths
 * are inherently read-only consumers.
 */

const fs = require('fs');
const path = require('path');
const { SQLiteStore } = require('../store/sqlite-store');
const { ensureBitmapFresh } = require('../bitmap/index');
const { validateDiff } = require('../mcp/validate');

const RISK_RANK = { SAFE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

function parseArgs(argv) {
  const args = {
    diffFile: null,
    projectRoot: process.cwd(),
    failOn: null,
    pretty: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--diff-file':  args.diffFile = argv[++i]; break;
      case '--project':    args.projectRoot = path.resolve(argv[++i]); break;
      case '--fail-on':    args.failOn = (argv[++i] || '').toUpperCase(); break;
      case '--pretty':     args.pretty = true; break;
      case '--help':
      case '-h':           args.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    }
  }
  if (args.failOn && !['HIGH', 'MEDIUM', 'LOW'].includes(args.failOn)) {
    throw new Error(`--fail-on must be HIGH | MEDIUM | LOW (got '${args.failOn}')`);
  }
  return args;
}

function printUsage(stream) {
  (stream || process.stdout).write(`
Usage: carto validate [options]

Reads a unified diff from stdin (or --diff-file) and prints the
validateDiff() JSON result to stdout. Used by carto's MCP middleware,
the VS Code extension, and any custom IDE integration.

Options:
  --diff-file <path>    Read diff from a file instead of stdin
  --project <path>      Project root (default: cwd)
  --fail-on <severity>  Exit 2 if risk >= severity (HIGH | MEDIUM | LOW)
  --pretty              Pretty-print the JSON output (default: compact)
  --help, -h            Show this help

Exit codes:
  0  Normal — JSON written to stdout.
  1  Misuse, missing index, or read error.
  2  --fail-on threshold tripped.

JSON shape:
  { diff, blast_radius, violations, suggestions, risk }
  See src/mcp/validate.js for full field documentation.

`);
}

/**
 * readStdin() → Promise<string>
 *
 * Collect stdin until EOF. Done as a one-shot because validate is a
 * batch operation — IDEs / middleware build a complete diff before
 * shelling out, they don't stream.
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * computeValidation(projectRoot, diffText) → result
 *
 * Pure function over a project root + diff. Opens the SQLite store
 * read-only, builds (or reuses) the bitmap sidecar, runs validateDiff,
 * closes the store, returns.
 *
 * If the bitmap can't be built (no index, schema mismatch, etc.), we
 * fall through with sidecar=null — validateDiff degrades gracefully to
 * no-blast-radius output rather than crashing.
 */
function computeValidation(projectRoot, diffText) {
  const cartoDir = path.join(projectRoot, '.carto');
  const dbPath = path.join(cartoDir, 'carto.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `No carto index at ${dbPath}. Run \`carto init\` first.`
    );
  }
  const store = new SQLiteStore(projectRoot);
  store.open({ readonly: true });
  let sidecar = null;
  try {
    sidecar = ensureBitmapFresh(cartoDir, store);
  } catch {
    // No bitmap → no blast radius, but the diff parser + cross-domain
    // rules still produce useful output.
  }
  try {
    return validateDiff(store, sidecar, diffText);
  } finally {
    store.close();
  }
}

/**
 * run({ argv, stdout, stderr, stdin }) → Promise<exitCode>
 *
 * Pure-ish entry point so tests can pass synthetic streams + capture
 * stdout. Caller decides whether to `process.exit(code)`.
 */
async function run({ argv, stdout, stderr, stdin } = {}) {
  argv = argv || process.argv.slice(3);
  stdout = stdout || process.stdout;
  stderr = stderr || process.stderr;

  let args;
  try { args = parseArgs(argv); }
  catch (err) { stderr.write(`[CARTO] ${err.message}\n`); return 1; }

  if (args.help) { printUsage(stdout); return 0; }

  let diffText;
  try {
    if (args.diffFile) {
      diffText = fs.readFileSync(args.diffFile, 'utf8');
    } else if (stdin && typeof stdin.read === 'function' && stdin.isString) {
      // Test path: caller passed a synthetic stdin shim with a string.
      diffText = stdin.read();
    } else {
      diffText = await readStdin();
    }
  } catch (err) {
    stderr.write(`[CARTO] failed to read diff: ${err.message}\n`);
    return 1;
  }

  let result;
  try {
    result = computeValidation(args.projectRoot, diffText);
  } catch (err) {
    stderr.write(`[CARTO] ${err.message}\n`);
    return 1;
  }

  const out = args.pretty
    ? JSON.stringify(result, null, 2) + '\n'
    : JSON.stringify(result) + '\n';
  stdout.write(out);

  if (args.failOn && RISK_RANK[result.risk] >= RISK_RANK[args.failOn]) return 2;
  return 0;
}

module.exports = {
  run,
  parseArgs,
  computeValidation,
  RISK_RANK,
};

if (require.main === module) {
  run().then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[CARTO] Fatal: ${err.message}\n`);
      process.exit(1);
    });
}
