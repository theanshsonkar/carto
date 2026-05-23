#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { run: runImpact } = require('../cli/impact');

const projectRoot = process.cwd();

function readMap() {
  const mapPath = path.join(projectRoot, '.carto', 'map.json');
  try {
    return JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
  } catch {
    return null;
  }
}

function readDomainFile(domain) {
  const filePath = path.join(projectRoot, '.carto', 'context', `${domain.toUpperCase()}.md`);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

const server = new Server(
  { name: 'carto', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_routes',
      description: 'Get all API routes in this project including REST and tRPC procedures.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'get_blast_radius',
      description: 'Get all files and routes affected by changing a specific file.',
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
      description: 'Get project structure: import graph, entry points, high impact files, and tech stack.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'get_domain',
      description: 'Get all routes, models, and functions for a specific domain (AUTH, PAYMENTS, TRPC, DATABASE, EVENTS, NOTIFICATIONS, CORE).',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain name: AUTH, PAYMENTS, TRPC, DATABASE, EVENTS, NOTIFICATIONS, or CORE' }
        },
        required: ['domain']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const map = readMap();

  if (!map) {
    return {
      content: [{ type: 'text', text: 'No .carto/map.json found. Run `carto init` first.' }]
    };
  }

  if (name === 'get_routes') {
    if (!map.routes || map.routes.length === 0) {
      return { content: [{ type: 'text', text: 'No routes found.' }] };
    }
    const lines = ['# All Routes\n'];
    lines.push('| Method | Path | Handler |');
    lines.push('|--------|------|---------|');
    for (const r of map.routes) {
      lines.push(`| ${r.method} | ${r.path} | ${r.functionName} |`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'get_blast_radius') {
    const file = args.file;
    if (!file) {
      return { content: [{ type: 'text', text: 'File argument required.' }] };
    }

    const imports = map.imports || {};
    const routesByFile = map.routesByFile || {};

    // Build reverse graph
    const importedBy = {};
    for (const [f, deps] of Object.entries(imports)) {
      for (const dep of deps) {
        if (!importedBy[dep]) importedBy[dep] = [];
        importedBy[dep].push(f);
      }
    }

    // Find matched file
    let matched = null;
    if (imports[file] || importedBy[file] || routesByFile[file]) {
      matched = file;
    } else {
      const allFiles = new Set([...Object.keys(imports), ...Object.keys(importedBy), ...Object.keys(routesByFile)]);
      for (const f of allFiles) {
        if (f.endsWith(file) || path.basename(f) === path.basename(file)) {
          matched = f;
          break;
        }
      }
    }

    if (!matched) {
      return { content: [{ type: 'text', text: `File not found in graph: ${file}` }] };
    }

    // BFS up to 3 hops
    const visited = new Set([matched]);
    let frontier = [matched];
    for (let hop = 0; hop < 3; hop++) {
      const next = [];
      for (const f of frontier) {
        for (const dep of (importedBy[f] || [])) {
          if (!visited.has(dep)) { visited.add(dep); next.push(dep); }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    visited.delete(matched);

    // Collect affected routes
    const affectedRoutes = new Set();
    for (const f of [matched, ...visited]) {
      for (const r of (routesByFile[f] || [])) affectedRoutes.add(r);
    }

    const lines = [`# Blast Radius: ${matched}\n`];

    if (visited.size > 0) {
      lines.push(`## Files affected (${visited.size})`);
      for (const f of [...visited].sort()) lines.push(`- ${f}`);
    } else {
      lines.push('## Files affected\n_No dependents found._');
    }

    lines.push('');
    if (affectedRoutes.size > 0) {
      lines.push(`## Routes at risk (${affectedRoutes.size})`);
      for (const r of [...affectedRoutes].sort()) lines.push(`- ${r}`);
    } else {
      lines.push('## Routes at risk\n_None directly traceable._');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'get_structure') {
    const lines = ['# Project Structure\n'];
    if (map.stack && map.stack.length > 0) {
      lines.push(`**Stack:** ${map.stack.join(', ')}\n`);
    }
    if (map.entryPoints && map.entryPoints.length > 0) {
      lines.push('## Entry Points');
      for (const e of map.entryPoints) lines.push(`- ${e}`);
      lines.push('');
    }
    if (map.highImpact && map.highImpact.length > 0) {
      lines.push('## High Impact Files');
      lines.push('| File | Dependents |');
      lines.push('|------|------------|');
      for (const h of map.highImpact) lines.push(`| ${h.file} | ${h.dependents} |`);
      lines.push('');
    }
    if (map.imports && Object.keys(map.imports).length > 0) {
      lines.push('## Import Graph');
      for (const [f, deps] of Object.entries(map.imports)) {
        lines.push(`${f} → ${deps.join(', ')}`);
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'get_domain') {
    const domain = (args.domain || '').toUpperCase();
    const content = readDomainFile(domain);
    if (!content) {
      return { content: [{ type: 'text', text: `No domain file found for ${domain}. Available: AUTH, PAYMENTS, TRPC, DATABASE, EVENTS, NOTIFICATIONS, CORE` }] };
    }
    return { content: [{ type: 'text', text: content }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('[CARTO MCP] Fatal:', err.message);
  process.exit(1);
});
