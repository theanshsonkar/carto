#!/usr/bin/env node
'use strict';

/**
 * `carto pr-impact` — pull-request-shaped impact report.
 *
 * Computes the impact of a pull request's diff against the current
 * project graph and renders either:
 *   - Markdown wrapped in a `<!-- carto-impact-report -->` HTML marker
 *     so the GitHub Action can detect-and-update sticky comments.
 *   - JSON for programmatic consumers (CI dashboards, custom workflows).
 *
 * Composition:
 *   1. `git diff --unified=3 <base>...<head>` → unified diff text.
 *   2. `validateDiff(store, sidecar, diff)` → violations, blast radius,
 *      risk roll-up. (Same engine the MCP `validate_diff` tool uses.)
 *   3. Per-file `StoreAdapter.getBlastRadius(file)` → routes affected,
 *      domains impacted (validateDiff returns counts; the comment
 *      template wants the actual route list).
 *   4. Render.
 *
 * Exit code:
 *   - 0 by default (the comment surfaces the risk; failing the build
 *     is opt-in).
 *   - Non-zero when `--fail-on HIGH|MEDIUM` is supplied AND the rolled-up
 *     risk meets or exceeds the threshold.
 *
 * The command is read-only: it does not write to the SQLite store and
 * does not record episodic-memory rows — those persistence concerns
 * belong to the MCP `validate_diff` tool, not the CI surface.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SQLiteStore } = require('../store/sqlite-store');
const { StoreAdapter } = require('../store/store-adapter');
const { ensureBitmapFresh } = require('../bitmap/index');
const { validateDiff } = require('../mcp/validate');
const bitmapTools = require('../bitmap/tools');
const { filesWithoutTests } = require('../mcp/files-without-tests');

const MARKER = '<!-- carto-impact-report -->';

function parseArgs(argv) {
  const args = {
    base: null,
    head: 'HEAD',
    format: 'markdown',
    failOn: null,           // null | 'HIGH' | 'MEDIUM' | 'LOW'
    diffFile: null,         // for tests: read diff from a file instead of git
    projectRoot: process.cwd(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--base':       args.base = argv[++i]; break;
      case '--head':       args.head = argv[++i]; break;
      case '--format':     args.format = argv[++i]; break;
      case '--fail-on':    args.failOn = (argv[++i] || '').toUpperCase(); break;
      case '--diff-file':  args.diffFile = argv[++i]; break;
      case '--project':    args.projectRoot = path.resolve(argv[++i]); break;
      case '--help':
      case '-h':           args.help = true; break;
      default:
        // Unknown flag — fail loudly so typos in CI are visible.
        if (a.startsWith('--')) {
          throw new Error(`unknown flag: ${a}`);
        }
    }
  }
  if (!['markdown', 'json'].includes(args.format)) {
    throw new Error(`--format must be 'markdown' or 'json' (got '${args.format}')`);
  }
  if (args.failOn && !['HIGH', 'MEDIUM', 'LOW'].includes(args.failOn)) {
    throw new Error(`--fail-on must be HIGH | MEDIUM | LOW (got '${args.failOn}')`);
  }
  return args;
}

function printUsage() {
  process.stdout.write(`
Usage: carto pr-impact [options]

Computes the impact of a PR's diff against the current carto index and
renders a markdown or JSON report. Designed for the carto GitHub Action
but usable standalone.

Options:
  --base <ref>          Git ref the PR branched from (e.g. origin/main)
  --head <ref>          Git ref of the PR head (default: HEAD)
  --format <fmt>        markdown (default) | json
  --fail-on <severity>  Exit non-zero if risk >= severity (HIGH | MEDIUM | LOW)
  --diff-file <path>    Read diff text from a file instead of running git diff
                        (primarily for testing)
  --project <path>      Project root (default: cwd)
  --help, -h            Show this help

Exit codes:
  0  Normal — comment rendered.
  1  Misuse, missing index, or git failure.
  2  --fail-on threshold tripped.

`);
}

/**
 * runGitDiff(projectRoot, base, head) → diffText
 *
 * Captures the unified diff between two refs. Three-dot syntax (`base...head`)
 * matches what GitHub uses for PR diffs — only the changes introduced on
 * the head branch since it diverged from base, not changes that landed on
 * base in the meantime.
 */
