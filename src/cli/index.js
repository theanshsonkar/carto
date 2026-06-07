#!/usr/bin/env node

const pkg = require('../../package.json');
const command = process.argv[2];

function printUsage() {
  console.log(`
Usage: carto <command>

Commands:
  init          Detect project, write .carto/config.json, run first sync.
                Installs git hooks (pre-commit, post-checkout, post-merge,
                post-rewrite) so the index stays fresh on every git event.
  sync          Read .carto/config.json, run one sync, exit
  watch         (Optional) Start file watcher for sub-second freshness.
                Not required — git hooks + lazy MCP re-parse keep the
                index fresh by default. Use only for AI-heavy workflows.
  impact <file> Show which files and routes are affected by changing a file
  check         Report cross-domain deps, high-risk uncommitted changes, domain health
  inspect       Read-only diagnostic: prints index paths, sizes, freshness,
                bitmap sidecar shape, top-impact files, schema version,
                sync timestamps, extraction errors. Use --json for piping.
  anci          ANCI v0.1 DRAFT export. Subcommands: publish, show,
                validate. Writes/reads .carto/anci.{yaml,bin} — the
                public, tool-neutral architecture description spec.
  remove        Remove AGENTS.md and .carto/ from this project
  serve         Start MCP server for AI tool integration
  agent         Start ACP agent mode (for Zed, JetBrains, VS Code)

Options:
  --help, -h   Show this help message
`);
}

if (command === '--version' || command === '-v') {
  console.log(`${pkg.name} ${pkg.version}`);
  process.exit(0);
}

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

if (command === 'init') {
  require('./init').run(process.cwd()).catch(err => {
    console.error(`[CARTO] Fatal error: ${err.message}`);
    process.exit(1);
  });
} else if (command === 'watch') {
  require('./watch').run(process.cwd()).catch(err => {
    console.error(`[CARTO] Fatal error: ${err.message}`);
    process.exit(1);
  });
} else if (command === 'sync') {
  require('./sync').run(process.cwd()).catch(err => {
    console.error(`[CARTO] Fatal error: ${err.message}`);
    process.exit(1);
  });
} else if (command === 'impact') {
  const fileArg = process.argv[3];
  require('./impact').run(process.cwd(), fileArg);
} else if (command === 'check') {
  require('./check').run(process.cwd()).catch(err => {
    console.error(`[CARTO] Fatal error: ${err.message}`);
    process.exit(1);
  });
} else if (command === 'inspect') {
  // Read-only diagnostic — no async, no rebuild. Pass --json through.
  const json = process.argv.slice(3).includes('--json');
  const code = require('./inspect').run(process.cwd(), { json });
  process.exit(code);
} else if (command === 'anci') {
  // anci has its own subcommand parser; pass argv after `carto anci`.
  const code = require('./anci').run({ argv: process.argv.slice(3) });
  process.exit(code);
} else if (command === 'remove') {
  require('./remove').run(process.cwd());
} else if (command === 'serve') {
  require('./serve').run(process.cwd());
} else if (command === 'agent') {
  require('./agent').run();
} else {
  console.error(`[CARTO] Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}
