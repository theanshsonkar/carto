#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Carto } = require('../../index.js');

const projectRoot = process.cwd();

// Load Carto from disk cache — fast startup, no re-indexing
let carto = null;

async function getCarto() {
  if (carto) return carto;
  carto = new Carto();
  try {
    await carto.index(projectRoot, { useWorkers: false });
  } catch (err) {
    console.error('[CARTO MCP] Failed to load index:', err.message);
  }
  return carto;
}

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

function notIndexed() {
  return text('No .carto/graph-cache.json found. Run `carto init` first.');
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_routes',
    description: 'Get all API routes in this project including REST, tRPC, and webhooks.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_blast_radius',
    description: 'Get all files, routes, and domains affected by changing a specific file. Includes risk level per route.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative file path from project root' }
      },
      required: ['file']
    }
  },
  {
    name: 'get_structure',
    description: 'Get project structure: import graph, entry points, high impact files, tech stack, and domains.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_domain',
    description: 'Get all routes, models, functions, and context for a specific domain (AUTH, PAYMENTS, TRPC, DATABASE, EVENTS, NOTIFICATIONS, CORE).',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name e.g. AUTH, PAYMENTS, DATABASE' }
      },
      required: ['domain']
    }
  },
  {
    name: 'get_neighbors',
    description: 'Get import graph neighbors of a file — files it imports and files that import it. Returns nodes and edges for visualization.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative file path from project root' },
        hops: { type: 'number', description: 'How many hops to traverse (default 1, max 3)' }
      },
      required: ['file']
    }
  },
  {
    name: 'get_cross_domain',
    description: 'Get all import edges that cross domain boundaries — e.g. AUTH importing PAYMENTS. Use to detect unexpected coupling.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_context',
    description: 'Get full structural context for a file: domain, blast radius, import neighbors, routes, models, env vars, and cross-domain dependencies. Single call for everything.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative file path from project root' }
      },
      required: ['file']
    }
  },
  {
    name: 'search_routes',
    description: 'Search API routes by path or method. Case-insensitive.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query e.g. "auth", "POST", "/api/users"' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_models',
    description: 'Get all data models (Prisma, Pydantic, TypeScript interfaces, Zod schemas) across the project, optionally filtered by domain.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Optional domain filter e.g. AUTH, DATABASE' }
      },
      required: []
    }
  },
  {
    name: 'get_high_impact_files',
    description: 'Get the files with the highest blast radius — most other files depend on them. Changing these files is highest risk.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of files to return (default 10)' }
      },
      required: []
    }
  },
  {
    name: 'get_env_vars',
    description: 'Get all environment variables used in this project, with which files use them and which domains they belong to.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Optional domain filter e.g. AUTH, PAYMENTS' }
      },
      required: []
    }
  },
  {
    name: 'get_domains_list',
    description: 'Get all detected domains with file counts, route counts, and model counts.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'carto', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const c = await getCarto();

  if (!c._cache) return notIndexed();

  // ── get_routes ────────────────────────────────────────────────────────────
  if (name === 'get_routes') {
    const routes = c.getRoutes();
    if (routes.length === 0) return text('No routes found.');
    const lines = ['# All Routes\n', '| Method | Path | File |', '|--------|------|------|'];
    for (const r of routes) lines.push(`| ${r.method} | ${r.path} | ${r.file} |`);
    return text(lines.join('\n'));
  }

  // ── get_blast_radius ─────────────────────────────────────────────────────
  if (name === 'get_blast_radius') {
    const br = c.getBlastRadius(args.file);
    if (!br) return text(`File not found in graph: ${args.file}`);

    const lines = [
      `# Blast Radius: ${br.file}\n`,
      `**Risk:** ${br.risk}`,
      `**Directly affected:** ${br.directlyAffected.files} files, ${br.directlyAffected.domains} domains`,
      `**Potentially affected:** ${br.potentiallyAffected.files} files\n`,
    ];

    if (br.domainsImpacted.length > 0) {
      lines.push(`**Domains impacted:** ${br.domainsImpacted.join(', ')}\n`);
    }

    if (br.dependentFiles.length > 0) {
      lines.push(`## Files depending on this (${br.dependentFiles.length})`);
      for (const f of br.dependentFiles) lines.push(`- ${f}`);
      lines.push('');
    }

    if (br.routesImpacted.length > 0) {
      lines.push(`## Routes at risk (${br.routesImpacted.length})`);
      lines.push('| Method | Path | Risk |');
      lines.push('|--------|------|------|');
      for (const r of br.routesImpacted) lines.push(`| ${r.method} | ${r.path} | ${r.risk} |`);
    } else {
      lines.push('## Routes at risk\n_None directly traceable._');
    }

    return text(lines.join('\n'));
  }

  // ── get_structure ─────────────────────────────────────────────────────────
  if (name === 'get_structure') {
    const s = c.getStructure();
    const lines = ['# Project Structure\n'];

    if (s.stack && s.stack.length > 0) {
      lines.push(`**Stack:** ${s.stack.join(', ')}\n`);
    }
    lines.push(`**Meta:** ${s.meta.totalFiles} files, ${s.meta.totalRoutes} routes, ${s.meta.totalImportEdges} import edges\n`);

    if (s.domains.length > 0) {
      lines.push(`**Domains:** ${s.domains.join(', ')}\n`);
    }

    if (s.entryPoints.length > 0) {
      lines.push('## Entry Points');
      for (const e of s.entryPoints) lines.push(`- ${e}`);
      lines.push('');
    }

    if (s.highImpact.length > 0) {
      lines.push('## High Impact Files (top 15)');
      lines.push('| File | Dependents |');
      lines.push('|------|------------|');
      for (const h of s.highImpact.slice(0, 15)) lines.push(`| ${h.file} | ${h.dependents} |`);
    }

    return text(lines.join('\n'));
  }

  // ── get_domain ────────────────────────────────────────────────────────────
  if (name === 'get_domain') {
    const domain = c.getDomain(args.domain);
    if (!domain) return text(`Domain not found: ${args.domain}. Use get_domains_list to see available domains.`);
    if (domain.contextContent) return text(domain.contextContent);

    const lines = [`# Domain: ${args.domain.toUpperCase()}\n`];
    if ((domain.routes || []).length > 0) {
      lines.push('## Routes');
      for (const r of domain.routes) lines.push(`- ${r.method || ''} ${r.path || r}`);
      lines.push('');
    }
    if ((domain.models || []).length > 0) {
      lines.push('## Models');
      for (const m of domain.models) lines.push(`- ${m.name || m}`);
      lines.push('');
    }
    if (domain.files && domain.files.length > 0) {
      lines.push('## Files');
      for (const f of domain.files) lines.push(`- ${f}`);
    }
    return text(lines.join('\n'));
  }

  // ── get_neighbors ─────────────────────────────────────────────────────────
  if (name === 'get_neighbors') {
    const hops = Math.min(args.hops || 1, 3);
    const nb = c.getNeighbors(args.file, hops);
    if (!nb || nb.nodes.length === 0) return text(`File not found or no neighbors: ${args.file}`);

    const lines = [`# Import Neighbors: ${args.file} (${hops} hop${hops > 1 ? 's' : ''})\n`];
    lines.push(`## Nodes (${nb.nodes.length})`);
    lines.push('| File | Domain | Root |');
    lines.push('|------|--------|------|');
    for (const n of nb.nodes) lines.push(`| ${n.id} | ${n.domain} | ${n.isRoot ? '✓' : ''} |`);
    lines.push('');
    lines.push(`## Edges (${nb.edges.length})`);
    for (const e of nb.edges) lines.push(`- ${e.source} → ${e.target}`);
    return text(lines.join('\n'));
  }

  // ── get_cross_domain ─────────────────────────────────────────────────────
  if (name === 'get_cross_domain') {
    const xd = c.getCrossDomainDeps();
    if (xd.length === 0) return text('No cross-domain dependencies found. Clean architecture.');

    const lines = [`# Cross-Domain Dependencies (${xd.length})\n`];
    lines.push('| From File | From Domain | To File | To Domain |');
    lines.push('|-----------|------------|---------|-----------|');
    for (const d of xd) {
      lines.push(`| ${d.from} | ${d.fromDomain} | ${d.to} | ${d.toDomain} |`);
    }
    return text(lines.join('\n'));
  }

  // ── get_context ───────────────────────────────────────────────────────────
  if (name === 'get_context') {
    const ctx = c.getContextForFile(args.file);
    if (!ctx) return text(`File not found: ${args.file}`);

    const lines = [
      `# Context: ${ctx.file}\n`,
      `**Domain:** ${ctx.domain}`,
      `**Imports:** ${ctx.meta.importCount} files`,
      `**Dependents:** ${ctx.meta.dependentCount} files`,
      `**Blast radius risk:** ${ctx.blastRadius ? ctx.blastRadius.risk : 'SAFE'}\n`,
    ];

    if (ctx.routes.length > 0) {
      lines.push('## Routes served by this file');
      for (const r of ctx.routes) lines.push(`- ${r}`);
      lines.push('');
    }

    if (ctx.models.length > 0) {
      lines.push('## Models');
      for (const m of ctx.models) lines.push(`- ${m}`);
      lines.push('');
    }

    if (ctx.envVars.length > 0) {
      lines.push(`## Env vars used: ${ctx.envVars.join(', ')}\n`);
    }

    if (ctx.blastRadius && ctx.blastRadius.domainsImpacted.length > 0) {
      lines.push(`## Domains impacted if changed: ${ctx.blastRadius.domainsImpacted.join(', ')}\n`);
    }

    if (ctx.crossDomainDeps.length > 0) {
      lines.push('## Cross-domain dependencies');
      for (const d of ctx.crossDomainDeps) {
        lines.push(`- ${d.from} (${d.fromDomain}) → ${d.to} (${d.toDomain})`);
      }
      lines.push('');
    }

    if (ctx.neighbors.nodes.length > 0) {
      lines.push(`## Import neighbors (2 hops): ${ctx.neighbors.nodes.length} files`);
      for (const n of ctx.neighbors.nodes.filter(n => !n.isRoot).slice(0, 10)) {
        lines.push(`- ${n.id} [${n.domain}]`);
      }
      if (ctx.neighbors.nodes.length > 11) lines.push(`_...and ${ctx.neighbors.nodes.length - 11} more_`);
      lines.push('');
    }

    if (ctx.domainContext) {
      lines.push('## Domain context');
      lines.push(ctx.domainContext);
    }

    return text(lines.join('\n'));
  }

  // ── search_routes ─────────────────────────────────────────────────────────
  if (name === 'search_routes') {
    const results = c.searchRoutes(args.query);
    if (results.length === 0) return text(`No routes matching: ${args.query}`);

    const lines = [`# Routes matching "${args.query}" (${results.length})\n`];
    lines.push('| Method | Path | File |');
    lines.push('|--------|------|------|');
    for (const r of results) lines.push(`| ${r.method} | ${r.path} | ${r.file} |`);
    return text(lines.join('\n'));
  }

  // ── get_models ────────────────────────────────────────────────────────────
  if (name === 'get_models') {
    const models = c.getModels(args.domain);
    if (models.length === 0) return text(args.domain ? `No models found in domain: ${args.domain}` : 'No models found.');

    const lines = [`# Models${args.domain ? ` — ${args.domain.toUpperCase()}` : ''} (${models.length})\n`];
    lines.push('| Model | Fields | Domain | File |');
    lines.push('|-------|--------|--------|------|');
    for (const m of models) {
      const fields = (m.fields || []).map(f => f.name || f).join(', ') || '—';
      lines.push(`| ${m.name || '—'} | ${fields} | ${m.domain} | ${m.file} |`);
    }
    return text(lines.join('\n'));
  }

  // ── get_high_impact_files ─────────────────────────────────────────────────
  if (name === 'get_high_impact_files') {
    const limit = args.limit || 10;
    const files = c.getHighImpactFiles(limit);
    if (files.length === 0) return text('No high impact files found.');

    const lines = [`# High Impact Files (top ${limit})\n`];
    lines.push('Changing these files has the highest blast radius.\n');
    lines.push('| File | Dependents |');
    lines.push('|------|------------|');
    for (const f of files) lines.push(`| ${f.file} | ${f.dependents} |`);
    return text(lines.join('\n'));
  }

  // ── get_env_vars ──────────────────────────────────────────────────────────
  if (name === 'get_env_vars') {
    const vars = c.getEnvVars(args.domain);
    if (vars.length === 0) return text(args.domain ? `No env vars found in domain: ${args.domain}` : 'No env vars found.');

    const lines = [`# Environment Variables${args.domain ? ` — ${args.domain.toUpperCase()}` : ''} (${vars.length})\n`];
    lines.push('| Variable | Domains | Used in |');
    lines.push('|----------|---------|---------|');
    for (const v of vars) {
      lines.push(`| ${v.name} | ${v.domains.join(', ')} | ${v.files.length} file${v.files.length !== 1 ? 's' : ''} |`);
    }
    return text(lines.join('\n'));
  }

  // ── get_domains_list ──────────────────────────────────────────────────────
  if (name === 'get_domains_list') {
    const domains = c.getDomainsList();
    if (domains.length === 0) return text('No domains detected. Run `carto init` first.');

    const lines = [`# Domains (${domains.length})\n`];
    lines.push('| Domain | Files | Routes | Models |');
    lines.push('|--------|-------|--------|--------|');
    for (const d of domains) {
      lines.push(`| ${d.name} | ${d.fileCount} | ${d.routeCount} | ${d.modelCount} |`);
    }
    return text(lines.join('\n'));
  }

  return text(`Unknown tool: ${name}`);
});

async function main() {
  await getCarto(); // pre-load on startup
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('[CARTO MCP] Fatal:', err.message);
  process.exit(1);
});
