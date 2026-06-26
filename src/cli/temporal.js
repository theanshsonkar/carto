'use strict';

/**
 * `carto temporal` — temporal-layer CLI commands.
 *
 * Subcommands:
 *   carto temporal init        — backfill from git history
 *   carto temporal status      — show snapshot + commit + event counts
 *   carto temporal events      — list recent architectural events
 *
 * The temporal store is auto-captured on every `carto sync` once initialized.
 * `init` is one-time bootstrap to populate `file_churn` from git history.
 */

const path = require('path');
const fs = require('fs');
const { TemporalStore } = require('../temporal/store');
const { backfillFromGit } = require('../temporal/backfill');

async function runInit({ since = null, maxCommits = 2000, projectRoot = process.cwd() } = {}) {
  const cartoDir = path.join(projectRoot, '.carto');
  if (!fs.existsSync(cartoDir)) {
    console.error('[CARTO] No .carto/ found. Run `carto init` first.');
    process.exit(2);
  }
  console.log('[CARTO] Backfilling temporal data from git history...');
  const result = await backfillFromGit({
    projectRoot,
    maxCommits,
    since,
    onProgress: ({ done, files }) => {
      process.stdout.write(`\r[CARTO]   ${done} commits, ${files} file touches`);
    },
  });
  if (result.errors.length > 0) process.stdout.write('\n');
  else process.stdout.write('\n');
  console.log(
    `[CARTO] Backfill complete: ${result.commits} commits, ${result.files} file touches in ${result.elapsedMs}ms.`
  );
  if (result.errors.length > 0) {
    for (const e of result.errors) console.warn(`[CARTO]   ⚠ ${e}`);
  }
  return result;
}

function runStatus({ projectRoot = process.cwd() } = {}) {
  const temporal = TemporalStore.openIfExists(projectRoot, { readonly: true });
  if (!temporal) {
    console.log('[CARTO] No temporal database yet. Run `carto temporal init` to start.');
    return { healthy: false, reason: 'missing' };
  }
  try {
    const snaps = temporal.countSnapshots();
    const commits = temporal.countCommits();
    const recent = temporal.getMostRecentSnapshot();
    const lastBackfill = temporal.getMeta('last_backfill_at');
    const events = temporal.getArchEvents({ limit: 5 });
    console.log(`# Carto Temporal Status\n`);
    console.log(`- **Snapshots:** ${snaps}`);
    console.log(`- **Commits:** ${commits}`);
    if (recent) {
      const when = new Date(recent.ts).toISOString();
      console.log(`- **Latest:** ${when} (${recent.source})`);
    }
    if (lastBackfill) {
      const when = new Date(parseInt(lastBackfill, 10)).toISOString();
      console.log(`- **Last backfill:** ${when}`);
    }
    if (events.length > 0) {
      console.log(`\n## Recent events`);
      for (const e of events) {
        const when = new Date(e.ts).toISOString();
        const target = e.domain || e.file_path || '';
        console.log(`- ${when} · ${e.severity} · ${e.kind}${target ? ` · ${target}` : ''}`);
      }
    }
    return { healthy: true, snapshots: snaps, commits, events: events.length };
  } finally {
    temporal.close();
  }
}

function runEvents({ projectRoot = process.cwd(), severity = null, kind = null, timeRange = '90d', limit = 50 } = {}) {
  const temporal = TemporalStore.openIfExists(projectRoot, { readonly: true });
  if (!temporal) {
    console.log('[CARTO] No temporal database. Run `carto temporal init`.');
    return { events: [] };
  }
  try {
    const { getArchEvents } = require('../temporal/queries');
    const { events } = getArchEvents(temporal, { severity, kind, timeRange, limit });
    if (events.length === 0) {
      console.log(`No events in the last ${timeRange}.`);
      return { events };
    }
    console.log(`# Architectural Events (${timeRange})\n`);
    console.log(`| When | Severity | Kind | Target | Detail |`);
    console.log(`|------|----------|------|--------|--------|`);
    for (const e of events) {
      const when = new Date(e.ts).toISOString();
      const target = e.domain || e.file_path || '';
      let detail = '';
      if (e.detail_json) {
        try {
          const parsed = JSON.parse(e.detail_json);
          detail = Object.entries(parsed).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ');
        } catch {}
      }
      console.log(`| ${when} | ${e.severity} | ${e.kind} | ${target} | ${detail} |`);
    }
    return { events };
  } finally {
    temporal.close();
  }
}

function help() {
  console.log(`carto temporal <subcommand>

Subcommands:
  init [--since <range>] [--max-commits N]
                              Backfill from git history.
  status                      Show snapshot/commit counts + recent events.
  events [--severity LEVEL] [--kind KIND] [--time-range RANGE]
                              List architectural events.

Examples:
  carto temporal init
  carto temporal init --since "1 year ago"
  carto temporal init --max-commits 500
  carto temporal status
  carto temporal events --severity critical
`);
}

async function main(args) {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    help();
    return;
  }

  const opts = parseFlags(args.slice(1));

  if (sub === 'init') {
    await runInit({
      since: opts['since'] || null,
      maxCommits: opts['max-commits'] ? parseInt(opts['max-commits'], 10) : 2000,
    });
    return;
  }
  if (sub === 'status') {
    runStatus({});
    return;
  }
  if (sub === 'events') {
    runEvents({
      severity: opts['severity'] || null,
      kind: opts['kind'] || null,
      timeRange: opts['time-range'] || '90d',
      limit: opts['limit'] ? parseInt(opts['limit'], 10) : 50,
    });
    return;
  }
  console.error(`Unknown subcommand: ${sub}`);
  help();
  process.exit(2);
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

module.exports = { main, runInit, runStatus, runEvents };
