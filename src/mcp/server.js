#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { SQLiteStore } = require('../store/sqlite-store');
const { normalizeFileArg } = require('../store/path-utils');
const { syncFiles } = require('../store/sync');
const bitmapTools = require('../bitmap/tools');
const { ensureBitmapFresh, invalidate: invalidateBitmap } = require('../bitmap/index');
const { validateDiff, recordSideEffects } = require('./validate');

const projectRoot = process.cwd();

// Process-level safety nets. Without these, any error that
// escapes the request handler (very rare, but possible from native bindings
// or async stack frames) takes the whole MCP server down, and Claude Code /
// Kiro surface `-32000 Failed to reconnect`. We log to stderr (which the
// host logs but never terminates the JSON-RPC channel) and stay alive.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[CARTO MCP] Uncaught exception: ${err && err.stack ? err.stack : err}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[CARTO MCP] Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}\n`);
});

// Open SQLite directly — no re-indexing, instant startup
let store = null;

function getStore() {
  if (store) return store;
  const dbPath = path.join(projectRoot, '.carto', 'carto.db');
  if (!fs.existsSync(dbPath)) return null;
  // Open BEFORE assigning to the module-scoped `store` so that if open()
  // throws (corrupt DB, locked file, schema mismatch) we don't poison the
  // cache with a broken instance — every subsequent call would otherwise
  // return the broken object and never recover.
  const s = new SQLiteStore(projectRoot);
  s.open({ readonly: true }); // Defense in depth: MCP tools never write
  store = s;
  return store;
}

/**
 * getSidecar() — bitmap engine entry point.
 *
 * Lazily loads (or rebuilds) the in-memory bitmap sidecar for the
 * bitmap-eligible MCP tools. Returns null on any failure so callers can
 * fall back to the SQLite query path silently — bitmap is a *speedup*,
 * never a behavior change. Stale-disk and corrupt-disk are handled
 * inside `ensureBitmapFresh` (rebuilds from the SQLite source of truth).
 *
 * Failure modes that drop us back to SQLite:
 *   - SQLite store unavailable (no `.carto/carto.db`).
 *   - DB row read fails mid-build (race with a concurrent writer).
 *   - Disk write to bitmap.bin fails (read-only FS, disk full) — the
 *     in-memory sidecar is still returned, but if even build threw we
 *     surface the error and use SQLite.
 */
function getSidecar() {
  const s = getStore();
  if (!s) return null;
  const cartoDir = path.join(projectRoot, '.carto');
  try {
    return ensureBitmapFresh(cartoDir, s);
  } catch (err) {
    process.stderr.write(
      `[CARTO MCP] bitmap load failed, falling back to SQLite: ` +
      `${err && err.message ? err.message : err}\n`
    );
    return null;
  }
}

/**
 * lazyReparseFile(file) — MCP-side freshness check.
 *
 * Before answering a file-aware tool call, mtime+size check the requested
 * file against the indexed row. If the file is stale (user edited it
 * between the last `carto sync` and this MCP query — e.g. uncommitted
 * work), re-parse it inline so the answer reflects current code.
 *
 * Three states:
 *   - File missing on disk → leave the index alone. The user may have
 *     deleted-and-recreated mid-session; we don't want to drop a row that
 *     a sync would re-add seconds later.
 *   - File present, in index, mtime+size match → fast path, no work.
 *   - File present, stale or unknown → call syncFiles() with a transient
 *     writable connection. syncFiles opens, writes, closes its own
 *     connection so the cached read-only `store` keeps the readonly
 *     guarantee that the MCP read path itself can never write.
 *
 * Best-effort: any failure (stat, parse, write contention) falls through
 * to "answer with whatever the index has." Stale data beats a crash.
 */
function lazyReparseFile(file) {
  if (!file || typeof file !== 'string') return;

  const fullPath = path.resolve(projectRoot, file);
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return; // File doesn't exist on disk — leave index alone.
  }

  const s = getStore();
  if (!s) return;

  const existing = s.getFileByPath(file);
  const mtime = Math.floor(stat.mtimeMs);
  const size = stat.size;

  // Fresh row → nothing to do.
  if (existing && existing.mtime === mtime && existing.size === size) return;

  // Stale or unknown — reparse just this file. syncFiles() opens its own
  // writable connection and closes it, so the readonly `store` stays
  // readonly. Costs ~5-50ms per stale file.
  try {
    syncFiles(projectRoot, [file]);
  } catch (err) {
    process.stderr.write(`[CARTO MCP] Lazy reparse failed for ${file}: ${err && err.message ? err.message : err}\n`);
  }
}

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

/**
 * withWriter(fn) — run `fn(writer)` against a brief writable connection
 * scoped to a single MCP call. The cached MCP `store` is opened readonly
 * (so a buggy tool path can never write through SQLite); episodic-memory
 * tools that need to record decisions/interventions go through this
 * helper instead. The writer opens, writes, closes within this function
 * — the readonly `store` is untouched. Failures are swallowed (returned
 * as null) because validation should always degrade gracefully — the
 * read result matters more than the audit log row.
 */
function withWriter(fn) {
  let writer = null;
  try {
    writer = new SQLiteStore(projectRoot);
    writer.open();
    return fn(writer);
  } catch (err) {
    process.stderr.write(
      `[CARTO MCP] writer connection failed: ${err && err.message ? err.message : err}\n`
    );
    return null;
  } finally {
    if (writer) {
      try { writer.close(); } catch {}
    }
  }
}

function notIndexed() {
  return text('No .carto/carto.db found. Run `carto sync` first.');
}

/**
 * runTemporalTool(name, args) — dispatch the 8 temporal MCP tools.
 *
 * Lazy-requires the temporal modules so a Carto install with no
 * temporal DB doesn't pay the require() cost on every MCP call.
 * Opens the temporal store readonly; returns a friendly markdown
 * stub if the DB doesn't exist yet.
 */
function runTemporalTool(name, args) {
  const { TemporalStore } = require('../temporal/store');
  const temporal = TemporalStore.openIfExists(projectRoot, { readonly: true });
  if (!temporal) {
    return text(
      `Temporal database not initialized. Run \`carto temporal init\` to ` +
      `backfill from git history, then \`carto sync\` to capture the current ` +
      `snapshot. The temporal layer powers ${name} and 7 other tools.`
    );
  }
  try {
    const q = require('../temporal/queries');
    if (name === 'get_architectural_drift') {
      const r = q.getArchitecturalDrift(temporal, { domain: args.domain || null, timeRange: args.time_range || '30d' });
      return text(formatDrift(r));
    }
    if (name === 'get_domain_evolution') {
      const r = q.getDomainEvolution(temporal, { domain: args.domain, timeRange: args.time_range || '90d' });
      return text(formatEvolution(r));
    }
    if (name === 'get_hotspot_files') {
      const r = q.getHotspotFiles(temporal, { timeRange: args.time_range || '90d', limit: args.limit || 20 });
      return text(formatHotspots(r));
    }
    if (name === 'get_complexity_trend') {
      const r = q.getComplexityTrend(temporal, { file: args.file, timeRange: args.time_range || '90d' });
      return text(formatComplexity(r));
    }
    if (name === 'get_churn_vs_blast_radius') {
      const r = q.getChurnVsBlastRadius(temporal, { timeRange: args.time_range || '90d' });
      return text(formatChurnVsBlast(r));
    }
    if (name === 'get_arch_events') {
      const r = q.getArchEvents(temporal, {
        severity: args.severity || null,
        kind: args.kind || null,
        timeRange: args.time_range || '90d',
        limit: 100,
      });
      return text(formatEvents(r));
    }
    if (name === 'get_domain_health') {
      const r = q.getDomainHealth(temporal, { domain: args.domain || null });
      return text(formatHealth(r));
    }
    if (name === 'get_temporal_context') {
      const r = q.getTemporalContext(temporal, { file: args.file });
      return text(formatTemporalContext(r));
    }
    return text(`Unknown temporal tool: ${name}`);
  } finally {
    temporal.close();
  }
}

function formatDrift(r) {
  const lines = [`# Architectural Drift (${r.window || 'all time'})`];
  lines.push(`\n**Trend:** ${r.trend}`);
  lines.push(`**Snapshots:** ${r.totals.snapshots}`);
  lines.push(`**Files:** ${r.totals.fileCountBefore} → ${r.totals.fileCountAfter}\n`);
  if (r.byDomain && r.byDomain.length > 0) {
    lines.push('| Domain | Before | After | Δ | Events |');
    lines.push('|--------|--------|-------|---|--------|');
    for (const d of r.byDomain) {
      const arrow = d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
      lines.push(`| ${d.domain} | ${d.before} | ${d.after} | ${arrow} | ${d.eventCount} |`);
    }
  } else if (r.reason === 'insufficient_data') {
    lines.push('_Not enough snapshots in the window. Run `carto temporal init` and re-sync._');
  }
  return lines.join('\n');
}

function formatEvolution(r) {
  const lines = [`# Domain Evolution: ${r.domain}`];
  if (!r.points || r.points.length === 0) {
    lines.push('\n_No history for this domain._');
    return lines.join('\n');
  }
  lines.push(`\n${r.points.length} snapshot${r.points.length === 1 ? '' : 's'}.\n`);
  lines.push('| When | Snapshot | File count |');
  lines.push('|------|----------|-----------:|');
  for (const p of r.points) {
    const when = new Date(p.ts).toISOString();
    lines.push(`| ${when} | ${p.snapshot_id} | ${p.fileCount} |`);
  }
  return lines.join('\n');
}

function formatHotspots(r) {
  const lines = [`# Hotspot Files (${r.window})`];
  if (!r.hotspots || r.hotspots.length === 0) {
    lines.push('\n_No hotspot data yet. Run `carto temporal init`._');
    return lines.join('\n');
  }
  lines.push(`\nTop ${r.hotspots.length} files by churn × blast_radius.\n`);
  lines.push('| File | Commits | Blast | Score |');
  lines.push('|------|--------:|------:|------:|');
  for (const h of r.hotspots) {
    lines.push(`| ${h.file_path} | ${h.commit_count} | ${h.blast_radius} | ${h.score} |`);
  }
  return lines.join('\n');
}

function formatComplexity(r) {
  const lines = [`# Complexity Trend: ${r.file}`];
  if (!r.points || r.points.length === 0) {
    lines.push('\n_File not present in the temporal index._');
    return lines.join('\n');
  }
  lines.push(`\n- Commits: ${r.commit_count}`);
  lines.push(`- Snapshots present: ${r.snapshots_present}`);
  lines.push(`- Last modified: ${r.last_modified_ts ? new Date(r.last_modified_ts).toISOString() : '—'}`);
  lines.push(`- Trend: ${r.trend}`);
  return lines.join('\n');
}

function formatChurnVsBlast(r) {
  const lines = [`# Churn vs Blast Radius (${r.window})`];
  if (!r.files || r.files.length === 0) {
    lines.push('\n_No churn data yet. Run `carto temporal init`._');
    return lines.join('\n');
  }
  lines.push(`\n${r.files.length} files.\n`);
  lines.push('| File | Commits | Blast |');
  lines.push('|------|--------:|------:|');
  for (const f of r.files.slice(0, 50)) {
    lines.push(`| ${f.file_path} | ${f.commit_count} | ${f.blast_radius || 0} |`);
  }
  if (r.files.length > 50) lines.push(`\n_…${r.files.length - 50} more files._`);
  return lines.join('\n');
}

function formatEvents(r) {
  const lines = [`# Architectural Events (${r.window})`];
  if (!r.events || r.events.length === 0) {
    lines.push('\n_No events in this window._');
    return lines.join('\n');
  }
  lines.push(`\n${r.events.length} event${r.events.length === 1 ? '' : 's'}.\n`);
  lines.push('| When | Severity | Kind | Target |');
  lines.push('|------|----------|------|--------|');
  for (const e of r.events.slice(0, 50)) {
    const when = new Date(e.ts).toISOString();
    const target = e.domain || e.file_path || '';
    lines.push(`| ${when} | ${e.severity} | ${e.kind} | ${target} |`);
  }
  return lines.join('\n');
}

function formatHealth(r) {
  const lines = ['# Domain Health'];
  if (!r.domains || r.domains.length === 0) {
    lines.push('\n_No health data yet. Need at least 2 snapshots._');
    return lines.join('\n');
  }
  lines.push('\n| Domain | Current | Prior | Growth | Instability | Events | Hot files |');
  lines.push('|--------|--------:|------:|-------:|------------:|-------:|----------:|');
  for (const d of r.domains) {
    lines.push(`| ${d.domain} | ${d.current_size} | ${d.prior_size} | ${d.growth} | ${(d.instability * 100).toFixed(0)}% | ${d.events} | ${d.hotspots.length} |`);
  }
  return lines.join('\n');
}

function formatTemporalContext(r) {
  const lines = [`# Temporal Context: ${r.file}`];
  if (!r.present) {
    lines.push('\n_File not present in temporal index._');
    return lines.join('\n');
  }
  lines.push(`\n- **Commits:** ${r.commit_count}`);
  lines.push(`- **Blast radius:** ${r.blast_radius}`);
  lines.push(`- **First seen:** ${r.first_seen_ts ? new Date(r.first_seen_ts).toISOString() : '—'}`);
  lines.push(`- **Last modified:** ${r.last_modified_ts ? new Date(r.last_modified_ts).toISOString() : '—'}`);
  lines.push(`- **Age:** ${r.age_days != null ? `${r.age_days} days` : '—'}`);
  lines.push(`- **Snapshots present in:** ${r.snapshots_present}`);
  if (r.recent_events && r.recent_events.length > 0) {
    lines.push(`\n## Recent events`);
    lines.push('| When | Severity | Kind |');
    lines.push('|------|----------|------|');
    for (const e of r.recent_events.slice(0, 10)) {
      const when = new Date(e.ts).toISOString();
      lines.push(`| ${when} | ${e.severity} | ${e.kind} |`);
    }
  }
  return lines.join('\n');
}

/**
 * runBrainTool(name, args) — dispatch the 10 brain MCP tools.
 *
 * Each brain tool composes data from store + temporal store. Both are
 * opened readonly; missing temporal DB is degraded gracefully (we return
 * partial results rather than refuse).
 */
