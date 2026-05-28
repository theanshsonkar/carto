#!/usr/bin/env node

const pkg = require('../../package.json');
const command = process.argv[2];

function printUsage() {
  console.log(`
Usage: carto <command>

Commands:
  init          Detect project, write .carto/config.json, run first sync
  watch         Read .carto/config.json, start file watcher
  sync          Read .carto/config.json, run one sync, exit
  impact <file> Show which files and routes are affected by changing a file
  check         Report cross-domain deps, high-risk uncommitted changes, domain health
  remove        Remove AGENTS.md and .carto/ from this project
  serve         Start MCP server for AI tool integration

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
} else if (command === 'remove') {
  require('./remove').run(process.cwd());
} else if (command === 'serve') {
  require('./serve').run(process.cwd());
} else {
  console.error(`[CARTO] Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}
