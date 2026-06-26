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

// ─── Tool definitions (same as V1) ──────────────────────────────────────────

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
