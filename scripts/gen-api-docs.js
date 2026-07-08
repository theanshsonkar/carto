'use strict';

/**
 * scripts/gen-api-docs.js — generate `docs/api/<tool>.md` for every MCP
 * tool registered in `src/mcp/server.js`. Re-run after adding a new tool.
 *
 * Usage:
 *   node scripts/gen-api-docs.js              # writes docs/api/
 *   node scripts/gen-api-docs.js --dry-run    # print to stdout, no writes
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const docsDir = path.join(projectRoot, 'docs', 'api');

function extractArrayLiteral(src, decl) {
  const startIdx = src.indexOf(decl);
  if (startIdx === -1) return null;
  let depth = 0, i = startIdx;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  const arrayLiteral = src.slice(startIdx + decl.length, i);
  // eslint-disable-next-line no-new-func
  return (new Function(`return ${arrayLiteral}`))();
}

function loadTools() {
  // Cheap eval — extract the tool array literals from server.js so we
  // don't have to wire MCP server startup just to read tool definitions.
  // CF-7: the listable surface is the 5 parameterized FAMILY_TOOLS plus
  // the kept singletons in TOOLS. Both are documented; collapsed old names
  // stay in TOOLS (still documented as deprecated shims).
  const serverPath = path.join(projectRoot, 'src', 'mcp', 'server.js');
  const src = fs.readFileSync(serverPath, 'utf-8');
  const TOOLS = extractArrayLiteral(src, 'const TOOLS = ');
  if (!TOOLS) throw new Error('TOOLS array not found in server.js');
  const FAMILY_TOOLS = extractArrayLiteral(src, 'const FAMILY_TOOLS = ') || [];
  // Families first, then the kept/collapsed singletons.
  return [...FAMILY_TOOLS, ...TOOLS];
}

function indexMarkdown(tools) {
  const groups = groupByPrefix(tools);
  const lines = [
    '# Carto MCP Tools — API Reference',
    '',
    'Auto-generated from `src/mcp/server.js`. Re-run `node scripts/gen-api-docs.js` after adding tools.',
    '',
    `**${tools.length} tools** across ${groups.size} categories.`,
    '',
    '## Tool surface & tiers (CF-7)',
    '',
    'The MCP surface is collapsed into **5 parameterized families** + a tiered set of singletons.',
    'Which tools are *listed* to a client is gated by `CARTO_MCP_TIER` (env) or `carto.config.json` `mcp.tier`:',
    '',
    '- **core** (default): the ~10 tools every session needs — `get_architecture`, `get_context`, `impact`, `validate_diff`, `get_change_plan`, `memory`, `get_predictive_risk`, `get_minimal_context_for_intent`, `patterns`, `history`.',
    '- **advanced**: core + the documented ~8 (e.g. `org`, `get_routes`, `get_models`, `get_gaps`, `scaffold_for_intent`, `get_working_memory`, `get_test_coverage_map`, `get_safety_checklist`).',
    '- **all**: also lists experimental singletons.',
    '',
    'The **Families** collapse ~30 former tools; those old names are **deprecated shims** — they still',
    'resolve (byte-identical output + a one-line deprecation notice) but are never listed. See each',
    'family doc for the `mode`/`kind`/`view` that replaces the old tool.',
    '',
    '## Categories',
    '',
  ];
  for (const [groupName, names] of groups) {
    lines.push(`### ${groupName} (${names.length})`);
    for (const n of names) {
      lines.push(`- [\`${n}\`](./${n}.md)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function groupByPrefix(tools) {
  // Group by the first prefix segment of the tool name.
  const groups = new Map();
  const FAMILY = new Set(['impact', 'memory', 'history', 'patterns', 'org']);
  for (const t of tools) {
    let group = 'Other';
    if (FAMILY.has(t.name)) group = 'Families';
    else if (t.name.startsWith('get_arch') || t.name.startsWith('get_domain_evolution') || t.name.startsWith('get_hotspot') ||
        t.name.startsWith('get_complexity') || t.name.startsWith('get_churn') || t.name.startsWith('get_domain_health') ||
        t.name.startsWith('get_temporal') || t.name === 'get_architectural_drift') group = 'Temporal';
    else if (t.name === 'get_invariants' || t.name === 'get_canonical_pattern' || t.name === 'get_conventions' ||
             t.name === 'get_action_patterns' || t.name === 'scaffold_for_intent' || t.name === 'get_working_memory' ||
             t.name === 'get_pending_decisions' || t.name === 'get_active_drift' || t.name === 'get_active_suggestions' ||
             t.name === 'dismiss_suggestion') group = 'Brain';
    else if (t.name === 'get_minimal_context_for_intent' || t.name === 'get_progressive_disclosure_tree' ||
             t.name === 'get_token_budget_report' || t.name === 'get_decision_log' || t.name === 'get_evolution_delta' ||
             t.name === 'get_change_velocity' || t.name === 'get_test_coverage_map' || t.name === 'get_safety_checklist' ||
             t.name === 'get_data_flow' || t.name === 'get_interface_contract' || t.name === 'explain_change_in_natural_language' ||
             t.name === 'get_stale_docs' || t.name === 'get_dependency_surface' || t.name === 'get_upgrade_risk') group = 'AI-native';
    else if (t.name.startsWith('get_cross_language') || t.name === 'get_iac_resources' ||
             t.name === 'ingest_otlp_traces' || t.name === 'get_risk_weighted_blast_radius' ||
             t.name === 'get_dead_code_with_confidence' || t.name === 'get_hot_in_prod_no_tests' ||
             t.name === 'get_semantic_diff' || t.name === 'get_llm_enrichment') group = 'Adjacent';
    else if (t.name === 'get_predictive_risk' || t.name === 'get_microservice_cut_points' || t.name === 'validate_change' ||
             t.name === 'get_file_ownership' || t.name === 'get_cross_team_coupling' || t.name === 'get_drift_digest' ||
             t.name === 'get_ai_cost_attribution') group = 'Predictive';
    else if (t.name === 'get_org_architecture' || t.name === 'get_service_dependency_graph' ||
             t.name === 'get_cross_repo_blast_radius' || t.name === 'find_consumers_of_api' ||
             t.name === 'get_org_domain_mapping' || t.name === 'get_service_boundary_violations' ||
             t.name === 'get_microservices_migration_cut_points') group = 'Org-wide';
    else if (t.name === 'validate_diff' || t.name === 'get_recent_decisions' || t.name === 'get_session_context' ||
             t.name === 'did_we_discuss_this' || t.name === 'get_intervention_history') group = 'Episodic Memory';
    else group = 'Core graph';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(t.name);
  }
  const order = ['Families', 'Core graph', 'Episodic Memory', 'Temporal', 'Brain', 'AI-native', 'Adjacent', 'Predictive', 'Org-wide', 'Other'];
  const sorted = new Map();
  for (const g of order) if (groups.has(g)) sorted.set(g, groups.get(g));
  return sorted;
}

function toolMarkdown(t, deprecations) {
  const replacement = deprecations && deprecations[t.name];
  const lines = [
    `# \`${t.name}\``,
    '',
  ];
  if (replacement) {
    lines.push(`> ⚠️ **Deprecated (CF-7).** Use \`${replacement}\` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.`);
    lines.push('');
  }
  lines.push(
    t.description || '_(no description)_',
    '',
    '## Input schema',
    '',
    '```json',
    JSON.stringify(t.inputSchema || { type: 'object' }, null, 2),
    '```',
    '',
    '## Required arguments',
    '',
  );
  const required = (t.inputSchema && t.inputSchema.required) || [];
  if (required.length === 0) lines.push('_None._');
  else for (const r of required) lines.push(`- \`${r}\``);
  lines.push('');
  lines.push('## Properties');
  lines.push('');
  const props = (t.inputSchema && t.inputSchema.properties) || {};
  if (Object.keys(props).length === 0) lines.push('_None._');
  else {
    lines.push('| Name | Type | Description |');
    lines.push('|------|------|-------------|');
    for (const [name, schema] of Object.entries(props)) {
      const type = schema.type || (schema.items ? `array<${schema.items.type || 'string'}>` : 'any');
      const desc = (schema.description || '').replace(/\|/g, '\\|');
      lines.push(`| \`${name}\` | ${type} | ${desc} |`);
    }
  }
  lines.push('');
  lines.push('## See also');
  lines.push('');
  lines.push('- [Index of all MCP tools](./README.md)');
  return lines.join('\n');
}

function main() {
  const dry = process.argv.includes('--dry-run');
  const tools = loadTools();
  // Deprecation map lives in the server module; used only to annotate docs.
  let deprecations = {};
  try { deprecations = require(path.join(projectRoot, 'src', 'mcp', 'server.js')).DEPRECATIONS || {}; } catch { /* best-effort */ }
  if (!dry) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  let written = 0;
  for (const t of tools) {
    const p = path.join(docsDir, `${t.name}.md`);
    const md = toolMarkdown(t, deprecations);
    if (dry) {
      console.log(`\n=== ${p} ===\n${md}\n`);
    } else {
      fs.writeFileSync(p, md, 'utf-8');
      written++;
    }
  }
  const indexPath = path.join(docsDir, 'README.md');
  const indexMd = indexMarkdown(tools);
  if (!dry) fs.writeFileSync(indexPath, indexMd, 'utf-8');

  if (dry) console.log(`\n[dry-run] would write ${tools.length + 1} files.`);
  else console.log(`[CARTO] Generated ${written} per-tool docs + 1 index → docs/api/`);
  return tools.length;
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exit(1); }
}

module.exports = { loadTools, toolMarkdown, indexMarkdown, main };
