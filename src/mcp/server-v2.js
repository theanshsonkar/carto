#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { SQLiteStore } = require('../store/sqlite-store');

const projectRoot = process.cwd();

// Open SQLite directly — no re-indexing, instant startup
let store = null;

function getStore() {
  if (store) return store;
  const dbPath = path.join(projectRoot, '.carto', 'carto.db');
  if (!fs.existsSync(dbPath)) return null;
  store = new SQLiteStore(projectRoot);
  store.open();
  return store;
}

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

function notIndexed() {
  return text('No .carto/carto.db found. Run `carto sync` first.');
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
];

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'carto', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
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
    const deps = s.getBlastRadius(args.file);
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
        fields: m.fields_json ? JSON.parse(m.fields_json) : []
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
    const xd = s.getCrossDomainDeps();
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
    const files = s.getHighImpactFiles(args.limit || 10);
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

  return text(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('[CARTO MCP] Fatal:', err.message);
  process.exit(1);
});