function runBrainTool(name, args) {
  const s = getStore();
  if (!s) return notIndexed();
  const { TemporalStore } = require('../temporal/store');
  const temporalStore = TemporalStore.openIfExists(projectRoot, { readonly: true });
  try {
    const brain = require('../brain');

    if (name === 'get_invariants') {
      const rules = brain.invariants.inferInvariants(s, { domain: args.domain || null, threshold: args.threshold });
      return text(formatInvariants(rules));
    }
    if (name === 'get_canonical_pattern') {
      const r = brain.invariants.getCanonicalPattern(s, { pattern_type: args.pattern_type, domain: args.domain || null });
      return text(formatCanonical(r, args.pattern_type));
    }
    if (name === 'get_conventions') {
      let convs;
      if (args.file) {
        convs = brain.conventions.conventionsForFile(s, args.file);
      } else {
        convs = brain.conventions.mineConventions(s);
      }
      return text(formatConventions(convs, args.file));
    }
    if (name === 'get_action_patterns') {
      if (!temporalStore) {
        return text('Action patterns require the temporal layer. Run `carto temporal init`.');
      }
      const patterns = brain.procedural.actionPatternsForIntent(temporalStore, s, args.intent || '');
      return text(formatActionPatterns(patterns, args.intent));
    }
    if (name === 'scaffold_for_intent') {
      if (!temporalStore) {
        return text('Scaffolding requires the temporal layer. Run `carto temporal init`.');
      }
      const r = brain.procedural.scaffoldForIntent(temporalStore, s, args.intent);
      return text(formatScaffold(r));
    }
    if (name === 'get_working_memory') {
      const r = brain.working.getWorkingMemory({ store: s, temporalStore, projectRoot });
      return text(formatWorkingMemory(r));
    }
    if (name === 'get_pending_decisions') {
      const r = brain.working.getPendingDecisions(s, { hours: args.hours || 6 });
      return text(formatPendingDecisions(r));
    }
    if (name === 'get_active_drift') {
      const r = brain.working.getActiveDrift(temporalStore, { threshold: args.threshold });
      return text(formatActiveDrift(r));
    }
    if (name === 'get_active_suggestions') {
      const suggestions = brain.suggestions.getActiveSuggestions({ store: s, temporalStore, projectRoot });
      return text(formatActiveSuggestions(suggestions));
    }
    if (name === 'dismiss_suggestion') {
      if (!args.id) return text('Missing required argument: id');
      // Acknowledgment-only. Persistence is in the episodic memory:
      // we write an "interventions" row marking the suggestion accepted.
      withWriter((writer) => {
        try {
          writer.db.prepare(`
            INSERT INTO interventions (session_id, ts, kind, file, severity, message, accepted)
            VALUES (NULL, ?, 'suggestion_dismissed', NULL, 'minor', ?, 1)
          `).run(Date.now(), `Dismissed suggestion ${args.id}`);
        } catch {}
      });
      return text(`Dismissed suggestion: ${args.id}`);
    }
    return text(`Unknown brain tool: ${name}`);
  } finally {
    if (temporalStore) temporalStore.close();
  }
}

function formatInvariants(rules) {
  const lines = ['# Architectural Invariants'];
  if (rules.length === 0) {
    lines.push('\n_No high-confidence invariants found yet._');
    return lines.join('\n');
  }
  lines.push(`\n${rules.length} invariant${rules.length === 1 ? '' : 's'}.\n`);
  lines.push('| Confidence | Kind | Scope | Rule |');
  lines.push('|-----------:|------|-------|------|');
  for (const r of rules.slice(0, 50)) {
    lines.push(`| ${r.confidence.toFixed(2)} | ${r.kind} | ${r.scope} | ${r.rule} |`);
  }
  if (rules.length > 50) lines.push(`\n_…${rules.length - 50} more rules._`);
  return lines.join('\n');
}

function formatCanonical(r, patternType) {
  if (!r) return `No canonical pattern found for: ${patternType}`;
  const lines = [`# Canonical Pattern: ${patternType}`];
  lines.push(`\n- **File:** ${r.file}`);
  if (r.route_count != null) lines.push(`- **Routes:** ${r.route_count}`);
  if (r.model_count != null) lines.push(`- **Models:** ${r.model_count}`);
  lines.push(`- **Blast radius:** ${r.blast_radius}`);
  lines.push(`- **Confidence:** ${r.confidence.toFixed(2)}`);
  return lines.join('\n');
}

function formatConventions(convs, file) {
  const lines = [`# Conventions${file ? `: ${file}` : ''}`];
  if (!convs || convs.length === 0) {
    lines.push('\n_No conventions detected._');
    return lines.join('\n');
  }
  lines.push(`\n${convs.length} convention${convs.length === 1 ? '' : 's'}.\n`);
  lines.push('| Confidence | Kind | Scope | Rule |');
  lines.push('|-----------:|------|-------|------|');
  for (const c of convs.slice(0, 50)) {
    lines.push(`| ${c.confidence.toFixed(2)} | ${c.kind} | ${c.scope} | ${c.rule} |`);
  }
  return lines.join('\n');
}

function formatActionPatterns(patterns, intent) {
  const lines = [`# Action Patterns${intent ? `: ${intent}` : ''}`];
  if (!patterns || patterns.length === 0) {
    lines.push('\n_No co-change patterns matched._');
    return lines.join('\n');
  }
  for (const p of patterns) {
    lines.push(`\n## ${p.anchor}`);
    lines.push(`Co-change confidence ${p.confidence.toFixed(2)} · ${p.evidence_count} historical commits`);
    lines.push('| Partner file | Co-occurrence | Commits |');
    lines.push('|--------------|--------------:|--------:|');
    for (const partner of p.partners) {
      lines.push(`| ${partner.file} | ${partner.co_occurrence.toFixed(2)} | ${partner.commits} |`);
    }
  }
  return lines.join('\n');
}

function formatScaffold(r) {
  const lines = [`# Scaffold for: ${r.intent}`];
  if (r.suggestions && r.suggestions.length > 0) {
    lines.push('\n## Files typically changed together');
    for (const s of r.suggestions) {
      lines.push(`\n- **Anchor:** ${s.anchor_file} (${s.evidence}, confidence ${s.confidence.toFixed(2)})`);
      for (const f of s.co_changed_files) lines.push(`  - ${f}`);
    }
  } else {
    lines.push('\n_No relevant action patterns found._');
  }
  if (r.canonical && r.canonical.length > 0) {
    lines.push('\n## Canonical examples');
    for (const c of r.canonical) {
      lines.push(`- ${c.type}: ${c.file} (blast ${c.blast_radius})`);
    }
  }
  return lines.join('\n');
}

function formatWorkingMemory(r) {
  const lines = ['# Working Memory'];
  lines.push(`\n- **Branch:** ${r.branch || '—'}`);
  lines.push(`- **HEAD:** ${r.head_sha || '—'}`);
  lines.push(`- **Uncommitted files:** ${r.uncommitted_files.length}`);
  if (r.uncommitted_files.length > 0) {
    lines.push('| Path | Kind |');
    lines.push('|------|------|');
    for (const f of r.uncommitted_files.slice(0, 20)) {
      lines.push(`| ${f.path} | ${f.change_kind} |`);
    }
  }
  lines.push(`\n- **Recent decisions (24h):** ${r.recent_decisions_count}`);
  lines.push(`- **Open HIGH-severity warnings:** ${r.open_warnings.length}`);
  if (r.recent_drift) {
    const d = r.recent_drift;
    lines.push(`\n## Recent drift (7d)`);
    lines.push(`- **${d.domain}:** ${d.before} → ${d.after} (Δ ${d.delta}, trend ${d.trend})`);
  }
  return lines.join('\n');
}

function formatPendingDecisions(r) {
  const lines = ['# Pending Decisions'];
  if (!r || r.length === 0) {
    lines.push('\n_No pending decisions._');
    return lines.join('\n');
  }
  lines.push(`\n${r.length} pending decision${r.length === 1 ? '' : 's'}.\n`);
  lines.push('| When | Kind | File | Risk |');
  lines.push('|------|------|------|------|');
  for (const d of r.slice(0, 30)) {
    const when = new Date(d.ts).toISOString();
    const risk = d.payload && d.payload.risk ? d.payload.risk : '—';
    lines.push(`| ${when} | ${d.kind} | ${d.file || '—'} | ${risk} |`);
  }
  return lines.join('\n');
}

function formatActiveDrift(r) {
  const lines = ['# Active Drift (7d)'];
  if (!r.domains || r.domains.length === 0) {
    lines.push('\n_No drift data yet._');
    return lines.join('\n');
  }
  if (r.threshold_breaches.length > 0) {
    lines.push('\n## Threshold breaches');
    lines.push('| Domain | Before | After | Δ |');
    lines.push('|--------|-------:|------:|---|');
    for (const d of r.threshold_breaches) {
      lines.push(`| ${d.domain} | ${d.before} | ${d.after} | ${d.delta > 0 ? '+' + d.delta : d.delta} |`);
    }
  }
  lines.push('\n## All domains');
  lines.push('| Domain | Before | After | Δ |');
  lines.push('|--------|-------:|------:|---|');
  for (const d of r.domains) {
    lines.push(`| ${d.domain} | ${d.before} | ${d.after} | ${d.delta > 0 ? '+' + d.delta : d.delta} |`);
  }
  return lines.join('\n');
}

function formatActiveSuggestions(suggestions) {
  const lines = ['# Active Suggestions'];
  if (!suggestions || suggestions.length === 0) {
    lines.push('\n_No active suggestions._');
    return lines.join('\n');
  }
  lines.push(`\n${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}.\n`);
  lines.push('| Severity | Trigger | Summary |');
  lines.push('|----------|---------|---------|');
  for (const s of suggestions) {
    lines.push(`| ${s.severity} | ${s.trigger} | ${s.summary} |`);
  }
  return lines.join('\n');
}

/**
 * runAiTool(name, args) — dispatcher for the 14 AI-native primitives.
 *
 * Lazily opens the temporal store readonly; tools degrade gracefully when
 * it's missing. All formatters are pure-functional (no I/O).
 */
function runAiTool(name, args) {
  const s = getStore();
  if (!s) return notIndexed();
  const { TemporalStore } = require('../temporal/store');
  const temporalStore = TemporalStore.openIfExists(projectRoot, { readonly: true });
  try {
    const ai = require('../ai/tools');
    const ctx = { store: s, projectRoot, temporalStore };

    if (name === 'get_minimal_context_for_intent') {
      const r = ai.minimalContext(args, ctx);
      return text(r.markdown || JSON.stringify(r, null, 2));
    }
    if (name === 'get_progressive_disclosure_tree') {
      const r = ai.progressiveDisclosure(args, ctx);
      return text(formatProgressiveTree(r));
    }
    if (name === 'get_token_budget_report') {
      const r = ai.tokenBudget(args, ctx);
      return text(formatTokenBudget(r));
    }
    if (name === 'get_decision_log') {
      const r = ai.decisionLog(args, ctx);
      return text(formatDecisionLog(r));
    }
    if (name === 'get_evolution_delta') {
      const r = ai.evolutionDelta(args, ctx);
      return text(formatEvolutionDelta(r));
    }
    if (name === 'get_change_velocity') {
      const r = ai.changeVelocity(args, ctx);
      return text(formatChangeVelocity(r));
    }
    if (name === 'get_test_coverage_map') {
      const r = ai.testCoverageMap(args, ctx);
      return text(formatTestCoverage(r));
    }
    if (name === 'get_safety_checklist') {
      const r = ai.safetyChecklist(args, ctx);
      return text(formatSafetyChecklist(r));
    }
    if (name === 'get_data_flow') {
      const r = ai.dataFlow(args, ctx);
      return text(formatDataFlow(r));
    }
    if (name === 'get_interface_contract') {
      const r = ai.interfaceContract(args, ctx);
      return text(formatInterfaceContract(r));
    }
    if (name === 'explain_change_in_natural_language') {
      const r = ai.explainChange(args, { ...ctx, sidecar: getSidecar() });
      return text(formatExplainChange(r));
    }
    if (name === 'get_stale_docs') {
      const r = ai.staleDocs(args, ctx);
      return text(formatStaleDocs(r));
    }
    if (name === 'get_dependency_surface') {
      const r = ai.dependencySurface(args, ctx);
      return text(formatDependencySurface(r));
    }
    if (name === 'get_upgrade_risk') {
      const r = ai.upgradeRisk(args, ctx);
      return text(formatUpgradeRisk(r));
    }
    return text(`Unknown AI tool: ${name}`);
  } finally {
    if (temporalStore) temporalStore.close();
  }
}

function formatProgressiveTree(r) {
  const lines = ['# Progressive Disclosure Tree'];
  if (!r.domains || r.domains.length === 0) {
    lines.push('\n_No domains yet._');
    return lines.join('\n');
  }
  for (const d of r.domains) {
    lines.push(`\n## ${d.name}  ·  ${d.file_count} files  ·  ${d.route_count} routes`);
    if (d.top_files && d.top_files.length > 0) {
      lines.push('| File | Blast | Exports |');
      lines.push('|------|------:|---------|');
      for (const f of d.top_files) {
        lines.push(`| ${f.path} | ${f.blast_radius} | ${(f.exports || []).join(', ') || '—'} |`);
      }
    }
  }
  return lines.join('\n');
}

function formatTokenBudget(r) {
  const lines = ['# Token Budget Report'];
  lines.push(`\n- **Intent:** ${r.intent || '(none)'}`);
  lines.push(`- **Budget:** ${r.budget_tokens} tokens`);
  lines.push(`- **Used:** ${r.used_tokens} tokens (${r.files_included} files)`);
  lines.push(`- **Dropped:** ${r.files_dropped} files`);
  lines.push(`- **Repo total (approx):** ${r.repo_tokens_approx} tokens across ${r.total_files_in_repo} files`);
  lines.push(`- **Efficiency:** ${r.efficiency}% of repo fits the budget`);
  return lines.join('\n');
}

function formatDecisionLog(r) {
  const lines = [`# Decision Log (${r.hours}h)`];
  if (!r.decisions || r.decisions.length === 0) {
    lines.push('\n_No decisions in this window._');
    return lines.join('\n');
  }
  lines.push(`\n${r.decisions.length} decision${r.decisions.length === 1 ? '' : 's'}.\n`);
  lines.push('| When | Kind | File |');
  lines.push('|------|------|------|');
  for (const d of r.decisions.slice(0, 50)) {
    const when = new Date(d.ts).toISOString();
    lines.push(`| ${when} | ${d.kind} | ${d.file || '—'} |`);
  }
  if (r.events && r.events.length > 0) {
    lines.push(`\n## Architectural events in the same window`);
    lines.push(`${r.events.length} event(s).`);
  }
  return lines.join('\n');
}

function formatEvolutionDelta(r) {
  if (!r.delta || r.reason === 'no_temporal') {
    return '# Evolution Delta\n\n_Requires temporal layer. Run `carto temporal init`._';
  }
  return formatDrift(r.delta);  // reuse existing formatter
}

function formatChangeVelocity(r) {
  if (r.reason === 'no_temporal') {
    return '# Change Velocity\n\n_Requires temporal layer. Run `carto temporal init`._';
  }
  const lines = ['# Change Velocity'];
  lines.push(`\n- **Days observed:** ${r.days_observed}`);
  lines.push(`- **Total commits:** ${r.total_commits}`);
  lines.push(`- **Avg commits / day:** ${r.avg_commits_per_day}`);
  if (r.daily && r.daily.length > 0) {
    lines.push('\n| Day | Commits |');
    lines.push('|-----|--------:|');
    for (const d of r.daily.slice(-14)) lines.push(`| ${d.day} | ${d.commits} |`);
  }
  return lines.join('\n');
}

function formatTestCoverage(r) {
  const lines = ['# Test Coverage Map'];
  lines.push(`\nConsidered ${r.considered} files; ${r.untested ? r.untested.length : 0} have no detected test.`);
  if (r.by_blast_radius && r.by_blast_radius.length > 0) {
    lines.push('\n## Top untested files by blast radius');
    lines.push('| File | Blast |');
    lines.push('|------|------:|');
    for (const f of r.by_blast_radius.slice(0, 30)) {
      lines.push(`| ${f.path} | ${f.blast_radius} |`);
    }
  }
  return lines.join('\n');
}

