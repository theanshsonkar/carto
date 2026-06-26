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
  pr-impact     Render a PR impact report (markdown or JSON) for the
                diff between two git refs. Used by the carto GitHub
                Action; works standalone too.
  validate      Read a unified diff from stdin and print the JSON
                validation result to stdout. Used by IDE extensions
                and the mcp-middleware proxy.
  mcp-middleware Wrap an inner stdio MCP server, intercept filesystem-
                write tool calls, and block HIGH-risk diffs before they
                reach disk. Usage:
                  carto mcp-middleware [--block-on HIGH|MEDIUM] -- <inner-cmd> [args...]
  check         Report cross-domain deps, high-risk uncommitted changes, domain health
  inspect       Read-only diagnostic: prints index paths, sizes, freshness,
                bitmap sidecar shape, top-impact files, schema version,
                sync timestamps, extraction errors. Use --json for piping.
  status        One-screen health view: file count, last sync, bitmap
                freshness, domains, extraction errors. Use \`carto inspect\`
                for the deep dump.
  why <file>    3-line summary of a file: domain, blast radius, exports,
                imports, imported-by. The CLI version of get_file_summary.
  explain <i>   Natural-language intent → architectural plan (files to
                touch, blast radius, similar patterns, conventions).
                Wraps the get_change_plan MCP tool.
  diff [a [b]]  Architectural diff between two git refs (defaults
                HEAD~1 → HEAD). Same engine as pr-impact.
  doctor        Diagnose Node version, native modules, missing
                grammars, index health, git hooks, MCP wiring. Prints
                actionable fixes.
  anci          ANCI v0.1 DRAFT export. Subcommands: publish, show,
                validate. Writes/reads .carto/anci.{yaml,bin} — the
                public, tool-neutral architecture description spec.
  temporal      Architectural history. Subcommands: init (backfill from
                git), status, events. Powers temporal MCP tools (drift,
                hotspots, evolution, complexity, churn, arch_events,
                health, context).
  org           Cross-repo / org-wide federation. Subcommands: init, add,
                remove, list, sync, overview, consumers. Detects npm /
                pypi / go-mod / maven / gRPC / OpenAPI / shared DB edges
                across repos.
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
} else if (command === 'pr-impact') {
  // pr-impact owns its own argv parsing + error handling + exit code.
  const code = require('./pr-impact').run({ argv: process.argv.slice(3) });
  process.exit(code);
} else if (command === 'validate') {
  // `carto validate` — stdin diff → JSON validation. Async because it
  // reads stdin. Exit code is propagated; --fail-on may produce 2.
  require('./validate').run({ argv: process.argv.slice(3) })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[CARTO] Fatal: ${err.message}`);
      process.exit(1);
    });
} else if (command === 'mcp-middleware') {
  // `carto mcp-middleware [opts] -- <inner-cmd> [args...]`
  // Split argv at the first `--`. Everything before configures the
  // middleware; everything after is the inner server command.
  const rest = process.argv.slice(3);
  const sepIdx = rest.indexOf('--');
  if (sepIdx === -1 || sepIdx === rest.length - 1) {
    console.error('[CARTO] Usage: carto mcp-middleware [opts] -- <inner-cmd> [args...]');
    console.error('        Options: --block-on HIGH|MEDIUM|LOW (default HIGH)');
    process.exit(1);
  }
  const opts = rest.slice(0, sepIdx);
  const innerCmd = rest[sepIdx + 1];
  const innerArgs = rest.slice(sepIdx + 2);
  let blockThreshold = 'HIGH';
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    if (a === '--block-on') blockThreshold = (opts[++i] || 'HIGH').toUpperCase();
    else if (a === '--help' || a === '-h') {
      console.log('Usage: carto mcp-middleware [--block-on HIGH|MEDIUM|LOW] -- <inner-cmd> [args...]');
      process.exit(0);
    } else {
      console.error(`[CARTO] mcp-middleware: unknown flag ${a}`);
      process.exit(1);
    }
  }
  try {
    require('../mcp/middleware').runProxy({
      projectRoot: process.cwd(),
      innerCmd,
      innerArgs,
      blockThreshold,
    });
  } catch (err) {
    console.error(`[CARTO] mcp-middleware failed: ${err.message}`);
    process.exit(1);
  }
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
} else if (command === 'status') {
  const code = require('./status').run({ argv: process.argv.slice(3) });
  process.exit(code);
} else if (command === 'why') {
  const code = require('./why').run({ argv: process.argv.slice(3) });
  process.exit(code);
} else if (command === 'explain') {
  const code = require('./explain').run({ argv: process.argv.slice(3) });
  process.exit(code);
} else if (command === 'diff') {
  const code = require('./diff').run({ argv: process.argv.slice(3) });
  process.exit(code);
} else if (command === 'doctor') {
  const code = require('./doctor').run({ argv: process.argv.slice(3) });
  process.exit(code);
} else if (command === 'anci') {
  // anci has its own subcommand parser; pass argv after `carto anci`.
  const code = require('./anci').run({ argv: process.argv.slice(3) });
  process.exit(code);
} else if (command === 'temporal') {
  // `carto temporal <subcmd>` — temporal history layer.
  require('./temporal').main(process.argv.slice(3)).catch(err => {
    console.error(`[CARTO] temporal: ${err.message}`);
    process.exit(1);
  });
} else if (command === 'org') {
  // `carto org <subcmd>` — cross-repo / org-wide federation.
  require('./org').main(process.argv.slice(3)).catch(err => {
    console.error(`[CARTO] org: ${err.message}`);
    process.exit(1);
  });
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
