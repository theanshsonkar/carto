'use strict';

/**
 * AI-native tool implementations.
 *
 * 14 MCP tools, organized by capability:
 *
 *   Token efficiency (3):
 *     - get_minimal_context_for_intent
 *     - get_progressive_disclosure_tree
 *     - get_token_budget_report
 *
 *   Temporal-dependent (3) — require `carto temporal init`:
 *     - get_decision_log
 *     - get_evolution_delta
 *     - get_change_velocity
 *
 *   Code-level intelligence (8):
 *     - get_test_coverage_map
 *     - get_safety_checklist
 *     - get_data_flow
 *     - get_interface_contract
 *     - explain_change_in_natural_language
 *     - get_stale_docs
 *     - get_dependency_surface
 *     - get_upgrade_risk
 *
 * Each function takes `({ store, projectRoot, temporalStore, args })` and
 * returns a plain object the MCP layer formats as markdown.
 */

const path = require('path');
const fs = require('fs');
const { getMinimalContextForIntent, getProgressiveDisclosureTree, getTokenBudgetReport } = require('./context-builder');

// ── Token efficiency tools ────────────────────────────────────────

function minimalContext(args, ctx) {
  return getMinimalContextForIntent({
    store: ctx.store, projectRoot: ctx.projectRoot,
    intent: args.intent, budgetTokens: args.budget_tokens,
    temporalStore: ctx.temporalStore,
  });
}

function progressiveDisclosure(_args, ctx) {
  return getProgressiveDisclosureTree({ store: ctx.store });
}

function tokenBudget(args, ctx) {
  return getTokenBudgetReport({
    store: ctx.store, projectRoot: ctx.projectRoot,
    intent: args.intent || '', budgetTokens: args.budget_tokens,
    temporalStore: ctx.temporalStore,
  });
}

// ── Temporal-dependent tools ──────────────────────────────────────

function decisionLog(args, ctx) {
  const { store, temporalStore } = ctx;
  if (!store) return { decisions: [] };
  const hours = args.hours || 168; // default 7 days
  const since = Date.now() - hours * 60 * 60 * 1000;
  const decisions = store.db.prepare(`
    SELECT id, session_id, ts, kind, file, payload_json
    FROM decisions WHERE ts >= ?
    ORDER BY ts DESC LIMIT 200
  `).all(since);
  // Annotate with architectural-event context from temporal store, if available
  let events = [];
  if (temporalStore) {
    try {
      events = temporalStore.getArchEvents({ sinceTs: since, limit: 50 });
    } catch {}
  }
  return { decisions, events, since_ts: since, hours };
}

function evolutionDelta(args, ctx) {
  if (!ctx.temporalStore) return { delta: null, reason: 'no_temporal' };
  const q = require('../temporal/queries');
  const drift = q.getArchitecturalDrift(ctx.temporalStore, { domain: args.domain, timeRange: args.time_range || '30d' });
  return { delta: drift };
}

function changeVelocity(args, ctx) {
  if (!ctx.temporalStore) return { reason: 'no_temporal', velocity: null };
  const sinceTs = Date.now() - (args.days || 30) * 86_400_000;
  // Count commits per day from snapshots
  const rows = ctx.temporalStore.db.prepare(`
    SELECT DATE(ts/1000, 'unixepoch') as day, COUNT(*) as commits
    FROM snapshots WHERE source = 'commit' AND ts >= ?
    GROUP BY day ORDER BY day ASC
  `).all(sinceTs);
  const total = rows.reduce((s, r) => s + r.commits, 0);
  const days = Math.max(1, rows.length);
  return {
    days_observed: days,
    total_commits: total,
    avg_commits_per_day: Math.round((total / days) * 10) / 10,
    daily: rows,
  };
}

// ── Code-level intelligence tools ─────────────────────────────────