function formatSafetyChecklist(r) {
  const lines = [`# Safety Checklist: ${r.file || ''}`];
  if (!r.items || r.items.length === 0) {
    lines.push('\n_No checks ran._');
    return lines.join('\n');
  }
  for (const item of r.items) {
    const icon = item.severity === 'safe' ? '✅' :
                 item.severity === 'minor' ? '⚠️' :
                 item.severity === 'major' ? '🟡' : '🔴';
    lines.push(`- ${icon} **${item.severity}** — ${item.message}`);
  }
  return lines.join('\n');
}

function formatDataFlow(r) {
  const lines = [`# Data Flow: ${r.source || ''}`];
  lines.push(`\n- **Domain:** ${r.domain || '—'}`);
  if (r.imports && r.imports.length > 0) {
    lines.push('\n## Upstream (imports)');
    for (const i of r.imports.slice(0, 20)) lines.push(`- ${i.path || i}`);
  }
  if (r.imported_by && r.imported_by.length > 0) {
    lines.push('\n## Downstream (imported by)');
    for (const i of r.imported_by.slice(0, 20)) lines.push(`- ${i.path || i}`);
  }
  if (r.routes_in_file && r.routes_in_file.length > 0) {
    lines.push('\n## Routes in file');
    for (const rt of r.routes_in_file) lines.push(`- ${rt.method} ${rt.path}`);
  }
  if (r.env_vars && r.env_vars.length > 0) {
    lines.push('\n## Env vars');
    lines.push(r.env_vars.slice(0, 20).join(', '));
  }
  return lines.join('\n');
}

function formatInterfaceContract(r) {
  const lines = [`# Interface Contract: ${r.file || ''}`];
  lines.push(`\n- **Domain:** ${r.domain || '—'}`);
  if (r.exports && r.exports.length > 0) {
    lines.push('\n## Exports');
    lines.push('| Name | Kind | Default? |');
    lines.push('|------|------|---------:|');
    for (const e of r.exports) {
      lines.push(`| ${e.name} | ${e.kind} | ${e.is_default_export ? 'yes' : 'no'} |`);
    }
  }
  if (r.routes && r.routes.length > 0) {
    lines.push('\n## Routes');
    for (const rt of r.routes) lines.push(`- ${rt.method} ${rt.path}`);
  }
  if (r.models && r.models.length > 0) {
    lines.push('\n## Models');
    for (const m of r.models) lines.push(`- ${m.name} (${m.kind})`);
  }
  return lines.join('\n');
}

function formatExplainChange(r) {
  return `# Diff Explanation\n\n${r.summary || '(no summary)'}\n`;
}

function formatStaleDocs(r) {
  const lines = ['# Stale Docs'];
  if (!r.stale || r.stale.length === 0) {
    lines.push('\n_All docs are fresh (none older than 30 days)._');
    return lines.join('\n');
  }
  lines.push(`\n${r.stale.length} doc(s) older than 30 days.\n`);
  lines.push('| Path | Age (days) |');
  lines.push('|------|----------:|');
  for (const d of r.stale.slice(0, 30)) lines.push(`| ${d.path} | ${d.age_days} |`);
  return lines.join('\n');
}

function formatDependencySurface(r) {
  const lines = ['# Dependency Surface'];
  lines.push(`\n${r.count || (r.deps ? r.deps.length : 0)} dependencies detected.\n`);
  if (!r.deps || r.deps.length === 0) {
    lines.push('_No dependency manifest found._');
    return lines.join('\n');
  }
  lines.push('| Ecosystem | Name | Version | Kind |');
  lines.push('|-----------|------|---------|------|');
  for (const d of r.deps.slice(0, 50)) {
    lines.push(`| ${d.ecosystem} | ${d.name} | ${d.version} | ${d.kind} |`);
  }
  if (r.deps.length > 50) lines.push(`\n_…${r.deps.length - 50} more._`);
  return lines.join('\n');
}

function formatUpgradeRisk(r) {
  const lines = ['# Upgrade Risk'];
  if (!r.risks || r.risks.length === 0) {
    lines.push('\n_No usage data — likely no imports map to declared deps._');
    return lines.join('\n');
  }
  lines.push(`\nUsage counts across the import graph.\n`);
  lines.push('| Risk | Name | Version | Usages | Domains |');
  lines.push('|------|------|---------|-------:|--------:|');
  for (const x of r.risks.slice(0, 40)) {
    lines.push(`| ${x.risk} | ${x.name} | ${x.version} | ${x.count} | ${x.domains} |`);
  }
  return lines.join('\n');
}

/**
 * runAdjacentTool(name, args) — dispatcher for the adjacent-positioning tools.
 *
 * Handles cross-language call graph, IaC scan, runtime fusion, semantic
 * diff, and LLM enrichment stub. Runtime tools accept an `otlp_path`
 * argument; when missing, they degrade to the static-only signal.
 */
function runAdjacentTool(name, args) {
  const s = getStore();
  if (!s) return notIndexed();
  try {
    if (name === 'get_cross_language_call_graph') {
      const { buildCallGraph } = require('../adjacent/call-graph');
      const r = buildCallGraph({ store: s, projectRoot });
      return text(formatCallGraph(r));
    }
    if (name === 'get_iac_resources') {
      const { scanIacResources } = require('../adjacent/iac');
      const resources = scanIacResources(projectRoot);
      return text(formatIacResources(resources));
    }
    if (name === 'ingest_otlp_traces') {
      if (!args.path) return text('Missing required argument: path');
      const { parseOtlpFile } = require('../adjacent/runtime');
      const counts = parseOtlpFile(args.path);
      const lines = [`# OTLP Trace Ingest: ${args.path}`];
      lines.push(`\n${counts.length} unique (method, route) tuples observed.\n`);
      if (counts.length > 0) {
        lines.push('| Method | Route | Count |');
        lines.push('|--------|-------|------:|');
        counts.slice(0, 50).forEach(c => lines.push(`| ${c.method} | ${c.path} | ${c.count} |`));
      }
      return text(lines.join('\n'));
    }
    if (name === 'get_risk_weighted_blast_radius') {
      const { parseOtlpFile, riskWeightedBlastRadius } = require('../adjacent/runtime');
      const runtime = args.otlp_path ? parseOtlpFile(args.otlp_path) : [];
      const r = riskWeightedBlastRadius({ store: s, runtimeCounts: runtime });
      return text(formatRiskBlast(r));
    }
    if (name === 'get_dead_code_with_confidence') {
      const { parseOtlpFile, deadCodeWithConfidence } = require('../adjacent/runtime');
      const runtime = args.otlp_path ? parseOtlpFile(args.otlp_path) : null;
      const r = deadCodeWithConfidence({ store: s, runtimeCounts: runtime });
      return text(formatDeadCode(r, runtime != null));
    }
    if (name === 'get_hot_in_prod_no_tests') {
      const { parseOtlpFile, hotInProdNoTests } = require('../adjacent/runtime');
      const runtime = parseOtlpFile(args.otlp_path);
      const r = hotInProdNoTests({ store: s, projectRoot, runtimeCounts: runtime });
      return text(formatHotNoTests(r));
    }
    if (name === 'get_semantic_diff') {
      const { semanticDiff } = require('../adjacent/semantic-diff');
      const r = semanticDiff({ store: s, diff: args.diff });
      return text(formatSemanticDiff(r));
    }
    if (name === 'get_llm_enrichment') {
      const llm = require('../adjacent/llm-enrich');
      if (!llm.isAvailable(projectRoot)) {
        return text(`# LLM Enrichment\n\n_Disabled. Opt in via \`carto.config.json\` → \`ai.llm\`. Currently a stub._`);
      }
      const r = llm.enrichNode(args.file);
      return text(`# LLM Enrichment: ${args.file}\n\n${r ? JSON.stringify(r, null, 2) : '_no summary_'}`);
    }
    return text(`Unknown adjacent tool: ${name}`);
  } catch (err) {
    return text(`Error in ${name}: ${err.message || err}`);
  }
}

function formatCallGraph(r) {
  const lines = ['# Cross-Language Call Graph'];
  lines.push(`\n- **Total fetches seen:** ${r.total_fetches_seen}`);
  lines.push(`- **Matched callers ↔ routes:** ${r.matches.length}`);
  lines.push(`- **Unmatched fetches:** ${r.unmatched_fetches.length}\n`);
  if (r.matches.length > 0) {
    lines.push('| Caller | Method | Route | Handler file |');
    lines.push('|--------|--------|-------|--------------|');
    for (const m of r.matches.slice(0, 50)) {
      lines.push(`| ${m.caller_file} | ${m.method} | ${m.route_path} | ${m.callee_file} |`);
    }
    if (r.matches.length > 50) lines.push(`\n_…${r.matches.length - 50} more matches._`);
  }
  return lines.join('\n');
}

function formatIacResources(resources) {
  const lines = ['# IaC Resources'];
  lines.push(`\n${resources.length} resource(s) detected.\n`);
  if (resources.length === 0) {
    lines.push('_No Terraform / Helm / Pulumi / CDK files found._');
    return lines.join('\n');
  }
  const byKind = new Map();
  for (const r of resources) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }
  for (const [kind, items] of byKind) {
    lines.push(`\n## ${kind} (${items.length})`);
    for (const x of items.slice(0, 30)) {
      const type = x.tf_type ? ` · ${x.tf_type}` : '';
      lines.push(`- **${x.name}**${type} (${x.file})${x.dependencies && x.dependencies.length > 0 ? ` — deps: ${x.dependencies.slice(0, 3).join(', ')}` : ''}`);
    }
    if (items.length > 30) lines.push(`  _…${items.length - 30} more._`);
  }
  return lines.join('\n');
}

function formatRiskBlast(rows) {
  const lines = ['# Risk-Weighted Blast Radius'];
  if (!rows || rows.length === 0) {
    lines.push('\n_No routes found._');
    return lines.join('\n');
  }
  lines.push(`\n${rows.length} route(s); sorted by risk_score = dependents × runtime_calls + dependents.\n`);
  lines.push('| Method | Route | File | Dependents | Runtime hits | Score |');
  lines.push('|--------|-------|------|----------:|-------------:|------:|');
  for (const r of rows.slice(0, 30)) {
    lines.push(`| ${r.method} | ${r.path} | ${r.file} | ${r.dependents} | ${r.runtime_calls} | ${r.risk_score} |`);
  }
  return lines.join('\n');
}

function formatDeadCode(rows, hasRuntime) {
  const lines = ['# Dead Code (with confidence)'];
  if (!rows || rows.length === 0) {
    lines.push('\n_No orphaned files detected._');
    return lines.join('\n');
  }
  lines.push(`\n${rows.length} file(s) with no static dependents${hasRuntime ? ' AND no runtime hits' : ''}.\n`);
  lines.push('| File | Runtime hit |');
  lines.push('|------|------------:|');
  for (const r of rows.slice(0, 40)) {
    lines.push(`| ${r.path} | ${r.runtime_hit === null ? '—' : r.runtime_hit} |`);
  }
  return lines.join('\n');
}

function formatHotNoTests(rows) {
  const lines = ['# Hot in Prod, No Tests'];
  if (!rows || rows.length === 0) {
    lines.push('\n_No untested files with runtime hits found._');
    return lines.join('\n');
  }
  lines.push(`\n${rows.length} file(s).\n`);
  for (const r of rows.slice(0, 40)) lines.push(`- ${r.path}`);
  return lines.join('\n');
}

function formatSemanticDiff(r) {
  const lines = ['# Semantic Diff'];
  lines.push(`\n- **Files changed:** ${r.files_changed}`);
  lines.push(`- **New files:** ${r.new_files.length}`);
  lines.push(`- **Deleted files:** ${r.deleted_files.length}`);
  if (r.renames && r.renames.length > 0) {
    lines.push('\n## Renames detected');
    for (const x of r.renames) lines.push(`- ${x.file}: \`${x.from}\` → \`${x.to}\``);
  }
  if (r.relocations && r.relocations.length > 0) {
    lines.push('\n## Symbol relocations');
    for (const x of r.relocations) lines.push(`- \`${x.symbol}\`: ${x.from_file} → ${x.to_file}`);
  }
  if (r.new_domains && r.new_domains.length > 0) {
    lines.push('\n## New domain prefixes');
    for (const x of r.new_domains) lines.push(`- ${x}/`);
  }
  return lines.join('\n');
}

/**
 * runPredictiveTool(name, args) — dispatcher for the predictive tools.
 */
function runPredictiveTool(name, args) {
  const s = getStore();
  if (!s) return notIndexed();
  const { TemporalStore } = require('../temporal/store');
  const temporalStore = TemporalStore.openIfExists(projectRoot, { readonly: true });
  try {
    if (name === 'get_predictive_risk') {
      const { scoreFiles } = require('../predictive/risk-score');
      const filesArg = args.file ? [args.file] : null;
      const r = scoreFiles({ store: s, temporalStore, projectRoot, files: filesArg });
      return text(formatRiskScores(r));
    }
    if (name === 'get_microservice_cut_points') {
      const { findCutPoints } = require('../predictive/cut-points');
      const r = findCutPoints({ store: s, threshold: args.threshold || 0.7 });
      return text(formatCutPoints(r));
    }
    if (name === 'validate_change') {
      const { validateChange } = require('../predictive/validate-change');
      const r = validateChange({ store: s, projectRoot, file: args.file, content: args.content });
      return text(formatValidateChange(r));
    }
    if (name === 'get_file_ownership') {
      const { ownersForFile } = require('../predictive/ownership');
      const r = ownersForFile({ projectRoot, file: args.file });
      return text(formatOwnership(r));
    }
    if (name === 'get_cross_team_coupling') {
      const { crossTeamCoupling } = require('../predictive/ownership');
      const r = crossTeamCoupling({ store: s, projectRoot });
      return text(formatCrossTeamCoupling(r));
    }
    if (name === 'get_drift_digest') {
      const { renderDriftDigest } = require('../predictive/drift-digest');
      return text(renderDriftDigest({ store: s, temporalStore, projectRoot, timeRange: args.time_range || '7d' }));
    }
    if (name === 'get_ai_cost_attribution') {
      const { aiCostAttribution } = require('../predictive/ownership');
      const r = aiCostAttribution({ store: s, hours: args.hours || 168 });
      return text(formatAiCost(r));
    }
    return text(`Unknown predictive tool: ${name}`);
  } finally {
    if (temporalStore) temporalStore.close();
  }
}

function formatRiskScores(rows) {
  const lines = ['# Predictive Risk'];
  if (!rows || rows.length === 0) {
    lines.push('\n_No files scored._');
    return lines.join('\n');
  }
  lines.push(`\nTop ${Math.min(rows.length, 30)} of ${rows.length} files by P(incident) score.\n`);
  lines.push('| File | Score | Blast | Churn | Cross | IV | NoTest |');
  lines.push('|------|------:|------:|------:|------:|---:|-------:|');
  for (const r of rows.slice(0, 30)) {
    const c = r.components || {};
    lines.push(`| ${r.path} | ${r.score} | ${(c.blast || 0).toFixed(2)} | ${(c.churn || 0).toFixed(2)} | ${c.cross || 0} | ${(c.intervention || 0).toFixed(2)} | ${c.no_test || 0} |`);
  }
  return lines.join('\n');
}

