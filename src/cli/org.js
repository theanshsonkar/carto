'use strict';

/**
 * `carto org` CLI commands.
 *
 * Subcommands:
 *   carto org init [--name NAME]              — register the current cwd
 *   carto org add <name> <root-path>          — register a repo
 *   carto org remove <name>                   — drop a repo
 *   carto org list                            — list registered repos
 *   carto org sync [--npm scope...] [--pypi prefix...] [--go prefix...] [--maven prefix...]
 *                                              — scan all repos, detect edges
 *   carto org overview                        — print summary
 *   carto org consumers <target>              — who imports this target
 */

const path = require('path');
const fs = require('fs');
const { OrgStore, defaultOrgDbDir } = require('../org/store');
const { orgSync } = require('../org/sync');
const queries = require('../org/queries');

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      // Multi-value flags collect into arrays.
      if (next && !next.startsWith('--')) {
        if (!out[key]) out[key] = next;
        else if (Array.isArray(out[key])) out[key].push(next);
        else out[key] = [out[key], next];
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function help() {
  console.log(`carto org <subcommand>

Subcommands:
  init [--name NAME]                   Register cwd as a repo (name = basename if omitted)
  add <name> <root-path>               Register a repo
  remove <name>                        Drop a repo
  list                                 List registered repos
  sync [--npm @scope] [--pypi prefix] [--go prefix] [--maven prefix]
                                       Scan + detect cross-repo edges
  overview                             Summary: repos + edge counts
  consumers <target>                   Who depends on this target (npm name, etc.)
`);
}

async function main(args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') { help(); return; }
  const flags = parseFlags(args.slice(1));
  const orgDir = flags['org-dir'] || defaultOrgDbDir();

  if (sub === 'init') {
    const root = process.cwd();
    const name = flags.name || path.basename(root);
    const cartoDb = path.join(root, '.carto', 'carto.db');
    const store = new OrgStore(orgDir).open();
    try {
      store.addRepo({ name, rootPath: root, cartoDbPath: fs.existsSync(cartoDb) ? cartoDb : null });
      console.log(`[CARTO] org init: registered "${name}" at ${root}`);
    } finally { store.close(); }
    return;
  }

  if (sub === 'add') {
    const name = flags._[0];
    const rootPath = flags._[1] ? path.resolve(flags._[1]) : null;
    if (!name || !rootPath) { console.error('Usage: carto org add <name> <root-path>'); process.exit(2); }
    if (!fs.existsSync(rootPath)) { console.error(`[CARTO] root path not found: ${rootPath}`); process.exit(2); }
    const store = new OrgStore(orgDir).open();
    try {
      const cartoDb = path.join(rootPath, '.carto', 'carto.db');
      store.addRepo({ name, rootPath, cartoDbPath: fs.existsSync(cartoDb) ? cartoDb : null });
      console.log(`[CARTO] org add: "${name}" → ${rootPath}`);
    } finally { store.close(); }
    return;
  }

  if (sub === 'remove') {
    const name = flags._[0];
    if (!name) { console.error('Usage: carto org remove <name>'); process.exit(2); }
    const store = new OrgStore(orgDir).open();
    try { store.removeRepo(name); console.log(`[CARTO] org remove: "${name}"`); }
    finally { store.close(); }
    return;
  }

  if (sub === 'list') {
    const store = OrgStore.openIfExists(orgDir);
    if (!store) { console.log('[CARTO] no org store yet. Run `carto org init`.'); return; }
    try {
      const repos = store.listRepos();
      if (repos.length === 0) { console.log('[CARTO] no repos registered.'); return; }
      console.log('| Name | Root | Last sync |');
      console.log('|------|------|-----------|');
      for (const r of repos) {
        const ls = r.last_sync_at ? new Date(r.last_sync_at).toISOString() : '—';
        console.log(`| ${r.name} | ${r.root_path} | ${ls} |`);
      }
    } finally { store.close(); }
    return;
  }

  if (sub === 'sync') {
    const scopes = {
      npm: toArr(flags.npm),
      pypi: toArr(flags.pypi),
      go: toArr(flags.go),
      maven: toArr(flags.maven),
    };
    const r = orgSync({ orgDir, scopes });
    console.log(`[CARTO] org sync: ${r.repos} repo(s), ${r.edges_inserted} edge(s) inserted.`);
    for (const [name, n] of Object.entries(r.edges_by_repo || {})) console.log(`  - ${name}: ${n} edges`);
    return;
  }

  if (sub === 'overview') {
    const store = OrgStore.openIfExists(orgDir);
    if (!store) { console.log('[CARTO] no org store yet.'); return; }
    try {
      const o = queries.orgArchitectureOverview(store);
      console.log(`# Org Architecture Overview\n`);
      console.log(`Repos: ${o.summary.total_repos}`);
      console.log(`Edges: ${o.summary.total_edges}`);
      console.log(`\nBy kind:`);
      for (const e of o.summary.edges_by_kind) console.log(`  ${e.edge_kind}: ${e.c}`);
    } finally { store.close(); }
    return;
  }

  if (sub === 'consumers') {
    const target = flags._[0];
    if (!target) { console.error('Usage: carto org consumers <target>'); process.exit(2); }
    const store = OrgStore.openIfExists(orgDir);
    if (!store) { console.log('[CARTO] no org store yet.'); return; }
    try {
      const rows = queries.findConsumersOfApi(store, target);
      console.log(`# Consumers of ${target}\n`);
      if (rows.length === 0) { console.log('_No consumers found._'); return; }
      console.log('| From repo | Kind | File |');
      console.log('|-----------|------|------|');
      for (const r of rows.slice(0, 50)) console.log(`| ${r.from_repo} | ${r.edge_kind} | ${r.from_file || '—'} |`);
    } finally { store.close(); }
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  help();
  process.exit(2);
}

function toArr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

module.exports = { main };