function testCoverageMap(args, ctx) {
  const { store, projectRoot } = ctx;
  if (!store) return { files: [] };
  const { filesWithoutTests } = require('../mcp/files-without-tests');
  const all = store.db.prepare('SELECT path FROM files LIMIT 1000').all();
  const candidates = all.map(r => r.path);
  const result = filesWithoutTests(projectRoot, candidates);
  // Score: blast_radius × (no_test ? 1 : 0)
  const filesByPath = new Map(all.map(r => [r.path, r]));
  const items = [];
  for (const f of (result.files || [])) {
    const row = filesByPath.get(f);
    const file = store.getFileByPath(f);
    items.push({ path: f, has_test: false, blast_radius: file ? file.centrality || 0 : 0 });
  }
  items.sort((a, b) => b.blast_radius - a.blast_radius);
  return {
    considered: result.considered,
    untested: result.files,
    by_blast_radius: items.slice(0, 50),
  };
}

function safetyChecklist(args, ctx) {
  if (!args.file) return { items: [] };
  const { store } = ctx;
  const items = [];
  const file = store ? store.getFileByPath(args.file) : null;
  if (!file) return { items: [{ severity: 'critical', message: `File not in index: ${args.file}` }] };

  // 1. Blast radius warning
  const deps = store.getBlastRadius(args.file) || [];
  if (deps.length >= 20) {
    items.push({ severity: 'major', message: `Blast radius ${deps.length} — affects ${deps.length} files` });
  } else if (deps.length >= 5) {
    items.push({ severity: 'minor', message: `Blast radius ${deps.length} — review impacted files` });
  }

  // 2. Cross-domain coupling
  const cross = store.getCrossDomainDeps() || [];
  const isCross = cross.some(e => e.from === args.file);
  if (isCross) items.push({ severity: 'major', message: 'File imports across domain boundaries' });

  // 3. No tests
  try {
    const { filesWithoutTests } = require('../mcp/files-without-tests');
    const fwt = filesWithoutTests(ctx.projectRoot, [args.file]);
    if (fwt.files && fwt.files.length > 0) {
      items.push({ severity: 'major', message: 'No test file detected for this source' });
    }
  } catch {}

  // 4. Temporal hotspot
  if (ctx.temporalStore) {
    try {
      const ch = ctx.temporalStore.getFileChurn(args.file);
      if (ch && ch.commit_count >= 5 && (ch.blast_radius || 0) >= 10) {
        items.push({ severity: 'critical', message: `Hotspot: ${ch.commit_count} commits × blast ${ch.blast_radius}` });
      }
    } catch {}
  }

  // 5. Open interventions
  try {
    const ivs = store.getInterventionsForFile(args.file) || [];
    const open = ivs.filter(i => !i.accepted && (i.severity === 'HIGH' || i.severity === 'critical'));
    if (open.length > 0) {
      items.push({ severity: 'major', message: `${open.length} unresolved HIGH-severity intervention(s)` });
    }
  } catch {}

  if (items.length === 0) items.push({ severity: 'safe', message: 'No safety concerns detected' });
  return { file: args.file, items };
}

function dataFlow(args, ctx) {
  // Surface the import-edge chain that data could traverse from a source
  // file to its consumers and dependencies. 2-hop snapshot using existing
  // graph queries — meant as the AI-friendly view, not a full taint analysis.
  if (!args.file || !ctx.store) return { source: args.file, upstream: [], downstream: [] };
  const { store } = ctx;
  const file = store.getFileByPath(args.file);
  if (!file) return { source: args.file, imports: [], imported_by: [] };

  // Imports + imported-by from imports table.
  const imports = store.db.prepare(`
    SELECT to_path as path FROM imports WHERE from_file_id = ?
  `).all(file.id);
  const importedBy = store.db.prepare(`
    SELECT f.path as path FROM imports i JOIN files f ON i.from_file_id = f.id
    WHERE i.to_file_id = ?
  `).all(file.id);
  const routes = store.db.prepare('SELECT method, path FROM routes WHERE file_id = ?').all(file.id);
  const models = store.db.prepare('SELECT name, kind FROM models WHERE file_id = ?').all(file.id);
  const envVars = store.db.prepare('SELECT name FROM env_vars WHERE file_id = ?').all(file.id).map(r => r.name);
  const domain = file.domain_id ? (store.db.prepare('SELECT name FROM domains WHERE id = ?').get(file.domain_id) || {}).name : null;

  return {
    source: args.file,
    domain,
    imports,
    imported_by: importedBy,
    routes_in_file: routes,
    models_in_file: models,
    env_vars: envVars,
  };
}