function formatCutPoints(r) {
  const lines = ['# Microservice Cut-Points'];
  if (!r.all_domains || r.all_domains.length === 0) {
    lines.push('\n_No domain data._');
    return lines.join('\n');
  }
  if (r.cut_points && r.cut_points.length > 0) {
    lines.push(`\n## Candidates (${r.cut_points.length})`);
    lines.push('| Domain | Files | Cohesion | Intra | Out | In |');
    lines.push('|--------|------:|---------:|------:|----:|---:|');
    for (const d of r.cut_points) {
      lines.push(`| ${d.domain} | ${d.files} | ${d.cohesion} | ${d.intra_edges} | ${d.outbound_edges} | ${d.inbound_edges} |`);
    }
  } else {
    lines.push('\n_No high-cohesion domains pass the candidate threshold._');
  }
  lines.push('\n## All domains');
  lines.push('| Domain | Files | Cohesion | Candidate? |');
  lines.push('|--------|------:|---------:|:----------:|');
  for (const d of r.all_domains) {
    lines.push(`| ${d.domain} | ${d.files} | ${d.cohesion} | ${d.candidate ? '✅' : '—'} |`);
  }
  return lines.join('\n');
}

function formatValidateChange(r) {
  const lines = ['# validate_change'];
  lines.push(`\n- **Risk:** ${r.risk}`);
  if (r.reason) lines.push(`- **Reason:** ${r.reason}`);
  if (r.files_changed && r.files_changed.length > 0) {
    lines.push(`- **Files:** ${r.files_changed.join(', ')}`);
  }
  if (r.violations && r.violations.length > 0) {
    lines.push('\n## Violations');
    for (const v of r.violations.slice(0, 10)) {
      lines.push(`- **${v.severity}** ${v.kind}: ${v.detail || v.file || ''}`);
    }
  }
  if (r.suggestions && r.suggestions.length > 0) {
    lines.push('\n## Suggestions');
    for (const s of r.suggestions) lines.push(`- ${s}`);
  }
  return lines.join('\n');
}

function formatOwnership(r) {
  const lines = [`# Ownership: ${r.file || ''}`];
  lines.push(`\n- **Top author:** ${r.top_author || '—'}`);
  if (r.authors && r.authors.length > 0) {
    lines.push('| Author | Lines |');
    lines.push('|--------|------:|');
    for (const a of r.authors.slice(0, 20)) lines.push(`| ${a.name} | ${a.lines} |`);
  } else {
    lines.push('\n_No blame data available (git missing or file not tracked)._');
  }
  return lines.join('\n');
}

function formatCrossTeamCoupling(r) {
  const lines = ['# Cross-Team Coupling'];
  if (!r.warnings || r.warnings.length === 0) {
    lines.push('\n_No cross-team coupling warnings._');
    return lines.join('\n');
  }
  lines.push(`\n${r.warnings.length} coordination warning(s).\n`);
  lines.push('| From file | From owner | To file | To owner |');
  lines.push('|-----------|------------|---------|----------|');
  for (const w of r.warnings.slice(0, 30)) {
    lines.push(`| ${w.from_file} | ${w.from_owner} | ${w.to_file} | ${w.to_owner} |`);
  }
  return lines.join('\n');
}

function formatAiCost(r) {
  const lines = [`# AI Cost Attribution (${r.hours}h)`];
  if (!r.clients || r.clients.length === 0) {
    lines.push('\n_No AI session data in window._');
    return lines.join('\n');
  }
  lines.push(`\n${r.clients.length} client(s).\n`);
  lines.push('| Client | Decisions | Violations |');
  lines.push('|--------|----------:|----------:|');
  for (const c of r.clients) {
    lines.push(`| ${c.client} | ${c.decisions} | ${c.violations} |`);
  }
  return lines.join('\n');
}

/**
 * runOrgTool(name, args) — dispatcher for the cross-repo / org-wide tools.
 *
 * Opens `~/.carto/org.db` read+write so any future tool that needs to
 * persist (none currently) doesn't have to switch modes. Returns a
 * graceful "no org" message when the org store is missing.
 */
function runOrgTool(name, args) {
  const { OrgStore } = require('../org/store');
  const orgStore = OrgStore.openIfExists();
  if (!orgStore) {
    return text(`# Org tool: ${name}\n\nNo org store yet. Run \`carto org init\` then \`carto org add <name> <path>\` then \`carto org sync\` to register repos.`);
  }
  try {
    const q = require('../org/queries');
    if (name === 'get_org_architecture') {
      return text(formatOrgArchitecture(q.orgArchitectureOverview(orgStore)));
    }
    if (name === 'get_service_dependency_graph') {
      return text(formatServiceGraph(q.serviceDependencyGraph(orgStore)));
    }
    if (name === 'get_cross_repo_blast_radius') {
      return text(formatCrossRepoBlast(q.crossRepoBlastRadius(orgStore, args.repo)));
    }
    if (name === 'find_consumers_of_api') {
      return text(formatConsumers(q.findConsumersOfApi(orgStore, args.target), args.target));
    }
    if (name === 'get_org_domain_mapping') {
      return text(formatOrgDomainMapping(q.orgDomainMapping(orgStore)));
    }
    if (name === 'get_service_boundary_violations') {
      return text(formatBoundaryViolations(q.serviceBoundaryViolations(orgStore)));
    }
    if (name === 'get_microservices_migration_cut_points') {
      return text(formatMigrationCutPoints(q.microservicesMigrationCutPoints(orgStore)));
    }
    return text(`Unknown org tool: ${name}`);
  } finally {
    orgStore.close();
  }
}

function formatOrgArchitecture(o) {
  const lines = ['# Org Architecture'];
  lines.push(`\n- **Repos:** ${o.summary.total_repos}`);
  lines.push(`- **Cross-repo edges:** ${o.summary.total_edges}`);
  if (o.summary.edges_by_kind && o.summary.edges_by_kind.length > 0) {
    lines.push('\n## Edges by kind');
    for (const e of o.summary.edges_by_kind) lines.push(`- ${e.edge_kind}: ${e.c}`);
  }
  if (o.repos && o.repos.length > 0) {
    lines.push('\n## Repos');
    lines.push('| Name | Root | Last sync |');
    lines.push('|------|------|-----------|');
    for (const r of o.repos) {
      const ls = r.last_sync_at ? new Date(r.last_sync_at).toISOString() : '—';
      lines.push(`| ${r.name} | ${r.root_path} | ${ls} |`);
    }
  }
  return lines.join('\n');
}

function formatServiceGraph(g) {
  const lines = ['# Service Dependency Graph'];
  lines.push(`\n${g.nodes.length} repo(s); ${g.edges.length} aggregated edge(s).`);
  if (g.edges.length === 0) {
    lines.push('\n_No resolved cross-repo edges yet._');
    return lines.join('\n');
  }
  lines.push('\n| From | To | Kind | Count |');
  lines.push('|------|----|------|------:|');
  for (const e of g.edges) lines.push(`| ${e.from_repo} | ${e.to_repo} | ${e.edge_kind} | ${e.count} |`);
  return lines.join('\n');
}

function formatCrossRepoBlast(r) {
  const lines = ['# Cross-Repo Blast Radius'];
  if (!r.downstream_repos || r.downstream_repos.length === 0) {
    lines.push('\n_No downstream consumers._');
    return lines.join('\n');
  }
  lines.push(`\nDownstream consumers (${r.downstream_repos.length}):`);
  for (const r2 of r.downstream_repos) lines.push(`- ${r2}`);
  if (r.paths && r.paths.length > 0) {
    lines.push('\n## Edge breakdown');
    lines.push('| Consumer | Kind | Count |');
    lines.push('|----------|------|------:|');
    for (const p of r.paths) lines.push(`| ${p.from_repo} | ${p.edge_kind} | ${p.count} |`);
  }
  return lines.join('\n');
}

function formatConsumers(rows, target) {
  const lines = [`# Consumers of ${target || ''}`];
  if (!rows || rows.length === 0) { lines.push('\n_No consumers found._'); return lines.join('\n'); }
  lines.push(`\n${rows.length} consuming file(s).\n`);
  lines.push('| Repo | Kind | File |');
  lines.push('|------|------|------|');
  for (const r of rows.slice(0, 50)) lines.push(`| ${r.from_repo} | ${r.edge_kind} | ${r.from_file || '—'} |`);
  return lines.join('\n');
}

function formatOrgDomainMapping(o) {
  const lines = ['# Org Domain Mapping'];
  if (!o.domains || o.domains.length === 0) {
    lines.push('\n_No domains found across org repos. Ensure each repo has been `carto sync`-ed first._');
    return lines.join('\n');
  }
  lines.push(`\n${o.domains.length} repo×domain entries.\n`);
  lines.push('| Repo | Domain | Files |');
  lines.push('|------|--------|------:|');
  for (const d of o.domains) lines.push(`| ${d.repo} | ${d.domain} | ${d.file_count} |`);
  return lines.join('\n');
}

function formatBoundaryViolations(o) {
  const lines = ['# Service Boundary Violations'];
  if (!o.violations || o.violations.length === 0) {
    lines.push('\n_No boundary violations detected._');
    return lines.join('\n');
  }
  lines.push(`\n${o.violations.length} edge(s) reach into private surface.\n`);
  lines.push('| From repo | Target | Kind | File |');
  lines.push('|-----------|--------|------|------|');
  for (const v of o.violations.slice(0, 50)) lines.push(`| ${v.from_repo} | ${v.target} | ${v.edge_kind} | ${v.from_file || '—'} |`);
  return lines.join('\n');
}

function formatMigrationCutPoints(o) {
  const lines = ['# Microservices Migration Cut-Points'];
  if (!o.order || o.order.length === 0) {
    lines.push('\n_No repos registered._');
    return lines.join('\n');
  }
  lines.push(`\nExtraction priority (high stability first; the producer repos to extract before their consumers):\n`);
  lines.push('| Repo | Incoming | Outgoing | Stability |');
  lines.push('|------|---------:|---------:|----------:|');
  for (const r of o.order) lines.push(`| ${r.repo} | ${r.incoming} | ${r.outgoing} | ${r.stability} |`);
  return lines.join('\n');
}

/**
 * parseTimeRange("7d" | "24h" | "1h" | "30m" | "60s") → ms | null
 *
 * Small parser for the `get_recent_decisions` time_range arg.
 * Returns null on malformed input so the caller can surface a clear
 * error message instead of silently treating "auth" as 0ms.
 */
function parseTimeRange(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  const m = s.trim().match(/^(\d+)\s*([smhdw])?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] || 'd').toLowerCase();
  const mult = unit === 's' ? 1000 :
               unit === 'm' ? 60_000 :
               unit === 'h' ? 3_600_000 :
               unit === 'd' ? 86_400_000 :
               unit === 'w' ? 604_800_000 : null;
  if (mult === null) return null;
  return n * mult;
}

/**
 * summarizeDecisionPayload(json) → short string
 *
 * Renders a one-line summary of a `decisions.payload_json` row for the
 * Markdown tables. Defensive against missing/malformed JSON — never
 * throws, never echoes raw payload bytes.
 */
