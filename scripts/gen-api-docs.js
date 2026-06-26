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

function loadTools() {
  // Cheap eval — extract the TOOLS array literal from server.js so we
  // don't have to wire MCP server startup just to read tool definitions.
  // We require() the module and read the captured TOOLS via a re-export.
  const serverPath = path.join(projectRoot, 'src', 'mcp', 'server.js');
  const src = fs.readFileSync(serverPath, 'utf-8');
  // Find the `const TOOLS = [` block.
  const startIdx = src.indexOf('const TOOLS = [');
  if (startIdx === -1) throw new Error('TOOLS array not found in server.js');
  // Walk forward, balancing brackets.
  let depth = 0, i = startIdx;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  const arrayLiteral = src.slice(startIdx + 'const TOOLS = '.length, i);
  // eslint-disable-next-line no-eval
  const TOOLS = (new Function(`return ${arrayLiteral}`))();
  return TOOLS;
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
  for (const t of tools) {
    let group = 'Other';
    if (t.name.startsWith('get_arch') || t.name.startsWith('get_domain_evolution') || t.name.startsWith('get_hotspot') ||
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
  const order = ['Core graph', 'Episodic Memory', 'Temporal', 'Brain', 'AI-native', 'Adjacent', 'Predictive', 'Org-wide', 'Other'];
  const sorted = new Map();
  for (const g of order) if (groups.has(g)) sorted.set(g, groups.get(g));
  return sorted;
}

function toolMarkdown(t) {
  const lines = [
    `# \`${t.name}\``,
    '',
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
  ];
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
  if (!dry) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  let written = 0;
  for (const t of tools) {
    const p = path.join(docsDir, `${t.name}.md`);
    const md = toolMarkdown(t);
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