function interfaceContract(args, ctx) {
  // Exported symbols + their kinds + types. The "what does this module
  // expose?" tool.
  if (!args.file || !ctx.store) return { file: args.file, exports: [] };
  const { store } = ctx;
  const f = store.getFileByPath(args.file);
  if (!f) return { file: args.file, exports: [] };
  const symbols = store.db.prepare(`
    SELECT name, kind, is_default_export FROM symbols WHERE file_id = ? AND exported = 1
  `).all(f.id);
  // Also include models declared in the file
  const models = store.db.prepare(`
    SELECT name, kind, fields_json FROM models WHERE file_id = ?
  `).all(f.id).map(m => ({ name: m.name, kind: m.kind, fields: tryParse(m.fields_json) }));
  const routes = store.db.prepare(`
    SELECT method, path FROM routes WHERE file_id = ?
  `).all(f.id);
  return {
    file: args.file,
    domain: f.domain_id ? (store.db.prepare('SELECT name FROM domains WHERE id = ?').get(f.domain_id) || {}).name : null,
    exports: symbols,
    models,
    routes,
  };
}

function explainChange(args, ctx) {
  // Lightweight diff explanation: pull validate_diff output + format as
  // a single paragraph for AI consumption.
  if (!args.diff || !ctx.store) return { summary: 'No diff provided' };
  const { validateDiff } = require('../mcp/validate');
  const result = validateDiff(ctx.store, ctx.sidecar || null, args.diff);

  const filesChanged = result.diff || [];

  const lines = [];
  lines.push(`Risk: **${result.risk}**.`);
  lines.push(`${filesChanged.length} file(s) changed; union blast radius ${result.blast_radius.union}.`);
  if (result.violations.length > 0) {
    lines.push(`${result.violations.length} violation(s) detected:`);
    for (const v of result.violations.slice(0, 5)) {
      lines.push(`  - ${v.severity} ${v.kind}: ${v.detail || v.file || ''}`);
    }
  } else {
    lines.push('No violations detected.');
  }
  if (result.suggestions && result.suggestions.length > 0) {
    lines.push(`Suggestions:`);
    for (const s of result.suggestions.slice(0, 3)) lines.push(`  - ${s}`);
  }
  return {
    summary: lines.join('\n'),
    risk: result.risk,
    files_changed: filesChanged,
    violations: result.violations,
    suggestions: result.suggestions,
  };
}

function staleDocs(args, ctx) {
  // Files in `docs/` whose mtime is older than the most recent commit
  // touching a related source file (heuristic: same directory or same
  // domain). Surfaces docs that need refresh.
  const { projectRoot, store } = ctx;
  if (!projectRoot) return { stale: [] };
  const docsDir = path.join(projectRoot, 'docs');
  if (!fs.existsSync(docsDir)) return { stale: [] };

  const stale = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.(md|mdx|rst|txt)$/i.test(e.name)) {
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
        // Heuristic: docs not touched in the last 30 days are candidates.
        // A finer check would use temporal commit timestamps; this is good
        // enough as a first pass.
        const ageDays = (Date.now() - stat.mtimeMs) / 86_400_000;
        if (ageDays > 30) {
          stale.push({ path: rel, age_days: Math.round(ageDays) });
        }
      }
    }
  };
  walk(docsDir);
  stale.sort((a, b) => b.age_days - a.age_days);
  return { stale: stale.slice(0, 50) };
}