function summarizeDecisionPayload(json) {
  if (!json) return '—';
  let obj;
  try { obj = JSON.parse(json); } catch { return '_(unparseable payload)_'; }
  if (!obj || typeof obj !== 'object') return '—';
  const parts = [];
  if (obj.risk) parts.push(`risk=${obj.risk}`);
  if (typeof obj.violationCount === 'number') parts.push(`violations=${obj.violationCount}`);
  if (typeof obj.blastUnion === 'number') parts.push(`blast=${obj.blastUnion}`);
  if (Array.isArray(obj.files) && obj.files.length > 0) {
    parts.push(`files=${obj.files.length === 1 ? obj.files[0] : `${obj.files.length}`}`);
  }
  return parts.length === 0 ? '—' : parts.join(', ');
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  { name: 'get_routes', description: 'Get all API routes in this project including REST, tRPC, and webhooks.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_blast_radius', description: 'Get all files, routes, and domains affected by changing a specific file. Includes risk level per route.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path from project root' } }, required: ['file'] } },
  { name: 'get_structure', description: 'Get project structure: import graph, entry points, high impact files, tech stack, and domains.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_domain', description: 'Get all routes, models, functions, and context for a specific domain (AUTH, PAYMENTS, TRPC, DATABASE, EVENTS, NOTIFICATIONS, CORE).', inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Domain name e.g. AUTH, PAYMENTS, DATABASE' } }, required: ['domain'] } },
  { name: 'get_neighbors', description: 'Get import graph neighbors of a file — files it imports and files that import it. Returns nodes and edges for visualization.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path from project root' }, hops: { type: 'number', description: 'How many hops to traverse (default 1, max 3)' } }, required: ['file'] } },
  { name: 'get_cross_domain', description: 'Get all import edges that cross domain boundaries — e.g. AUTH importing PAYMENTS. Use to detect unexpected coupling.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_context', description: 'Get full structural context for a file: domain, blast radius, import neighbors, routes, models, env vars, and cross-domain dependencies. Single call for everything.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path from project root' } }, required: ['file'] } },
  { name: 'search_routes', description: 'Search API routes by path or method. Case-insensitive.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query e.g. "auth", "POST", "/api/users"' } }, required: ['query'] } },
  { name: 'get_models', description: 'Get all data models (Prisma, Pydantic, TypeScript interfaces, Zod schemas) across the project, optionally filtered by domain.', inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Optional domain filter e.g. AUTH, DATABASE' } }, required: [] } },
  { name: 'get_high_impact_files', description: 'Get the files with the highest blast radius — most other files depend on them. Changing these files is highest risk.', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Number of files to return (default 10)' } }, required: [] } },
  { name: 'get_env_vars', description: 'Get all environment variables used in this project, with which files use them and which domains they belong to.', inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Optional domain filter e.g. AUTH, PAYMENTS' } }, required: [] } },
  { name: 'get_domains_list', description: 'Get all detected domains with file counts, route counts, and model counts.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_architecture', description: 'Get a 500-word markdown summary of the project: domains, entry points, tech stack, key patterns, and size metrics. Use this as your first call when entering a new repo.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_file_summary', description: 'Get a 3-sentence description of what a file does, its role in the project, and its key dependencies and dependents.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path from project root' } }, required: ['file'] } },
  { name: 'get_change_plan', description: 'Given a natural-language intent (e.g. "add rate limiting to /api/users"), returns: files to touch, domains affected, blast radius, and similar patterns in the codebase.', inputSchema: { type: 'object', properties: { intent: { type: 'string', description: 'Natural language description of the change you want to make' } }, required: ['intent'] } },
  { name: 'get_similar_patterns', description: 'Given a file, find structurally similar files — same import pattern, same route shape, or same domain. Use to find conventions to follow before writing new code.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path from project root' }, limit: { type: 'number', description: 'Max results to return (default 5)' } }, required: ['file'] } },
  { name: 'simulate_change_impact', description: 'Given a list of files, returns all files transitively affected by changing them simultaneously, with hop distance. Powered by the bitmap engine — only feasible at this speed (sub-millisecond) with bitmap OR-aggregation. Use when planning a refactor that touches multiple files.', inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: 'Array of relative file paths from project root' } }, required: ['files'] } },
  // ─── Validation API + Episodic Memory ─────────────────────────────
  { name: 'validate_diff', description: 'Given a unified diff, returns: violations (cross-domain imports, high-blast files), blast radius per file, risk level (SAFE/LOW/MEDIUM/HIGH), and suggestions. Sub-15ms p99 on a 7K-file repo. Each call is recorded in the episodic memory log so other tools can ask "did we discuss this?".', inputSchema: { type: 'object', properties: { diff: { type: 'string', description: 'Unified diff text (output of `git diff` / GitHub PR patch).' }, session_id: { type: 'number', description: 'Optional session id. Defaults to the most recent active session, or a fresh one.' } }, required: ['diff'] } },
  { name: 'get_recent_decisions', description: 'List recent validation decisions and architectural choices the AI has made in this project. Returns time-descending rows.', inputSchema: { type: 'object', properties: { time_range: { type: 'string', description: 'Time window like "7d", "24h", "1h" (default "7d").' }, kind: { type: 'string', description: 'Optional filter — e.g. "validation".' } }, required: [] } },
  { name: 'get_session_context', description: 'Full context for an AI session: every decision and every intervention, ordered chronologically. Use to recap what happened in a long-running session.', inputSchema: { type: 'object', properties: { session_id: { type: 'number', description: 'Session id. Defaults to the most recent active session.' } }, required: [] } },
  { name: 'did_we_discuss_this', description: 'Substring search over the episodic memory log (decisions + interventions) for prior discussions of a topic. Use to avoid re-deciding settled questions.', inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'Topic to search for, e.g. "auth", "snake_case", "blast radius".' } }, required: ['topic'] } },
  { name: 'get_intervention_history', description: 'List interventions (Carto-issued violations and suggestions) optionally filtered by file. Use to see prior warnings on a file before editing it.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Optional file filter (relative path from project root).' } }, required: [] } },

  // ─── Rule engine: gap detection ─────────────────────────────────
  { name: 'get_gaps', description: 'The current gap list for this repo — grounded findings from the rule engine ("SHOULD − IS"). Each gap ties to a file + rule_id + evidence. Ranked HIGH > MEDIUM > LOW. Dismissed gaps are excluded by default. Call this when the user asks "what should I fix?", when you enter a new repo for the first time, or before recommending changes to a file. If the response is empty and the project is unsupported, tell the user the rule engine only ships for Next.js + Supabase SaaS-with-auth today.', inputSchema: { type: 'object', properties: { rule_id: { type: 'string', description: 'Optional rule filter, e.g. "money-as-float".' }, file: { type: 'string', description: 'Optional file filter.' }, severity: { type: 'string', description: 'Optional severity filter: HIGH | MEDIUM | LOW.' }, include_dismissed: { type: 'boolean', description: 'Include gaps the user has already dismissed (default false).' }, refresh: { type: 'boolean', description: 'Re-run the rule engine before returning (default false — uses last cached run).' } }, required: [] } },
  { name: 'dismiss_gap', description: 'Mark a specific gap as intentional. Writes the dismissal to the gaps table so the same gap does not re-surface on the next run. Idempotent — re-dismissing updates the reason. Only call this when the user explicitly says the gap is intentional; never dismiss on your own judgment.', inputSchema: { type: 'object', properties: { gap_hash: { type: 'string', description: 'The gap_hash from get_gaps output.' }, reason: { type: 'string', description: 'Short explanation of why this gap is intentional. Optional but strongly encouraged.' } }, required: ['gap_hash'] } },
  { name: 'set_intent', description: 'Capture a user-stated intent about this project — product type, stack, or a scope note ("single-user for now"). Product-type gates every rule in the rule engine, so calling this correctly is how the AI unlocks (or narrows) gap detection. Notes accumulate — this tool never overwrites prior notes, only appends.', inputSchema: { type: 'object', properties: { product_type: { type: 'string', description: 'The product classification, e.g. "saas-with-auth" or "unsupported".' }, stack: { type: 'array', items: { type: 'string' }, description: 'Optional explicit stack list, e.g. ["Next.js", "Supabase"]. Replaces the auto-detected stack.' }, note: { type: 'string', description: 'A single scope statement from the user. Timestamped and appended to the notes array.' } }, required: [] } },
  { name: 'get_intent', description: 'Return the currently stored intent — product type, stack, notes, updated_at. Use this at the start of a session to know which rules will apply to this project.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_file_receipts', description: 'For one file, returns receipts — everything Carto knows: change history, blast radius, prior interventions and decisions touching this file, active gaps on this file, cross-domain deps. Read-only. Use before proposing a change to a file to understand what depends on it and what has been said about it before.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path from project root.' } }, required: ['file'] } },

  // ─── Temporal layer ─────────────────────────────────────────────
  { name: 'get_architectural_drift', description: 'Per-domain growth/shrink and event count over a time window. Run `carto temporal init` first to backfill from git history.', inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Optional domain filter (e.g. AUTH).' }, time_range: { type: 'string', description: 'Window like "30d", "90d", "1y" (default "30d").' } }, required: [] } },
  { name: 'get_domain_evolution', description: 'Time-series of a single domain\'s file count, by snapshot. Use to chart a domain\'s growth over the last quarter.', inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Domain name (e.g. AUTH).' }, time_range: { type: 'string', description: 'Window like "30d", "90d" (default "90d").' } }, required: ['domain'] } },
  { name: 'get_hotspot_files', description: 'Top files by churn × blast_radius score over a window. The CodeHealth heuristic: high-churn files in high-blast-radius positions are where bugs cluster.', inputSchema: { type: 'object', properties: { time_range: { type: 'string', description: 'Window like "30d", "90d" (default "90d").' }, limit: { type: 'number', description: 'Max rows (default 20).' } }, required: [] } },
  { name: 'get_complexity_trend', description: 'A single file\'s presence across snapshots + commit count + current blast_radius. Use to track how a file\'s footprint evolved.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path.' }, time_range: { type: 'string', description: 'Window like "90d" (default "90d").' } }, required: ['file'] } },
  { name: 'get_churn_vs_blast_radius', description: 'Scatter data of churn vs blast_radius for every changed file in a window. Use to find risk hotspots.', inputSchema: { type: 'object', properties: { time_range: { type: 'string', description: 'Window like "90d" (default "90d").' } }, required: [] } },
  { name: 'get_arch_events', description: 'Architectural events (domain split, merge, growth, hotspot emergence). Severity filter: minor | major | critical.', inputSchema: { type: 'object', properties: { severity: { type: 'string', description: 'Filter: minor | major | critical.' }, kind: { type: 'string', description: 'Optional kind filter (e.g. domain_growth, hotspot_active).' }, time_range: { type: 'string', description: 'Window like "90d" (default "90d").' } }, required: [] } },
  { name: 'get_domain_health', description: 'Per-domain growth rate, instability, recent events, and hotspot files. Use to spot domains drifting out of bounds.', inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Optional domain filter.' } }, required: [] } },
  { name: 'get_temporal_context', description: 'A file\'s full temporal context: first_seen_ts, last_modified_ts, commit_count, blast_radius, recent events, age in days.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path.' } }, required: ['file'] } },

  // ─── Brain: semantic + procedural + working memory ──────────────
  { name: 'get_invariants', description: 'Architectural invariants mined from the import graph: "Domain X never imports from Y", "Files in Z always export N symbols", etc. Confidence-scored.', inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Optional domain filter.' }, threshold: { type: 'number', description: 'Confidence threshold 0-1 (default 0.85).' } }, required: [] } },
  { name: 'get_canonical_pattern', description: 'Highest-quality example of a pattern in the codebase (e.g. canonical route handler). Use as a copy-paste template before writing similar code.', inputSchema: { type: 'object', properties: { pattern_type: { type: 'string', description: 'route_handler | model_definition' }, domain: { type: 'string', description: 'Optional domain filter.' } }, required: ['pattern_type'] } },
  { name: 'get_conventions', description: 'Naming + export + directory conventions that apply to a given file or directory. Confidence-scored. Use before writing new code in this location.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path or directory.' } }, required: [] } },
  { name: 'get_action_patterns', description: 'Procedural patterns mined from git history: "when developers add X, they also touch Y". Filter by natural-language intent.', inputSchema: { type: 'object', properties: { intent: { type: 'string', description: 'Optional intent filter (e.g. "add route").' } }, required: [] } },
  { name: 'scaffold_for_intent', description: 'For a natural-language intent ("add a payment route"), returns: anchor file + co-changed files + canonical pattern + conventions to follow. Combines invariants, conventions, and procedural memory.', inputSchema: { type: 'object', properties: { intent: { type: 'string', description: 'Natural-language description of the change.' } }, required: ['intent'] } },
  { name: 'get_working_memory', description: 'Live state snapshot: branch, HEAD, uncommitted files, recent decision count, open HIGH-severity warnings, recent drift. Read this at the start of every AI session.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_pending_decisions', description: 'Recent decisions with pending/unresolved/HIGH-risk flags in their payload. Surfaces unfinished AI work from the episodic log.', inputSchema: { type: 'object', properties: { hours: { type: 'number', description: 'Lookback window in hours (default 6).' } }, required: [] } },
  { name: 'get_active_drift', description: 'Domains with active drift in the last 7d: growth, threshold breaches. Use to spot domains drifting before they reach a critical event.', inputSchema: { type: 'object', properties: { threshold: { type: 'number', description: 'Drift threshold 0-1 (default 0.2 = 20%).' } }, required: [] } },
  { name: 'get_active_suggestions', description: 'Active Suggestion Engine output. 4 triggers: cross-domain coupling jump, AI session conflict, convention violation mid-session, hotspot threshold crossed. Read periodically.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'dismiss_suggestion', description: 'Mark a suggestion ID as dismissed for the current session. Acknowledgment-only; the underlying signal still exists.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Suggestion id from get_active_suggestions.' } }, required: ['id'] } },

  // ─── AI-native primitives — 14 tools ────────────────────────────
  { name: 'get_minimal_context_for_intent', description: 'Token-budgeted context picker. Given a natural-language intent + a budget (default 4000 tokens), returns the minimum file set needed via hybrid retrieval (structural + lexical + semantic) with RRF fusion and high-blast / same-domain / recent-changes boosts. Reports per-file token cost.', inputSchema: { type: 'object', properties: { intent: { type: 'string', description: 'Natural-language description of the change.' }, budget_tokens: { type: 'number', description: 'Token budget (default 4000).' } }, required: ['intent'] } },
  { name: 'get_progressive_disclosure_tree', description: 'Pre-computed hierarchy: domain → top files per domain → per-file exports. Use as a structured table-of-contents for the codebase before drilling in.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_token_budget_report', description: 'Diagnostic complement to get_minimal_context_for_intent. Returns context efficiency as a fraction of repo size (used / total tokens approx).', inputSchema: { type: 'object', properties: { intent: { type: 'string', description: 'Intent to budget for.' }, budget_tokens: { type: 'number' } }, required: [] } },
  { name: 'get_decision_log', description: 'Recent decisions from the episodic-memory log, optionally annotated with concurrent architectural events from the temporal store.', inputSchema: { type: 'object', properties: { hours: { type: 'number', description: 'Lookback hours (default 168 = 7d).' } }, required: [] } },
  { name: 'get_evolution_delta', description: 'Architectural delta across a time window (requires temporal store). Returns per-domain before/after file counts + event count.', inputSchema: { type: 'object', properties: { domain: { type: 'string' }, time_range: { type: 'string', description: 'Window like "30d", "90d" (default "30d").' } }, required: [] } },
  { name: 'get_change_velocity', description: 'Commits-per-day over a window (requires temporal store). Useful for spotting development tempo shifts.', inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Lookback days (default 30).' } }, required: [] } },
  { name: 'get_test_coverage_map', description: 'Surfaces files with no detected test alongside their blast radius. High-blast untested files are the riskiest.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_safety_checklist', description: 'Per-file safety checklist: blast radius, cross-domain coupling, missing tests, temporal hotspot, unresolved interventions. Run before writing a high-impact change.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
  { name: 'get_data_flow', description: 'Per-file data-flow snapshot: upstream imports + downstream importers + routes + models + env vars in the file. The AI-friendly view, not full taint analysis.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
  { name: 'get_interface_contract', description: 'Exported symbols + models + routes the file exposes. Use to understand a module\'s public API before consuming it.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
  { name: 'explain_change_in_natural_language', description: 'Given a unified diff, returns a plain-language summary + risk + violation list + suggestions. Powered by validate_diff.', inputSchema: { type: 'object', properties: { diff: { type: 'string' } }, required: ['diff'] } },
  { name: 'get_stale_docs', description: 'Docs/markdown files older than 30 days. Heuristic surface for documentation that probably needs refresh.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_dependency_surface', description: 'Deduped external dependencies + pinned versions across package.json, pyproject.toml, go.mod, etc. The "what does this project depend on" view.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_upgrade_risk', description: 'Cross-references each external dep against the import graph. Returns usage count + domain count + LOW/MEDIUM/HIGH risk per dep. Use before bumping a dep version.', inputSchema: { type: 'object', properties: {}, required: [] } },

  // ─── Adjacent positioning — 8 tools ─────────────────────────────
  { name: 'get_cross_language_call_graph', description: 'Match frontend HTTP fetches (fetch / axios / jQuery) to backend route handlers. Returns caller→callee pairs across language boundaries.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_iac_resources', description: 'Surface Terraform / Helm / Pulumi / AWS CDK resources discovered in the repo. Returns kind, name, file, dependencies.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'ingest_otlp_traces', description: 'Parse an OpenTelemetry OTLP JSON/JSONL trace file and aggregate per-route hit counts. Use the resulting counts with get_risk_weighted_blast_radius.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to OTLP file' } }, required: ['path'] } },
  { name: 'get_risk_weighted_blast_radius', description: 'Combine static dependents with runtime call counts (from ingest_otlp_traces or similar) to rank routes by real-world risk. `risk = dependents × runtime_calls + dependents`.', inputSchema: { type: 'object', properties: { otlp_path: { type: 'string', description: 'Optional OTLP file for runtime data.' } }, required: [] } },
  { name: 'get_dead_code_with_confidence', description: 'Files with zero static dependents AND (when runtime data is supplied) zero observed runtime hits. The "safe to delete" list.', inputSchema: { type: 'object', properties: { otlp_path: { type: 'string', description: 'Optional OTLP file for runtime confirmation.' } }, required: [] } },
  { name: 'get_hot_in_prod_no_tests', description: 'Files whose routes receive >0 runtime hits but have no detected test file. The "ship a test here first" list.', inputSchema: { type: 'object', properties: { otlp_path: { type: 'string', description: 'Path to OTLP file (required).' } }, required: ['otlp_path'] } },
  { name: 'get_semantic_diff', description: 'Beyond line-by-line: detect renames, symbol relocations across files, and new-domain introductions from a unified diff.', inputSchema: { type: 'object', properties: { diff: { type: 'string', description: 'Unified diff text.' } }, required: ['diff'] } },
  { name: 'get_llm_enrichment', description: 'Per-node summary via a local LLM. Opt-in only; returns disabled stub until `ai.llm` is wired in carto.config.json.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },

  // ─── Predictive — 7 tools ───────────────────────────────────────
  { name: 'get_predictive_risk', description: 'Predictive risk score per file: P(this file causes the next incident). Combines blast radius, churn, cross-domain coupling, intervention history, test presence into a 0-1 score.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Optional single-file filter; otherwise scores all files.' } }, required: [] } },
  { name: 'get_microservice_cut_points', description: 'Natural microservice cut-points: domains with high cohesion (intra-edges) AND low external coupling. Use to plan extraction-style refactors.', inputSchema: { type: 'object', properties: { threshold: { type: 'number', description: 'Cohesion threshold 0-1 (default 0.7).' } }, required: [] } },
  { name: 'validate_change', description: 'Pre-write governance: given a file + proposed full content, synthesizes a diff vs disk and runs validate_diff. Use in IDE onWillSaveTextDocument hooks.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' } }, required: ['file', 'content'] } },
  { name: 'get_file_ownership', description: 'Implicit ownership detection via `git blame`. Returns top author + per-author line counts. Fails soft if git is unavailable.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
  { name: 'get_cross_team_coupling', description: 'Cross-domain edges where the source-file owner differs from the target-file owner — surface for coordination warnings.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_drift_digest', description: 'Weekly architectural digest: domain drift, hotspots, events, predicted-risk top 10. CLI-renderable markdown.', inputSchema: { type: 'object', properties: { time_range: { type: 'string', description: 'Window like "7d", "30d" (default "7d").' } }, required: [] } },
  { name: 'get_ai_cost_attribution', description: 'Per-AI-client decision counts + violation counts. Use to attribute cross-domain coupling cost to individual AI sessions / developers.', inputSchema: { type: 'object', properties: { hours: { type: 'number', description: 'Lookback hours (default 168 = 7d).' } }, required: [] } },

  // ─── Cross-repo / Org-wide — 7 tools ────────────────────────────
  { name: 'get_org_architecture', description: 'Org-wide summary: registered repos + total cross-repo edge count + edges by kind. Requires `carto org init` + `carto org sync`.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_service_dependency_graph', description: 'Aggregated cross-repo graph: each repo is a node, edges grouped by (from_repo, to_repo, edge_kind).', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_cross_repo_blast_radius', description: 'Direct downstream consumers of a producer repo. "If I break repo X, who notices?"', inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'Producer repo name' } }, required: ['repo'] } },
  { name: 'find_consumers_of_api', description: 'Across all org repos, find every file importing a given npm/pypi/go/maven target.', inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'Target package or module name' } }, required: ['target'] } },
  { name: 'get_org_domain_mapping', description: 'Per-repo domain list across all org repos (reads each repo\'s carto.db if registered).', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_service_boundary_violations', description: 'Cross-repo edges that import private/internal surface (heuristic: target path contains internal / private / _lib).', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_microservices_migration_cut_points', description: 'Suggested microservices extraction order. Repos with high stability (more incoming than outgoing edges) extract first.', inputSchema: { type: 'object', properties: {}, required: [] } },
];

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'carto', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // Normalize file-arg tools to the canonical SQLite-stored form so
  // `./lib/x.js`, absolute paths, and Windows separators all resolve.
  // Tools that don't take a `file` arg are unaffected.
  if (args && typeof args.file === 'string') {
    args.file = normalizeFileArg(projectRoot, args.file);
    // Lazy mtime+size check. Re-parse the requested file inline
    // if it's stale on disk (user edited but didn't commit). Best-effort:
    // failures here never block the answer.
    lazyReparseFile(args.file);
  }
  // Wrap entire handler body so any tool error (SQLite, null deref, bad
  // input) returns a structured error response instead of crashing the
  // MCP transport. An unhandled throw here would kill the stdio
  // connection and Claude Code/Kiro would surface
  // `-32000 Failed to reconnect`.
  try {
    const s = getStore();
    if (!s) return notIndexed();

  if (name === 'get_routes') {
    const routes = s.getRoutes();
    if (routes.length === 0) return text('No routes found.');
    const lines = ['# All Routes\n', '| Method | Path | File |', '|--------|------|------|'];
    for (const r of routes) lines.push(`| ${r.method} | ${r.path} | ${r.file} |`);
    return text(lines.join('\n'));
  }

  if (name === 'get_blast_radius') {
    // Bitmap path with SQLite fallback. Output shape and
    // formatting are identical between the two paths.
    const sidecar = getSidecar();
    const deps = sidecar
      ? bitmapTools.blastRadius(sidecar, args.file)
      : s.getBlastRadius(args.file);
    if (!deps) return text(`File not found in index: ${args.file}`);
    if (deps.length === 0) return text(`No dependents found for: ${args.file}`);
    const lines = [`# Blast Radius: ${args.file}\n`, `**Affected files:** ${deps.length}\n`];
    lines.push('| File | Hops |');
    lines.push('|------|------|');
    for (const d of deps) lines.push(`| ${d.file} | ${d.hop_distance} |`);
    return text(lines.join('\n'));
  }

  if (name === 'get_structure') {
    const st = s.getStructure();
    const lines = ['# Project Structure\n'];
    if (st.stack.length > 0) lines.push(`**Stack:** ${st.stack.join(', ')}\n`);
    lines.push(`**Meta:** ${st.meta.totalFiles} files, ${st.meta.totalRoutes} routes, ${st.meta.totalImportEdges} import edges\n`);
    if (st.domains.length > 0) lines.push(`**Domains:** ${st.domains.join(', ')}\n`);
    if (st.entryPoints.length > 0) {
      lines.push('## Entry Points');
      for (const e of st.entryPoints) lines.push(`- ${e}`);
      lines.push('');
    }
    if (st.highImpact.length > 0) {
      lines.push('## High Impact Files');
      lines.push('| File | Dependents |');
      lines.push('|------|------------|');
      for (const h of st.highImpact) lines.push(`| ${h.file} | ${h.dependents} |`);
    }
    return text(lines.join('\n'));
  }

  if (name === 'get_domain') {
    // Guard: AI clients sometimes call this with no/empty `domain` arg.
    // Without the guard we'd call args.domain.toUpperCase() on undefined and crash.
    if (!args.domain || typeof args.domain !== 'string') {
      return text('Missing required argument: domain. Use get_domains_list to see available domains.');
    }
    const domain = s.getDomain(args.domain);
    if (!domain) return text(`Domain not found: ${args.domain}. Use get_domains_list to see available domains.`);

    const ctxPath = path.join(projectRoot, '.carto', 'context', `${args.domain.toUpperCase()}.md`);
    const lastSync = s.getMeta('last_full_sync');

    // Check if cached context file is fresh
    let cacheIsFresh = false;
    if (fs.existsSync(ctxPath) && lastSync) {
      try {
        const fileMtime = fs.statSync(ctxPath).mtimeMs;
        const syncTime = new Date(lastSync).getTime();
        cacheIsFresh = fileMtime >= syncTime;
      } catch {}
    }

    if (cacheIsFresh) {
      try { return text(fs.readFileSync(ctxPath, 'utf-8')); } catch {}
    }

    // Regenerate lazily from DB
    const { formatDomainFile } = require('../agents/formatter');
    const cluster = {
      files: domain.files,
      routes: domain.routes.map(r => ({ ...r, functionName: r.handler_name || '' })),
      models: domain.models.map(m => ({
        ...m,
        className: m.name,
        // Wrap parse so one corrupt row doesn't take down the whole tool call.
        fields: (() => {
          if (!m.fields_json) return [];
          try { return JSON.parse(m.fields_json); } catch { return []; }
        })()
      })),
      functions: {},
      envVars: [],
      dbTables: [],
      fileMap: []
    };
    const content = formatDomainFile(args.domain.toUpperCase(), cluster);

    // Cache to disk for next call
    try {
      fs.mkdirSync(path.dirname(ctxPath), { recursive: true });
      fs.writeFileSync(ctxPath, content, 'utf-8');
    } catch {}

    return text(content);
  }

  if (name === 'get_neighbors') {
    const hops = Math.min(args.hops || 1, 3);
    const nb = s.getNeighbors(args.file, hops);
    if (nb.nodes.length === 0) return text(`File not found or no neighbors: ${args.file}`);
    const lines = [`# Import Neighbors: ${args.file} (${hops} hop${hops > 1 ? 's' : ''})\n`];
    lines.push('| File | Domain | Root |');
    lines.push('|------|--------|------|');
    for (const n of nb.nodes) lines.push(`| ${n.id} | ${n.domain} | ${n.isRoot ? '✓' : ''} |`);
    lines.push('');
    lines.push(`## Edges (${nb.edges.length})`);
    for (const e of nb.edges.slice(0, 50)) lines.push(`- ${e.source} → ${e.target}`);
    if (nb.edges.length > 50) lines.push(`_...and ${nb.edges.length - 50} more_`);
    return text(lines.join('\n'));
  }

  if (name === 'get_cross_domain') {
    // Bitmap path with SQLite fallback.
    const sidecar = getSidecar();
    const xd = sidecar ? bitmapTools.crossDomain(sidecar) : s.getCrossDomainDeps();
    if (xd.length === 0) return text('No cross-domain dependencies found.');
    const lines = [`# Cross-Domain Dependencies (${xd.length})\n`];
    lines.push('| From | From Domain | To | To Domain |');
    lines.push('|------|------------|-----|-----------|');
    for (const d of xd.slice(0, 100)) lines.push(`| ${d.from} | ${d.fromDomain} | ${d.to} | ${d.toDomain} |`);
    if (xd.length > 100) lines.push(`\n_...and ${xd.length - 100} more_`);
    return text(lines.join('\n'));
  }

  if (name === 'get_context') {
    const file = s.getFileByPath(args.file);
    if (!file) return text(`File not found: ${args.file}`);
    const domain = s.getDomainForFile(args.file);
    const blastDeps = s.getBlastRadius(args.file) || [];
    const nb = s.getNeighbors(args.file, 2);
    const lines = [
      `# Context: ${args.file}\n`,
      `**Domain:** ${domain || 'CORE'}`,
      `**Blast radius:** ${blastDeps.length} dependent files\n`,
    ];
    if (nb.nodes.length > 1) {
      lines.push(`## Neighbors (2 hops): ${nb.nodes.length - 1} files`);
      for (const n of nb.nodes.filter(n => !n.isRoot).slice(0, 15)) {
        lines.push(`- ${n.id} [${n.domain}]`);
      }
      if (nb.nodes.length > 16) lines.push(`_...and ${nb.nodes.length - 16} more_`);
    }
    return text(lines.join('\n'));
  }

  if (name === 'search_routes') {
    const results = s.searchRoutes(args.query);
    if (results.length === 0) return text(`No routes matching: ${args.query}`);
    const lines = [`# Routes matching "${args.query}" (${results.length})\n`];
    lines.push('| Method | Path | File |');
    lines.push('|--------|------|------|');
    for (const r of results) lines.push(`| ${r.method} | ${r.path} | ${r.file} |`);
    return text(lines.join('\n'));
  }

  if (name === 'get_models') {
    const models = s.getModels(args.domain);
    if (models.length === 0) return text(args.domain ? `No models in domain: ${args.domain}` : 'No models found.');
    const lines = [`# Models${args.domain ? ` — ${args.domain}` : ''} (${models.length})\n`];
    lines.push('| Model | Kind | File |');
    lines.push('|-------|------|------|');
    for (const m of models) lines.push(`| ${m.name} | ${m.kind} | ${m.file} |`);
    return text(lines.join('\n'));
  }

  if (name === 'get_high_impact_files') {
    // Bitmap path with SQLite fallback. The bitmap layer
    // pre-builds `popcountIndex` (sorted DESC by direct-dependent count)
    // at sidecar-build time so this becomes an O(1) array slice — much
    // faster than walking the reverse bitmaps + popcount per file at
    // query time.
    const sidecar = getSidecar();
    const limit = args.limit || 10;
    const files = sidecar
      ? bitmapTools.highImpactFiles(sidecar, limit)
      : s.getHighImpactFiles(limit);
    if (files.length === 0) return text('No high impact files found.');
    const lines = [`# High Impact Files\n`];
    lines.push('| File | Dependents |');
    lines.push('|------|------------|');
    for (const f of files) lines.push(`| ${f.file} | ${f.dependents} |`);
    return text(lines.join('\n'));
  }

  if (name === 'get_env_vars') {
    const vars = s.getEnvVars(args.domain);
    if (vars.length === 0) return text('No env vars found.');
    const lines = [`# Environment Variables (${vars.length})\n`];
    lines.push('| Variable | File |');
    lines.push('|----------|------|');
    for (const v of vars) lines.push(`| ${v.name} | ${v.file} |`);
    return text(lines.join('\n'));
  }

  if (name === 'get_domains_list') {
    const domains = s.getDomainsList();
    if (domains.length === 0) return text('No domains detected.');
    const lines = [`# Domains (${domains.length})\n`];
    lines.push('| Domain | Files | Routes | Models |');
    lines.push('|--------|-------|--------|--------|');
    for (const d of domains) lines.push(`| ${d.name} | ${d.fileCount} | ${d.routeCount} | ${d.modelCount} |`);
    return text(lines.join('\n'));
  }

  if (name === 'get_architecture') {
    const st = s.getStructure();
    const domains = s.getDomainsList();
    const lines = ['# Project Architecture\n'];

    // Stack + size
    if (st.stack.length > 0) lines.push(`**Stack:** ${st.stack.join(', ')}\n`);
    lines.push(`**Size:** ${st.meta.totalFiles} files · ${st.meta.totalRoutes} routes · ${st.meta.totalImportEdges} import edges\n`);

    // Surface extractor failures so the agent knows the index
    // is partial (and which routes/models may be missing).
    const errCountRaw = s.getMeta('extraction_error_count');
    const errCount = errCountRaw ? parseInt(errCountRaw, 10) : 0;
    if (errCount > 0) {
      lines.push(`> ⚠️  **${errCount} extraction error${errCount === 1 ? '' : 's'}** — some files failed to parse and their routes/models are missing. Run \`carto check\` for details.\n`);
    }

    // Surface unavailable grammars so the agent knows which
    // languages have reduced extraction accuracy.
    const unavailRaw = s.getMeta('unavailable_languages_json');
    const unavailLangs = unavailRaw ? (() => { try { return JSON.parse(unavailRaw); } catch { return []; } })() : [];
    if (unavailLangs.length > 0) {
      lines.push(`> ⚠️  **${unavailLangs.length} language grammar${unavailLangs.length === 1 ? '' : 's'} unavailable** (${unavailLangs.join(', ')}) — these languages use regex-only extraction with reduced accuracy.\n`);
    }

    // Domains
    if (domains.length > 0) {
      lines.push('## Domains\n');
      for (const d of domains) {
        if (d.fileCount === 0) continue;
        lines.push(`**${d.name}** — ${d.fileCount} files${d.routeCount > 0 ? `, ${d.routeCount} routes` : ''}${d.modelCount > 0 ? `, ${d.modelCount} models` : ''}`);
      }
      lines.push('');
    }

    // Entry points
    if (st.entryPoints.length > 0) {
      lines.push('## Entry Points\n');
      for (const e of st.entryPoints.slice(0, 10)) lines.push(`- \`${e}\``);
      lines.push('');
    }

    // High impact files
    if (st.highImpact.length > 0) {
      lines.push('## Highest Impact Files\n');
      lines.push('These files have the most dependents — changes here carry the highest risk:\n');
      for (const h of st.highImpact.slice(0, 10)) {
        lines.push(`- \`${h.file}\` (${h.dependents} dependents)`);
      }
      lines.push('');
    }

    // Routes summary
    if (st.meta.totalRoutes > 0) {
      const routes = s.getRoutes().slice(0, 8);
      lines.push('## Sample Routes\n');
      for (const r of routes) lines.push(`- \`${r.method} ${r.path}\` → \`${r.file}\``);
      if (st.meta.totalRoutes > 8) lines.push(`_...and ${st.meta.totalRoutes - 8} more_`);
      lines.push('');
    }

    lines.push(`_Last indexed: ${st.meta.lastIndexed || 'unknown'}_`);
    return text(lines.join('\n'));
  }

  if (name === 'get_file_summary') {
    const file = s.getFileByPath(args.file);
    if (!file) return text(`File not found in index: ${args.file}`);

    const domain = s.getDomainForFile(args.file) || 'CORE';
    const blastDeps = s.getBlastRadius(args.file) || [];
    const nb = s.getNeighbors(args.file, 1);

    // Gather symbols
    const symbols = s.db.prepare(
      'SELECT name, kind FROM symbols WHERE file_id = ? AND exported = 1 LIMIT 5'
    ).all(file.id);

    // Outgoing imports (what this file depends on)
    const outgoing = nb.edges
      .filter(e => e.source === args.file)
      .map(e => e.target)
      .slice(0, 4);

    // Incoming imports (what depends on this file)
    const incoming = nb.edges
      .filter(e => e.target === args.file)
      .map(e => e.source)
      .slice(0, 4);

    const lines = [`# File: ${args.file}\n`];
    lines.push(`**Domain:** ${domain} · **Dependents:** ${blastDeps.length} files\n`);

    if (symbols.length > 0) {
      lines.push(`**Exports:** ${symbols.map(s => `\`${s.name}\` (${s.kind})`).join(', ')}\n`);
    }

    if (outgoing.length > 0) {
      lines.push(`**Imports:** ${outgoing.map(f => `\`${f}\``).join(', ')}`);
    }
    if (incoming.length > 0) {
      lines.push(`**Imported by:** ${incoming.map(f => `\`${f}\``).join(', ')}`);
    }

    return text(lines.join('\n'));
  }

  if (name === 'get_change_plan') {
    const { planChange, formatPlanMarkdown } = require('./change-plan');
    return text(formatPlanMarkdown(planChange(s, args.intent || '')));
  }

  if (name === 'get_similar_patterns') {
    // Bitmap path: Jaccard similarity over forward-import sets.
    // Different semantics from the legacy 3-strategy SQL (same domain /
    // same routes / shared imports) but the standard graph similarity
    // metric and ~100× faster on large repos. Falls back to SQLite when
    // bitmap is unavailable.
    const sidecar = getSidecar();
    if (sidecar) {
      const limit = Math.min(args.limit || 5, 20);
      const results = bitmapTools.similarPatterns(sidecar, args.file, limit);
      if (results === null) return text(`File not found in index: ${args.file}`);
      const lines = [`# Similar Patterns to: ${args.file}\n`];
      if (results.length === 0) {
        lines.push('_No similar files found — this file has no resolved imports to compare against._');
        return text(lines.join('\n'));
      }
      lines.push('Files ranked by Jaccard similarity over their import sets:\n');
      lines.push('| File | Score | Shared Imports |');
      lines.push('|------|-------|----------------|');
      for (const r of results) {
        lines.push(`| \`${r.file}\` | ${r.score.toFixed(2)} | ${r.shared} |`);
      }
      return text(lines.join('\n'));
    }

    // SQLite fallback path — kept for the (rare) case bitmap load fails.
    const file = s.getFileByPath(args.file);
    if (!file) return text(`File not found in index: ${args.file}`);

    const limit = Math.min(args.limit || 5, 20);
    const domain = s.getDomainForFile(args.file);

    // Get this file's imports and routes for comparison
    const fileImports = s.db.prepare(
      'SELECT to_path FROM imports WHERE from_file_id = ?'
    ).all(file.id).map(r => r.to_path);

    const fileRoutes = s.db.prepare(
      'SELECT method, path FROM routes WHERE file_id = ?'
    ).all(file.id);

    const fileSymbols = s.db.prepare(
      'SELECT name, kind FROM symbols WHERE file_id = ? AND exported = 1 LIMIT 10'
    ).all(file.id);

    const lines = [`# Similar Patterns to: ${args.file}\n`];

    // Strategy 1: Files in same domain with similar import count
    if (domain) {
      const domainFiles = s.db.prepare(`
        SELECT f.path, f.language,
          (SELECT COUNT(*) FROM imports WHERE from_file_id = f.id) as import_count,
          (SELECT COUNT(*) FROM routes WHERE file_id = f.id) as route_count
        FROM files f
        JOIN domain_assignments da ON da.file_id = f.id
        JOIN domains d ON da.domain_id = d.id
        WHERE d.name = ? AND f.path != ?
        ORDER BY ABS(import_count - ?) ASC
        LIMIT ?
      `).all(domain, args.file, fileImports.length, limit);

      if (domainFiles.length > 0) {
        lines.push(`## Files in same domain (${domain}) with similar structure\n`);
        lines.push('| File | Language | Imports | Routes |');
        lines.push('|------|----------|---------|--------|');
        for (const f of domainFiles) {
          lines.push(`| \`${f.path}\` | ${f.language} | ${f.import_count} | ${f.route_count} |`);
        }
        lines.push('');
      }
    }

    // Strategy 2: Files with same route patterns (same HTTP methods)
    if (fileRoutes.length > 0) {
      const methods = [...new Set(fileRoutes.map(r => r.method))];
      const methodPlaceholders = methods.map(() => '?').join(',');
      const similarRouteFiles = s.db.prepare(`
        SELECT DISTINCT f.path, COUNT(r.id) as route_count
        FROM files f
        JOIN routes r ON r.file_id = f.id
        WHERE r.method IN (${methodPlaceholders}) AND f.path != ?
        GROUP BY f.id
        ORDER BY ABS(route_count - ?) ASC
        LIMIT ?
      `).all(...methods, args.file, fileRoutes.length, limit);

      if (similarRouteFiles.length > 0) {
        lines.push(`## Files with similar route patterns (${methods.join(', ')})\n`);
        for (const f of similarRouteFiles) {
          lines.push(`- \`${f.path}\` (${f.route_count} routes)`);
        }
        lines.push('');
      }
    }

    // Strategy 3: Files with overlapping imports (shared dependencies)
    if (fileImports.length > 0) {
      const importPaths = fileImports.slice(0, 5);
      const placeholders = importPaths.map(() => '?').join(',');
      const sharedImportFiles = s.db.prepare(`
        SELECT f.path, COUNT(DISTINCT i.to_path) as shared_count
        FROM files f
        JOIN imports i ON i.from_file_id = f.id
        WHERE i.to_path IN (${placeholders}) AND f.path != ?
        GROUP BY f.id
        HAVING shared_count >= 2
        ORDER BY shared_count DESC
        LIMIT ?
      `).all(...importPaths, args.file, limit);

      if (sharedImportFiles.length > 0) {
        lines.push('## Files sharing common dependencies\n');
        for (const f of sharedImportFiles) {
          lines.push(`- \`${f.path}\` (${f.shared_count} shared imports)`);
        }
        lines.push('');
      }
    }

    if (lines.length === 1) {
      lines.push('_No similar patterns found. The file may be unique in the codebase._');
    }

    return text(lines.join('\n'));
  }

  if (name === 'simulate_change_impact') {
    // Returns the union of every transitively
    // affected file when a *set* of files changes simultaneously. Only
    // feasible with bitmaps: an N×SQL `getBlastRadius` approach takes
    // hundreds of milliseconds on large repos; bitmap OR-aggregate runs
    // in microseconds. If the bitmap engine is unavailable for any
    // reason, surface a clear "unsupported" error rather than an
    // O(N×F×E) SQL fallback that would block the agent.
    if (!Array.isArray(args.files) || args.files.length === 0) {
      return text('Missing or empty argument: files (array of relative paths from project root).');
    }

    // Normalize each input path the same way the single-file tools do,
    // and run lazy mtime check so any locally-edited input file is
    // re-parsed before we read the index. The lazy reparse will
    // invalidate the bitmap singleton if it triggers — getSidecar()
    // below picks that up.
    const normalizedFiles = [];
    for (const f of args.files) {
      if (typeof f !== 'string' || f.length === 0) continue;
      const norm = normalizeFileArg(projectRoot, f);
      normalizedFiles.push(norm);
      lazyReparseFile(norm);
    }
    if (normalizedFiles.length === 0) {
      return text('No valid file paths in `files` argument.');
    }

    const sidecar = getSidecar();
    if (!sidecar) {
      return text(
        '`simulate_change_impact` requires the bitmap engine, which failed to load. ' +
        'Run `carto sync` to rebuild `.carto/bitmap.bin`.'
      );
    }

    const result = bitmapTools.simulateChangeImpact(sidecar, normalizedFiles);
    const lines = [
      `# Simulate Change Impact\n`,
      `Changing **${normalizedFiles.length}** file${normalizedFiles.length === 1 ? '' : 's'} ` +
      `simultaneously affects **${result.count}** transitive dependent` +
      `${result.count === 1 ? '' : 's'}.\n`,
    ];
    lines.push('## Input files\n');
    for (const f of normalizedFiles) lines.push(`- \`${f}\``);
    lines.push('');
    if (result.count === 0) {
      lines.push('_No additional files would be affected. None of the input files have dependents in the index._');
    } else {
      lines.push('## Affected files\n');
      lines.push('| File | Min Hop |');
      lines.push('|------|---------|');
      for (const r of result.files.slice(0, 200)) {
        lines.push(`| \`${r.file}\` | ${r.hop_distance} |`);
      }
      if (result.count > 200) lines.push(`\n_...and ${result.count - 200} more._`);
    }
    return text(lines.join('\n'));
  }

  // ─── Validation API + Episodic Memory ─────────────────────────────

  if (name === 'validate_diff') {
    if (!args || typeof args.diff !== 'string' || args.diff.length === 0) {
      return text('Missing required argument: diff (unified diff text).');
    }
    const sidecar = getSidecar();
    const result = validateDiff(s, sidecar, args.diff);

    // Persist via brief writer connection. Don't fail the
    // user-facing response if the audit log write fails (read-only FS,
    // disk full, schema migration in flight). Per-call `session_id`
    // override falls through to "create a session if none exists".
    withWriter((writer) => {
      let sessionId = args.session_id;
      if (typeof sessionId !== 'number' || sessionId <= 0) {
        const session = writer.getOrCreateActiveSession('mcp');
        sessionId = session.id;
      }
      recordSideEffects(writer, sessionId, args.diff, result);
    });

    // Render a markdown response. The shape is the visible artifact —
    // every AI tool the user runs will see this output.
    const lines = ['# Diff Validation\n'];
    const riskBadge = {
      SAFE: '🟢 SAFE',
      LOW: '🟡 LOW',
      MEDIUM: '🟠 MEDIUM',
      HIGH: '🔴 HIGH',
    }[result.risk] || result.risk;
    lines.push(`**Risk:** ${riskBadge}`);
    lines.push(`**Files changed:** ${result.diff.length}`);
    lines.push(`**Union blast radius:** ${result.blast_radius.union} transitive dependents\n`);

    if (result.diff.length > 0) {
      lines.push('## Files\n');
      lines.push('| File | Kind | +Lines | -Lines | Blast |');
      lines.push('|------|------|-------:|-------:|------:|');
      for (const d of result.diff) {
        const blast = result.blast_radius.perFile[d.path] || 0;
        lines.push(`| \`${d.path}\` | ${d.kind} | ${d.addedCount} | ${d.removedCount} | ${blast} |`);
      }
      lines.push('');
    }

    if (result.violations.length > 0) {
      lines.push(`## Violations (${result.violations.length})\n`);
      lines.push('| Severity | Kind | File | Detail |');
      lines.push('|----------|------|------|--------|');
      for (const v of result.violations) {
        lines.push(`| ${v.severity} | ${v.kind} | \`${v.file}\` | ${v.message} |`);
      }
      lines.push('');
    } else {
      lines.push('_No violations detected._\n');
    }

    if (result.suggestions.length > 0) {
      lines.push(`## Suggestions (${result.suggestions.length})\n`);
      for (const sug of result.suggestions) {
        lines.push(`- **${sug.kind}** on \`${sug.file}\`: ${sug.message}`);
      }
      lines.push('');
    }

    return text(lines.join('\n'));
  }

  if (name === 'get_recent_decisions') {
    const range = (args && args.time_range) || '7d';
    const ms = parseTimeRange(range);
    if (ms === null) {
      return text(`Invalid time_range: "${range}". Use formats like "7d", "24h", "1h".`);
    }
    const kind = args && args.kind ? String(args.kind) : null;
    const rows = s.getRecentDecisions(ms, kind);
    if (rows.length === 0) {
      return text(`No decisions in the last ${range}${kind ? ` (kind=${kind})` : ''}.`);
    }
    const lines = [`# Recent Decisions (last ${range}${kind ? `, kind=${kind}` : ''})\n`];
    lines.push(`**${rows.length}** decision${rows.length === 1 ? '' : 's'} found.\n`);
    lines.push('| When | Kind | File | Summary |');
    lines.push('|------|------|------|---------|');
    for (const r of rows.slice(0, 50)) {
      const when = new Date(r.ts).toISOString();
      const summary = summarizeDecisionPayload(r.payload_json);
      lines.push(`| ${when} | ${r.kind} | ${r.file ? `\`${r.file}\`` : '—'} | ${summary} |`);
    }
    if (rows.length > 50) lines.push(`\n_...and ${rows.length - 50} more._`);
    return text(lines.join('\n'));
  }

  if (name === 'get_session_context') {
    let sessionId = args && args.session_id;
    if (typeof sessionId !== 'number' || sessionId <= 0) {
      const cur = s.getCurrentSession();
      if (!cur) return text('No active session found. Run a tool that creates one (e.g. `validate_diff`) first.');
      sessionId = cur.id;
    }
    const ctx = s.getSessionContext(sessionId);
    if (!ctx) return text(`Session not found: ${sessionId}`);
    const lines = [`# Session ${ctx.session.id}\n`];
    lines.push(`**Started:** ${new Date(ctx.session.started_at).toISOString()}`);
    if (ctx.session.ended_at) {
      lines.push(`**Ended:** ${new Date(ctx.session.ended_at).toISOString()}`);
    } else {
      lines.push('**Ended:** _(active)_');
    }
    if (ctx.session.client_name) lines.push(`**Client:** ${ctx.session.client_name}`);
    lines.push('');
    lines.push(`## Decisions (${ctx.decisions.length})\n`);
    if (ctx.decisions.length === 0) {
      lines.push('_None._\n');
    } else {
      lines.push('| When | Kind | File | Summary |');
      lines.push('|------|------|------|---------|');
      for (const d of ctx.decisions.slice(0, 50)) {
        const when = new Date(d.ts).toISOString();
        const summary = summarizeDecisionPayload(d.payload_json);
        lines.push(`| ${when} | ${d.kind} | ${d.file ? `\`${d.file}\`` : '—'} | ${summary} |`);
      }
      if (ctx.decisions.length > 50) lines.push(`\n_...and ${ctx.decisions.length - 50} more._`);
      lines.push('');
    }
    lines.push(`## Interventions (${ctx.interventions.length})\n`);
    if (ctx.interventions.length === 0) {
      lines.push('_None._');
    } else {
      lines.push('| When | Severity | Kind | File | Message |');
      lines.push('|------|----------|------|------|---------|');
      for (const iv of ctx.interventions.slice(0, 50)) {
        const when = new Date(iv.ts).toISOString();
        lines.push(`| ${when} | ${iv.severity || '—'} | ${iv.kind} | ${iv.file ? `\`${iv.file}\`` : '—'} | ${iv.message || ''} |`);
      }
      if (ctx.interventions.length > 50) lines.push(`\n_...and ${ctx.interventions.length - 50} more._`);
    }
    return text(lines.join('\n'));
  }

  if (name === 'did_we_discuss_this') {
    if (!args || typeof args.topic !== 'string' || args.topic.length === 0) {
      return text('Missing required argument: topic (string).');
    }
    const decisions = s.searchDecisions(args.topic);
    const interventions = s.searchInterventions(args.topic);
    if (decisions.length === 0 && interventions.length === 0) {
      return text(`No prior discussion of "${args.topic}" found in the episodic memory log.`);
    }
    const lines = [`# Prior discussions of "${args.topic}"\n`];
    if (decisions.length > 0) {
      lines.push(`## Decisions (${decisions.length})\n`);
      lines.push('| When | Session | Kind | File | Summary |');
      lines.push('|------|---------|------|------|---------|');
      for (const d of decisions.slice(0, 25)) {
        const when = new Date(d.ts).toISOString();
        const summary = summarizeDecisionPayload(d.payload_json);
        lines.push(`| ${when} | ${d.session_id || '—'} | ${d.kind} | ${d.file ? `\`${d.file}\`` : '—'} | ${summary} |`);
      }
      if (decisions.length > 25) lines.push(`\n_...and ${decisions.length - 25} more._`);
      lines.push('');
    }
    if (interventions.length > 0) {
      lines.push(`## Interventions (${interventions.length})\n`);
      lines.push('| When | Session | Severity | Kind | File | Message |');
      lines.push('|------|---------|----------|------|------|---------|');
      for (const iv of interventions.slice(0, 25)) {
        const when = new Date(iv.ts).toISOString();
        lines.push(`| ${when} | ${iv.session_id || '—'} | ${iv.severity || '—'} | ${iv.kind} | ${iv.file ? `\`${iv.file}\`` : '—'} | ${iv.message || ''} |`);
      }
      if (interventions.length > 25) lines.push(`\n_...and ${interventions.length - 25} more._`);
    }
    return text(lines.join('\n'));
  }

  if (name === 'get_intervention_history') {
    const file = args && args.file ? args.file : null;
    const rows = s.getInterventionsForFile(file);
    if (rows.length === 0) {
      return text(file ? `No interventions for \`${file}\`.` : 'No interventions in the log.');
    }
    const lines = [`# Intervention History${file ? `: \`${file}\`` : ''}\n`];
    lines.push(`**${rows.length}** intervention${rows.length === 1 ? '' : 's'} found.\n`);
    lines.push('| When | Severity | Kind | File | Message |');
    lines.push('|------|----------|------|------|---------|');
    for (const iv of rows.slice(0, 100)) {
      const when = new Date(iv.ts).toISOString();
      lines.push(`| ${when} | ${iv.severity || '—'} | ${iv.kind} | ${iv.file ? `\`${iv.file}\`` : '—'} | ${iv.message || ''} |`);
    }
    if (rows.length > 100) lines.push(`\n_...and ${rows.length - 100} more._`);
    return text(lines.join('\n'));
  }

  // ─── Rule engine tool dispatch ────────────────────────────────────
  // Five tools live here: get_gaps, dismiss_gap, set_intent, get_intent,
  // get_file_receipts. The engine + intent modules are lazy-required so
  // that a Carto install with no rules configured pays nothing.

  if (name === 'get_gaps') {
    const { runEngine } = require('../rules/engine');
    const { loadIntent } = require('../rules/intent');
    const intent = loadIntent(projectRoot);
    if (!intent || intent.product_type === 'unsupported') {
      return text(
        `# Gaps\n\n` +
        `No gaps to show — this project's intent is either unset or ` +
        `unsupported. The rule engine ships rules for **Next.js + ` +
        `Supabase SaaS-with-auth** projects only. If that describes ` +
        `this repo, run \`set_intent { product_type: "saas-with-auth" }\` ` +
        `to enable rules.`
      );
    }

    const refresh = !!(args && args.refresh);
    if (refresh) {
      const sidecar = getSidecar();
      const engineResult = runEngine({ store: s, sidecar, projectRoot, intent });
      withWriter((writer) => {
        writer.replaceGaps(engineResult.gaps);
      });
    }

    const rows = s.getGaps({
      includeDismissed: !!(args && args.include_dismissed),
      rule_id: args && args.rule_id,
      file: args && args.file,
      severity: args && args.severity,
    });

    const counts = s.countGaps({ includeDismissed: !!(args && args.include_dismissed) });

    const lines = [`# Gaps\n`];
    lines.push(
      `**${counts.total}** total · ` +
      `HIGH ${counts.bySeverity.HIGH || 0} · ` +
      `MEDIUM ${counts.bySeverity.MEDIUM || 0} · ` +
      `LOW ${counts.bySeverity.LOW || 0}`,
    );
    lines.push(`_Intent: ${intent.product_type}${intent.stack && intent.stack.length ? ` (${intent.stack.join(', ')})` : ''}_\n`);

    if (rows.length === 0) {
      lines.push('_No gaps match the current filter._');
      if (!refresh) {
        lines.push('\n_Tip: pass `refresh: true` to re-run the rule engine._');
      }
      return text(lines.join('\n'));
    }

    lines.push('| Severity | Rule | File | Line | Evidence | gap_hash |');
    lines.push('|----------|------|------|------|----------|----------|');
    for (const g of rows.slice(0, 100)) {
      const badge = g.dismissed
        ? '_dismissed_'
        : g.severity;
      lines.push(
        `| ${badge} | \`${g.rule_id}\` | \`${g.file || '—'}\` | ${g.line || '—'} | ` +
        `${(g.evidence || '').replace(/\|/g, '\\|')} | \`${g.gap_hash}\` |`,
      );
    }
    if (rows.length > 100) lines.push(`\n_...and ${rows.length - 100} more._`);
    return text(lines.join('\n'));
  }

  if (name === 'dismiss_gap') {
    if (!args || typeof args.gap_hash !== 'string' || args.gap_hash.length === 0) {
      return text('Missing required argument: gap_hash (from get_gaps output).');
    }
    const reason = args && typeof args.reason === 'string' ? args.reason : null;
    const outcome = withWriter((writer) => writer.dismissGap(args.gap_hash, reason));
    if (!outcome || !outcome.dismissed) {
      return text(`No gap with gap_hash \`${args.gap_hash}\`. Run get_gaps to see current hashes.`);
    }
    const g = outcome.gap;
    return text(
      `# Gap dismissed\n\n` +
      `- **rule:** \`${g.rule_id}\`\n` +
      `- **file:** \`${g.file || '—'}\`${g.line ? `:${g.line}` : ''}\n` +
      `- **reason:** ${reason || '_(none provided)_'}\n\n` +
      `This gap will not resurface in \`get_gaps\` unless \`include_dismissed: true\` is passed.`,
    );
  }

  if (name === 'set_intent') {
    const { setIntent } = require('../rules/intent');
    const patch = {};
    if (args && typeof args.product_type === 'string') patch.product_type = args.product_type;
    if (args && Array.isArray(args.stack)) patch.stack = args.stack;
    if (args && typeof args.note === 'string') patch.note = args.note;
    if (Object.keys(patch).length === 0) {
      return text('Nothing to set. Pass at least one of: product_type, stack, note.');
    }
    const written = setIntent(projectRoot, patch);
    const lines = ['# Intent updated\n'];
    lines.push(`- **product_type:** \`${written.product_type}\``);
    lines.push(`- **stack:** ${written.stack && written.stack.length ? written.stack.map((s) => `\`${s}\``).join(', ') : '_(empty)_'}`);
    lines.push(`- **notes:** ${written.notes.length}`);
    lines.push(`- **updated_at:** ${new Date(written.updated_at).toISOString()}`);
    lines.push(`\n_Written to \`.carto/intent.json\`. Next \`get_gaps\` call will use this._`);
    return text(lines.join('\n'));
  }

  if (name === 'get_intent') {
    const { loadIntent } = require('../rules/intent');
    const intent = loadIntent(projectRoot);
    if (!intent) {
      return text(
        `# Intent\n\n` +
        `No intent set. Run \`set_intent\` to configure this project's ` +
        `product type and stack, or run \`carto init\` — it auto-detects ` +
        `from \`package.json\`.`,
      );
    }
    const lines = ['# Intent\n'];
    lines.push(`- **product_type:** \`${intent.product_type || 'unsupported'}\``);
    lines.push(`- **stack:** ${intent.stack && intent.stack.length ? intent.stack.map((s) => `\`${s}\``).join(', ') : '_(empty)_'}`);
    lines.push(`- **updated_at:** ${intent.updated_at ? new Date(intent.updated_at).toISOString() : '_(unknown)_'}`);
    if (intent.notes && intent.notes.length > 0) {
      lines.push('\n## Notes\n');
      for (const n of intent.notes.slice(-20)) {
        lines.push(`- _${new Date(n.ts).toISOString()}_: ${n.text}`);
      }
    }
    return text(lines.join('\n'));
  }

  if (name === 'get_file_receipts') {
    if (!args || typeof args.file !== 'string' || args.file.length === 0) {
      return text('Missing required argument: file.');
    }
    const file = args.file;
    const fileRow = s.getFileByPath(file);
    if (!fileRow) return text(`File not indexed: \`${file}\`. Run \`carto sync\` if it exists on disk.`);

    const sidecar = getSidecar();
    const deps = sidecar
      ? (bitmapTools.blastRadius(sidecar, file) || [])
      : (s.getBlastRadius(file) || []);
    const interventions = s.getInterventionsForFile(file);
    const gaps = s.getGaps({ file });
    const decisions = typeof s.searchDecisions === 'function' ? s.searchDecisions(file) : [];

    const lines = [`# Receipts: \`${file}\`\n`];
    lines.push(`**Blast radius:** ${deps.length} transitive dependent${deps.length === 1 ? '' : 's'}`);
    lines.push(`**Active gaps on this file:** ${gaps.length}`);
    lines.push(`**Prior interventions:** ${interventions.length}`);
    lines.push(`**Prior decisions mentioning this file:** ${decisions.length}\n`);

    if (gaps.length > 0) {
      lines.push('## Active gaps\n');
      lines.push('| Severity | Rule | Evidence |');
      lines.push('|----------|------|----------|');
      for (const g of gaps.slice(0, 20)) {
        lines.push(`| ${g.severity} | \`${g.rule_id}\` | ${(g.evidence || '').replace(/\|/g, '\\|')} |`);
      }
      lines.push('');
    }

    if (interventions.length > 0) {
      lines.push('## Prior interventions\n');
      lines.push('| When | Severity | Kind | Message |');
      lines.push('|------|----------|------|---------|');
      for (const iv of interventions.slice(0, 20)) {
        lines.push(`| ${new Date(iv.ts).toISOString()} | ${iv.severity || '—'} | ${iv.kind} | ${(iv.message || '').replace(/\|/g, '\\|')} |`);
      }
      lines.push('');
    }

    if (deps.length > 0) {
      lines.push('## Blast radius (first 20)\n');
      lines.push('| File | Hops |');
      lines.push('|------|------|');
      for (const d of deps.slice(0, 20)) {
        lines.push(`| \`${d.file}\` | ${d.hop_distance} |`);
      }
      if (deps.length > 20) lines.push(`\n_...and ${deps.length - 20} more._`);
      lines.push('');
    }

    if (decisions.length > 0) {
      lines.push('## Recent decisions mentioning this file\n');
      lines.push('| When | Kind |');
      lines.push('|------|------|');
      for (const d of decisions.slice(0, 10)) {
        lines.push(`| ${new Date(d.ts).toISOString()} | ${d.kind} |`);
      }
    }

    return text(lines.join('\n'));
  }

  // ─── Temporal layer tool dispatch ─────────────────────────────────
  // All temporal tools share the same shape: open the temporal store
  // readonly, run the query, format markdown. Missing temporal DB is
  // graceful — we tell the user to run `carto temporal init`.
  const TEMPORAL_TOOLS = new Set([
    'get_architectural_drift', 'get_domain_evolution', 'get_hotspot_files',
    'get_complexity_trend', 'get_churn_vs_blast_radius', 'get_arch_events',
    'get_domain_health', 'get_temporal_context',
  ]);
  if (TEMPORAL_TOOLS.has(name)) {
    return runTemporalTool(name, args || {});
  }

  // ─── Brain tool dispatch (semantic + procedural + working) ───────
  const BRAIN_TOOLS = new Set([
    'get_invariants', 'get_canonical_pattern', 'get_conventions',
    'get_action_patterns', 'scaffold_for_intent', 'get_working_memory',
    'get_pending_decisions', 'get_active_drift', 'get_active_suggestions',
    'dismiss_suggestion',
  ]);
  if (BRAIN_TOOLS.has(name)) {
    return runBrainTool(name, args || {});
  }

  // ─── AI-native primitives ────────────────────────────────────────
  const AI_TOOLS = new Set([
    'get_minimal_context_for_intent', 'get_progressive_disclosure_tree',
    'get_token_budget_report', 'get_decision_log', 'get_evolution_delta',
    'get_change_velocity', 'get_test_coverage_map', 'get_safety_checklist',
    'get_data_flow', 'get_interface_contract', 'explain_change_in_natural_language',
    'get_stale_docs', 'get_dependency_surface', 'get_upgrade_risk',
  ]);
  if (AI_TOOLS.has(name)) {
    return runAiTool(name, args || {});
  }

  // ─── Adjacent positioning ────────────────────────────────────────
  const ADJ_TOOLS = new Set([
    'get_cross_language_call_graph', 'get_iac_resources',
    'ingest_otlp_traces', 'get_risk_weighted_blast_radius',
    'get_dead_code_with_confidence', 'get_hot_in_prod_no_tests',
    'get_semantic_diff', 'get_llm_enrichment',
  ]);
  if (ADJ_TOOLS.has(name)) {
    return runAdjacentTool(name, args || {});
  }

  // ─── Predictive ──────────────────────────────────────────────────
  const PRED_TOOLS = new Set([
    'get_predictive_risk', 'get_microservice_cut_points', 'validate_change',
    'get_file_ownership', 'get_cross_team_coupling', 'get_drift_digest',
    'get_ai_cost_attribution',
  ]);
  if (PRED_TOOLS.has(name)) {
    return runPredictiveTool(name, args || {});
  }

  // ─── Cross-repo / Org-wide ───────────────────────────────────────
  const ORG_TOOLS = new Set([
    'get_org_architecture', 'get_service_dependency_graph',
    'get_cross_repo_blast_radius', 'find_consumers_of_api',
    'get_org_domain_mapping', 'get_service_boundary_violations',
    'get_microservices_migration_cut_points',
  ]);
  if (ORG_TOOLS.has(name)) {
    return runOrgTool(name, args || {});
  }

  return text(`Unknown tool: ${name}`);
  } catch (err) {
    process.stderr.write(`[CARTO MCP] Tool "${name}" error: ${err.stack || err.message || err}\n`);
    return {
      content: [{ type: 'text', text: `Error in ${name}: ${err.message || String(err)}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('[CARTO MCP] Fatal:', err.message);
  process.exit(1);
});
