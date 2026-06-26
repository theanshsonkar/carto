#!/usr/bin/env node
'use strict';

/**
 * `carto diff [<base>] [<head>]` — architectural diff between two git
 * refs. Defaults to `HEAD~1` vs `HEAD`. Thin wrapper over the existing
 * `carto pr-impact` engine — same validation result, just framed for
 * the local workflow ("what changed in my last commit?") instead of
 * the GitHub Action one ("what changes did this PR introduce?").
 *
 * Examples:
 *   carto diff                       # HEAD~1 → HEAD
 *   carto diff main                  # main → HEAD
 *   carto diff main feat/auth        # main → feat/auth
 *   carto diff --format json
 *   carto diff --fail-on HIGH        # exit 2 if risk is HIGH
 */

const path = require('path');
const prImpact = require('./pr-impact');

function run({ argv, stdout, stderr, projectRoot } = {}) {
  argv = argv || process.argv.slice(3);
  stdout = stdout || process.stdout;
  stderr = stderr || process.stderr;
  projectRoot = projectRoot || process.cwd();

  const help = argv.includes('--help') || argv.includes('-h');
  if (help) {
    stdout.write(`
Usage: carto diff [<base>] [<head>] [--format markdown|json] [--fail-on HIGH|MEDIUM|LOW]

Architectural diff between two git refs. Defaults to HEAD~1 → HEAD.

Same engine as \`carto pr-impact\` — emits the same markdown/JSON
shape with risk badge, blast radius, cross-domain violations,
affected routes, files-without-tests, suggestions.

Examples:
  carto diff
  carto diff main
  carto diff main feat/auth --format json
  carto diff origin/main HEAD --fail-on HIGH
`);
    return 0;
  }

  // Pull base / head positional args. The rest are flags forwarded to
  // pr-impact.
  const positional = [];
  const flags = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags.push(a);
      // pr-impact options that take a value (--format, --fail-on, ...).
      if (['--format', '--fail-on', '--diff-file', '--project'].includes(a) && i + 1 < argv.length) {
        flags.push(argv[++i]);
      }
    } else {
      positional.push(a);
    }
  }

  let base = positional[0];
  let head = positional[1] || 'HEAD';
  if (!base) {
    // Default to "the last commit" — base is HEAD~1 vs head HEAD.
    base = 'HEAD~1';
  }

  const piArgv = [
    '--base', base,
    '--head', head,
    '--project', projectRoot,
    ...flags,
  ];

  return prImpact.run({ argv: piArgv, stdout, stderr });
}

module.exports = { run };
if (require.main === module) process.exit(run());