function dependencySurface(args, ctx) {
  // Reads package.json (or pyproject.toml / Cargo.toml / go.mod) and
  // returns a deduped list of external deps + their pinned versions.
  const { projectRoot } = ctx;
  if (!projectRoot) return { deps: [] };
  const out = [];

  // Node: package.json
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      for (const [name, v] of Object.entries(pkg.dependencies || {})) {
        out.push({ ecosystem: 'npm', name, version: String(v), kind: 'runtime' });
      }
      for (const [name, v] of Object.entries(pkg.devDependencies || {})) {
        out.push({ ecosystem: 'npm', name, version: String(v), kind: 'dev' });
      }
    } catch {}
  }

  // Python: pyproject.toml — coarse regex
  const pyproject = path.join(projectRoot, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    try {
      const text = fs.readFileSync(pyproject, 'utf-8');
      const block = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|\Z)/.exec(text);
      if (block) {
        for (const line of block[1].split('\n')) {
          const m = /^\s*([A-Za-z][\w\-]+)\s*=\s*["']([^"']+)["']/.exec(line);
          if (m) out.push({ ecosystem: 'pypi', name: m[1], version: m[2], kind: 'runtime' });
        }
      }
    } catch {}
  }

  // Go: go.mod
  const gomod = path.join(projectRoot, 'go.mod');
  if (fs.existsSync(gomod)) {
    try {
      const text = fs.readFileSync(gomod, 'utf-8');
      const requireBlock = /require\s*\(([^)]*)\)/m.exec(text);
      if (requireBlock) {
        for (const line of requireBlock[1].split('\n')) {
          const m = /^\s*([\w./\-]+)\s+(\S+)/.exec(line);
          if (m) out.push({ ecosystem: 'go', name: m[1], version: m[2], kind: 'runtime' });
        }
      }
    } catch {}
  }

  return { deps: out, count: out.length };
}

function upgradeRisk(args, ctx) {
  // Cross-references `args.deps` (or all package.json deps) against the
  // import graph. A dep used by N files in M domains is high-risk to bump.
  // Surfaces usage counts and a coarse per-dep risk score.
  const surface = dependencySurface({}, ctx);
  const { store } = ctx;
  if (!store || !store.db || !surface.deps) return { risks: [] };

  const usage = new Map(); // dep name → { files, domains }
  // Walk imports.to_path: any to_path that starts with a known dep name
  // (npm) or contains the dep name (Go/Python) is a usage.
  const allImports = store.db.prepare('SELECT from_file_id, to_path FROM imports').all();
  const filesById = new Map(store.db.prepare('SELECT id, path, domain_id FROM files').all().map(r => [r.id, r]));
  for (const dep of surface.deps) {
    let count = 0;
    const domains = new Set();
    for (const imp of allImports) {
      if (!imp.to_path) continue;
      // npm style match: import starts with dep name OR matches @scope/dep
      if (imp.to_path === dep.name || imp.to_path.startsWith(dep.name + '/') ||
          imp.to_path.startsWith(dep.name + '\\')) {
        count++;
        const f = filesById.get(imp.from_file_id);
        if (f && f.domain_id) domains.add(f.domain_id);
      }
    }
    if (count > 0) {
      const risk = count >= 50 ? 'HIGH' : count >= 10 ? 'MEDIUM' : 'LOW';
      usage.set(dep.name, { count, domains: domains.size, risk, version: dep.version });
    }
  }

  const out = Array.from(usage.entries()).map(([name, u]) => ({
    name, count: u.count, domains: u.domains, risk: u.risk, version: u.version,
  }));
  out.sort((a, b) => b.count - a.count);
  return { risks: out };
}

function tryParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = {
  minimalContext,
  progressiveDisclosure,
  tokenBudget,
  decisionLog,
  evolutionDelta,
  changeVelocity,
  testCoverageMap,
  safetyChecklist,
  dataFlow,
  interfaceContract,
  explainChange,
  staleDocs,
  dependencySurface,
  upgradeRisk,
};