function runGitDiff(projectRoot, base, head) {
  if (!base) {
    throw new Error('--base is required (or use --diff-file to supply a diff manually)');
  }
  let out;
  try {
    out = execFileSync('git', ['diff', '--unified=3', `${base}...${head}`], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024, // 64 MB — large PRs are rare but real
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    throw new Error(
      `git diff ${base}...${head} failed${stderr ? `: ${stderr}` : ''}`
    );
  }
  return out;
}

const RISK_BADGE = {
  HIGH:   '🔴 HIGH',
  MEDIUM: '🟡 MEDIUM',
  LOW:    '🟢 LOW',
  SAFE:   '✅ SAFE',
};

const RISK_RANK = { SAFE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

/**
 * collectImpact(projectRoot, diffText) → { result, perFile, domains, highImpact }
 *
 * - `result`     — full validateDiff(...) output (violations + blast
 *                  radius + risk).
 * - `perFile`    — Map<path, { blastRadius, routes, domains }> for files
 *                  in the diff. Skipped for files not in the index
 *                  (pure adds, renames where the new path didn't exist
 *                  at sync time).
 * - `domains`    — sorted Array<string> of all domains touched by the
 *                  changed files (used for the headline sentence).
 * - `highImpact` — { file, dependents } for the changed file with the
 *                  most direct dependents, or null if all are 0.
 */
function collectImpact(projectRoot, diffText) {
  const cartoDir = path.join(projectRoot, '.carto');
  const dbPath = path.join(cartoDir, 'carto.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `No carto index at ${dbPath}. Run \`carto init\` (or \`carto sync\` ` +
      `if the index already exists) before \`carto pr-impact\`.`
    );
  }

  const store = new SQLiteStore(projectRoot);
  store.open({ readonly: true });
  let sidecar = null;
  try {
    sidecar = ensureBitmapFresh(cartoDir, store);
  } catch (err) {
    process.stderr.write(
      `[CARTO] bitmap unavailable, validation will use SQLite-only path: ` +
      `${err.message || err}\n`
    );
  }

  const result = validateDiff(store, sidecar, diffText);

  // Per-file rich detail via StoreAdapter (matches what `carto impact <file>`
  // returns — routes, domain). We open a second adapter pointed at the same
  // DB rather than re-implementing the formatter here.
  const adapter = new StoreAdapter();
  // Skip the indexer — we know the DB exists. Open the store directly.
  adapter._store = store;
  adapter._projectRoot = projectRoot;

  const perFile = new Map();
  const domainSet = new Set();
  let highImpact = null;
  for (const f of result.diff) {
    if (f.kind === 'delete') continue;
    let br = null;
    try {
      br = adapter.getBlastRadius(f.path);
    } catch {
      // File not in index — most often a pure add. Leave perFile entry
      // off the map; renderer skips files it doesn't have detail for.
    }
    if (!br) continue;
    perFile.set(f.path, {
      blastRadius: br.dependentFiles.length,
      directlyAffected: br.directlyAffected.files,
      routes: br.routesImpacted,
      domains: br.domainsImpacted,
    });
    for (const d of br.domainsImpacted) domainSet.add(d);
    if (
      !highImpact ||
      br.directlyAffected.files > highImpact.dependents
    ) {
      highImpact = {
        file: f.path,
        dependents: br.directlyAffected.files,
      };
    }
  }

  store.close();

  // Files-without-tests metric.
  //
  // We compute it over the *union blast radius* (every changed file
  // plus every transitive dependent) — that's the set of files at risk
  // of regression. The detector is local-filesystem-walk only, so it
  // works on PRs touching files that aren't in the index yet.
  const seedPaths = result.diff
    .filter((f) => f.kind !== 'delete')
    .map((f) => f.path);
  let unionFiles = seedPaths.slice();
  if (sidecar && seedPaths.length > 0) {
    try {
      const sim = bitmapTools.simulateChangeImpact(sidecar, seedPaths);
      // sim.files is [{ file, hop_distance }]. Combine with seeds; dedupe via Set.
      const set = new Set(seedPaths);
      for (const row of sim.files || []) set.add(row.file);
      unionFiles = [...set];
    } catch {
      // Bitmap missing — fall through with seedPaths only.
    }
  }
  const filesWithoutTestsReport = filesWithoutTests(projectRoot, unionFiles);

  return {
    result,
    perFile,
    domains: [...domainSet].sort(),
    highImpact: highImpact && highImpact.dependents > 0 ? highImpact : null,
    filesWithoutTests: filesWithoutTestsReport,
  };
}

/**
 * renderMarkdown(impact) → string
 *
 * Renders the PR comment body. Wraps the entire body in a
 * `<!-- carto-impact-report -->` HTML comment marker so the GitHub
 * Action can find-and-update its previous comment instead of posting
 * a duplicate every commit.
 *
 * Sections:
 *   - Headline sentence ("This PR touches X and Y domains.")
 *   - Metric table (Risk · Blast radius · Files changed · Violations
 *     introduced · High-impact file)
 *   - Affected routes (collapsible) — only if any
 *   - Cross-domain violations (collapsible) — only if any
 *   - Suggestions (collapsible) — only if any
 */
function renderMarkdown(impact) {
  const { result, perFile, domains, highImpact, filesWithoutTests: fwt } = impact;
  const out = [];
  out.push(MARKER);
  out.push('## 🗺️ Carto Impact Report');
  out.push('');

  if (result.diff.length === 0) {
    out.push('_No file changes detected in this diff._');
    out.push('');
    return out.join('\n');
  }

  // Headline sentence.
  if (domains.length === 0) {
    out.push(`This PR touches **${result.diff.length} file(s)** in unmapped domains.`);
  } else if (domains.length === 1) {
    out.push(`This PR touches the **${domains[0]}** domain.`);
  } else if (domains.length === 2) {
    out.push(`This PR touches **${domains[0]}** and **${domains[1]}** domains.`);
  } else {
    const head = domains.slice(0, -1).map((d) => `**${d}**`).join(', ');
    const tail = `**${domains[domains.length - 1]}**`;
    out.push(`This PR touches ${head}, and ${tail} domains.`);
  }
  out.push('');

  // Metric table.
  const crossDomainCount = result.violations.filter(
    (v) => v.kind === 'cross_domain'
  ).length;
  out.push('| Metric | Value |');
  out.push('|--------|-------|');
  out.push(`| **Risk** | ${RISK_BADGE[result.risk] || result.risk} |`);
  out.push(`| Blast radius (union) | ${result.blast_radius.union} files |`);
  out.push(`| Files changed | ${result.diff.length} |`);
  out.push(`| Cross-domain violations introduced | ${crossDomainCount} |`);
  if (fwt && typeof fwt.count === 'number') {
    // Only render the row when the detector actually considered files
    // (skip when nothing testable was in the union — keeps the table
    // honest for non-source PRs).
    if (fwt.considered > 0) {
      out.push(`| Files without tests in blast radius | ${fwt.count} of ${fwt.considered} |`);
    }
  }
  if (highImpact) {
    out.push(
      `| High-impact file changed | \`${highImpact.file}\` (${highImpact.dependents} direct dependents) |`
    );
  }
  out.push('');

  // Routes section — flatten per-file routes, dedupe by method+path.
  const routeRows = [];
  const seenRoutes = new Set();
  for (const detail of perFile.values()) {
    for (const r of detail.routes || []) {
      const key = `${r.method} ${r.path}`;
      if (seenRoutes.has(key)) continue;
      seenRoutes.add(key);
      routeRows.push(r);
    }
  }
  if (routeRows.length > 0) {
    out.push(`<details>`);
    out.push(`<summary>Affected routes (${routeRows.length})</summary>`);
    out.push('');
    for (const r of routeRows) {
      out.push(`- \`${r.method} ${r.path}\` — risk: ${r.risk}`);
    }
    out.push('');
    out.push(`</details>`);
    out.push('');
  }

  // Cross-domain violations.
  const crossViolations = result.violations.filter(
    (v) => v.kind === 'cross_domain'
  );
  if (crossViolations.length > 0) {
    out.push(`<details>`);
    out.push(
      `<summary>Cross-domain violations (${crossViolations.length})</summary>`
    );
    out.push('');
    for (const v of crossViolations) {
      out.push(
        `- \`${v.file}\` now imports from \`${v.toFile}\` (${v.fromDomain}→${v.toDomain})`
      );
    }
    out.push('');
    out.push(`</details>`);
    out.push('');
  }

  // High-blast violations as a separate section so reviewers see them
  // even when no cross-domain edges exist.
  const blastViolations = result.violations.filter(
    (v) => v.kind === 'high_blast'
  );
  if (blastViolations.length > 0) {
    out.push(`<details>`);
    out.push(
      `<summary>High-blast files modified (${blastViolations.length})</summary>`
    );
    out.push('');
    for (const v of blastViolations) {
      out.push(`- \`${v.file}\` — ${v.blast_radius} dependents (${v.severity})`);
    }
    out.push('');
    out.push(`</details>`);
    out.push('');
  }

  // Suggestions.
  if (result.suggestions.length > 0) {
    out.push(`<details>`);
    out.push(`<summary>Suggestions (${result.suggestions.length})</summary>`);
    out.push('');
    for (const s of result.suggestions) {
      out.push(`- ${s.message}`);
    }
    out.push('');
    out.push(`</details>`);
    out.push('');
  }

  // Files without tests in blast radius — collapsible list.
  // Show up to 10 names; the metric row already shows the total.
  if (fwt && fwt.count > 0) {
    out.push(`<details>`);
    out.push(`<summary>Files without tests in blast radius (${fwt.count})</summary>`);
    out.push('');
    const shown = fwt.files.slice(0, 10);
    for (const file of shown) {
      out.push(`- \`${file}\``);
    }
    if (fwt.files.length > shown.length) {
      out.push(`- _… and ${fwt.files.length - shown.length} more_`);
    }
    out.push('');
    out.push(`</details>`);
    out.push('');
  }

  out.push(`<sub>Generated by [carto-md](https://www.npmjs.com/package/carto-md).</sub>`);
  return out.join('\n');
}

/**
 * renderJson(impact) → object
 *
 * Stable contract for programmatic consumers. Locked-in shape (any
 * additions go at the end of the object, no key removals before a
 * major version bump):
 *
 *   {
 *     marker:                 string,
 *     risk:                   'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH',
 *     files_changed:          number,
 *     blast_radius_union:     number,
 *     domains_touched:        string[],
 *     high_impact_file:       { file, dependents } | null,
 *     violations:             [{ kind, severity, file, message, ... }],
 *     suggestions:            [{ kind, file, message, ... }],
 *     per_file: {
 *       [path]: {
 *         blast_radius:        number,
 *         directly_affected:   number,
 *         domains:             string[],
 *         routes:              [{ method, path, risk }],
 *       }
 *     }
 *   }
 */
function renderJson(impact) {
  const { result, perFile, domains, highImpact, filesWithoutTests: fwt } = impact;
  const per_file = {};
  for (const [path_, detail] of perFile) {
    per_file[path_] = {
      blast_radius: detail.blastRadius,
      directly_affected: detail.directlyAffected,
      domains: detail.domains,
      routes: detail.routes,
    };
  }
  return {
    marker: MARKER,
    risk: result.risk,
    files_changed: result.diff.length,
    blast_radius_union: result.blast_radius.union,
    domains_touched: domains,
    high_impact_file: highImpact,
    violations: result.violations,
    suggestions: result.suggestions,
    per_file,
    // Files-without-tests metric. Always present so the JSON shape is
    // stable; values are null/0 when not computable.
    files_without_tests: fwt
      ? { count: fwt.count, considered: fwt.considered, files: fwt.files }
      : { count: 0, considered: 0, files: [] },
  };
}

/**
 * Decide exit code based on --fail-on threshold.
 *   - failOn null → always 0
 *   - failOn set  → 2 if risk >= threshold, else 0
 */
function decideExitCode(risk, failOn) {
  if (!failOn) return 0;
  return RISK_RANK[risk] >= RISK_RANK[failOn] ? 2 : 0;
}

/**
 * run({ argv, stdout, stderr }) → exitCode
 *
 * Pure function — no side effects on `process`. Tests pass an in-memory
 * argv + capture stdout via a writable stream.
 */
function run({ argv, stdout, stderr } = {}) {
  argv = argv || process.argv.slice(3);
  stdout = stdout || process.stdout;
  stderr = stderr || process.stderr;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`[CARTO] ${err.message}\n`);
    return 1;
  }

  if (args.help) {
    printUsage();
    return 0;
  }

  let diffText;
  try {
    if (args.diffFile) {
      diffText = fs.readFileSync(args.diffFile, 'utf8');
    } else {
      diffText = runGitDiff(args.projectRoot, args.base, args.head);
    }
  } catch (err) {
    stderr.write(`[CARTO] ${err.message}\n`);
    return 1;
  }

  let impact;
  try {
    impact = collectImpact(args.projectRoot, diffText);
  } catch (err) {
    stderr.write(`[CARTO] ${err.message}\n`);
    return 1;
  }

  if (args.format === 'json') {
    stdout.write(JSON.stringify(renderJson(impact), null, 2) + '\n');
  } else {
    stdout.write(renderMarkdown(impact) + '\n');
  }

  return decideExitCode(impact.result.risk, args.failOn);
}

module.exports = {
  run,
  // Exported for tests:
  parseArgs,
  collectImpact,
  renderMarkdown,
  renderJson,
  decideExitCode,
  MARKER,
};

// CLI entry — when invoked directly (not required for tests):
if (require.main === module) {
  process.exit(run());
}
