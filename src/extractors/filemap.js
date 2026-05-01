const path = require('path');

/**
 * inferResponsibility(filename, functionCount, routeCount) → string
 *
 * Returns a short description of what a file does.
 * If nothing matches confidently → return "—".
 */
function inferResponsibility(filename, functionCount, routeCount) {
  const base = path.basename(filename).toLowerCase();

  // Skip __init__.py entirely
  if (base === '__init__.py') return null;

  // Check in order, return first match
  if (routeCount > 0) return `API routes (${routeCount} routes)`;
  if (base.includes('collect')) return 'Data collection';
  if (base.includes('rule') || base.includes('check')) return `Rule checks (${functionCount} functions)`;
  if (base.includes('score') || base.includes('scoring')) return 'Scoring logic';
  if (base.includes('llm') || base.includes('ai') || base.includes('ml')) return 'AI/LLM integration';
  if (base.includes('github')) return 'GitHub integration';
  if (base.includes('storage')) return 'Storage operations';
  if (base.includes('drift')) return 'Drift detection';
  if (base.includes('auth')) return 'Authentication';
  if (base.includes('database') || base.includes('db')) return 'Database operations';
  if (base.includes('model')) return 'Data models';
  if (base.includes('test') || base.includes('spec')) return 'Tests';
  if (base.includes('util') || base.includes('helper')) return 'Utilities';
  if (base.includes('config') || base.includes('setting')) return 'Configuration';
  if (base.includes('middleware')) return 'Middleware';
  if (functionCount > 0) return `${functionCount} functions`;

  return '\u2014';
}

module.exports = { inferResponsibility };
