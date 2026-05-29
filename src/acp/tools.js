'use strict';

/**
 * Carto tools exposed to the LLM during the agent loop.
 * These wrap the Carto engine's query methods as tool definitions
 * compatible with OpenAI/Anthropic function calling format.
 */

const CARTO_TOOLS = [
  {
    name: 'get_blast_radius',
    description: 'Get all files, routes, and domains affected by changing a specific file. Use before making changes to understand impact.',
    input_schema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path from project root' } }, required: ['file'] },
  },
  {
    name: 'get_context',
    description: 'Get full structural context for a file: domain, blast radius, import neighbors, routes, models, env vars, and cross-domain dependencies.',
    input_schema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path from project root' } }, required: ['file'] },
  },
  {
    name: 'get_structure',
    description: 'Get project structure: import graph summary, entry points, high impact files, tech stack, and domains.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_domain',
    description: 'Get all routes, models, functions, and context for a specific domain (e.g. AUTH, PAYMENTS, DATABASE, CORE).',
    input_schema: { type: 'object', properties: { domain: { type: 'string', description: 'Domain name e.g. AUTH, PAYMENTS' } }, required: ['domain'] },
  },
  {
    name: 'get_routes',
    description: 'Get all API routes in this project including REST, tRPC, and webhooks.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_change_plan',
    description: 'Given a natural-language intent, returns files to touch, domains affected, blast radius, and similar patterns.',
    input_schema: { type: 'object', properties: { intent: { type: 'string', description: 'What you want to change, e.g. "add rate limiting to /api/users"' } }, required: ['intent'] },
  },
  {
    name: 'get_similar_patterns',
    description: 'Find structurally similar files — same domain, same route shape, or shared dependencies. Use to find conventions before writing new code.',
    input_schema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path' }, limit: { type: 'number', description: 'Max results (default 5)' } }, required: ['file'] },
  },
  {
    name: 'get_neighbors',
    description: 'Get import graph neighbors of a file — files it imports and files that import it.',
    input_schema: { type: 'object', properties: { file: { type: 'string', description: 'Relative file path' }, hops: { type: 'number', description: 'Hops to traverse (default 1, max 3)' } }, required: ['file'] },
  },
  {
    name: 'get_cross_domain',
    description: 'Get all import edges that cross domain boundaries. Use to detect unexpected coupling.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_high_impact_files',
    description: 'Get the files with the highest blast radius — most other files depend on them.',
    input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Number of files (default 10)' } }, required: [] },
  },
  {
    name: 'search_routes',
    description: 'Search API routes by path or method. Case-insensitive.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query e.g. "auth", "POST"' } }, required: ['query'] },
  },
  {
    name: 'get_models',
    description: 'Get all data models (Prisma, Zod, TypeScript interfaces, etc.), optionally filtered by domain.',
    input_schema: { type: 'object', properties: { domain: { type: 'string', description: 'Optional domain filter' } }, required: [] },
  },
];

/**
 * executeTool(name, input, session)
 * Executes a Carto tool and returns the result as a string.
 */
function executeTool(name, input, session) {
  const carto = session.carto;
  if (!carto) return 'Project not indexed. Cannot execute tool.';

  try {
    switch (name) {
      case 'get_blast_radius': {
        const result = carto.getBlastRadius(input.file);
        if (!result) return `File not found: ${input.file}`;
        return JSON.stringify(result, null, 2);
      }
      case 'get_context': {
        const result = carto.getContextForFile(input.file);
        if (!result) return `File not found: ${input.file}`;
        return JSON.stringify(result, null, 2);
      }
      case 'get_structure': {
        const s = carto.getStructure();
        return JSON.stringify({
          stack: s.stack,
          domains: s.domains,
          entryPoints: s.entryPoints,
          highImpact: (s.highImpact || []).slice(0, 10),
          meta: s.meta,
        }, null, 2);
      }
      case 'get_domain': {
        const result = carto.getDomain(input.domain);
        if (!result) return `Domain not found: ${input.domain}`;
        return JSON.stringify(result, null, 2);
      }
      case 'get_routes': {
        return JSON.stringify(carto.getRoutes(), null, 2);
      }
      case 'get_change_plan': {
        // Synthesize a change plan from structural data
        const routes = carto.searchRoutes(input.intent);
        const structure = carto.getStructure();
        const domains = carto.getDomainsList();
        return JSON.stringify({ matchingRoutes: routes, domains, highImpact: (structure.highImpact || []).slice(0, 5) }, null, 2);
      }
      case 'get_similar_patterns': {
        // Find files in same domain with similar structure
        const ctx = carto.getContextForFile(input.file);
        if (!ctx) return `File not found: ${input.file}`;
        const domain = carto.getDomain(ctx.domain);
        const limit = input.limit || 5;
        const similar = (domain && domain.files || []).filter(f => f !== input.file).slice(0, limit);
        return JSON.stringify({ domain: ctx.domain, similarFiles: similar }, null, 2);
      }
      case 'get_neighbors': {
        const result = carto.getNeighbors(input.file, input.hops || 1);
        return JSON.stringify(result, null, 2);
      }
      case 'get_cross_domain': {
        return JSON.stringify(carto.getCrossDomainDeps().slice(0, 50), null, 2);
      }
      case 'get_high_impact_files': {
        return JSON.stringify(carto.getHighImpactFiles(input.limit || 10), null, 2);
      }
      case 'search_routes': {
        return JSON.stringify(carto.searchRoutes(input.query), null, 2);
      }
      case 'get_models': {
        return JSON.stringify(carto.getModels(input.domain), null, 2);
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error (${name}): ${err.message}`;
  }
}

module.exports = { CARTO_TOOLS, executeTool };
