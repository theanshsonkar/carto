'use strict';

/**
 * Context builder — token-budgeted context construction.
 *
 * Powers `get_minimal_context_for_intent(intent, budget_tokens)`.
 *
 * Given a natural-language intent and a token budget (default 4000),
 * produce the minimum context needed to understand the intent — typically
 * an order of magnitude tighter than raw embedding retrieval.
 *
 * Pipeline:
 *   1. Run hybrid retrieval (structural + lexical + semantic) for `intent`.
 *   2. RRF-fuse channels with score boosts (high-blast, same-domain bias).
 *   3. Estimate token cost per file (~chars/4 for English-and-code; cap
 *      at 4096 tokens per file).
 *   4. Pack files into the budget greedily: include file path + a summary
 *      (top 5 exports + blast-radius callout) when content would exceed
 *      remaining budget; include short files in full.
 *   5. Emit a markdown context block + per-file token usage report.
 */

const path = require('path');
const fs = require('fs');
const { searchFts, ensureFtsIndex } = require('./retrieval/lexical');
const { structuralSearch } = require('./retrieval/structural');
const { semanticSearch } = require('./retrieval/semantic');
const { fuse, computeBoosts } = require('./retrieval/rrf');

const DEFAULT_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;     // conservative estimate for mixed code+prose
const MAX_FILE_TOKENS = 4096;  // cap any single file's contribution

/**
 * getMinimalContextForIntent({ store, projectRoot, intent, budgetTokens }) → result
 *
 * Result shape:
 *   {
 *     intent, budget_tokens, used_tokens,
 *     files: [{ path, tokens, include: 'full' | 'summary', score }],
 *     dropped: [{ path, tokens, reason }],
 *     markdown,
 *   }
 */
function getMinimalContextForIntent({ store, projectRoot, intent, budgetTokens = DEFAULT_BUDGET, temporalStore = null }) {
  if (!store || !intent) return { intent, files: [], dropped: [], markdown: '', used_tokens: 0, budget_tokens: budgetTokens };

  // 1. Ensure FTS index is populated (idempotent + cheap if already built).
  ensureFtsIndex(store);

  // 2. Run retrieval channels.
  const lex = searchFts(store, intent, { limit: 30 });
  const struct = structuralSearch(store, intent, { limit: 30 });
  const sem = semanticSearch(store, intent, { limit: 30 });

  // 3. Compute boosts.
  let recentChurn = null;
  if (temporalStore) {
    try { recentChurn = temporalStore.getTopChurned(30); } catch {}
  }
  const boosts = computeBoosts(store, { highBlast: true, recentChurn });

  // 4. Fuse.
  const ranked = fuse({ lexical: lex, structural: struct, semantic: sem }, { boosts, limit: 30 });
  if (ranked.length === 0) return { intent, files: [], dropped: [], markdown: '_No matching context._', used_tokens: 0, budget_tokens: budgetTokens };

  // 5. Pack into budget.
  const root = projectRoot || process.cwd();
  const included = [];
  const dropped = [];
  let used = 0;

  for (const item of ranked) {
    if (used >= budgetTokens) {
      dropped.push({ path: item.path, tokens: 0, reason: 'budget_exhausted' });
      continue;
    }
    const full = path.resolve(root, item.path);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const sizeTokens = Math.min(MAX_FILE_TOKENS, Math.ceil(stat.size / CHARS_PER_TOKEN));

    if (used + sizeTokens <= budgetTokens) {
      included.push({ path: item.path, tokens: sizeTokens, include: 'full', score: item.score });
      used += sizeTokens;
    } else {
      // Summary fallback: ~200 tokens estimate
      const summaryTokens = 200;
      if (used + summaryTokens <= budgetTokens) {
        included.push({ path: item.path, tokens: summaryTokens, include: 'summary', score: item.score });
        used += summaryTokens;
      } else {
        dropped.push({ path: item.path, tokens: sizeTokens, reason: 'no_budget' });
      }
    }
  }

  // 6. Render markdown.
  const md = renderContextMarkdown({ intent, included, dropped, used, budgetTokens, store });
  return {
    intent, budget_tokens: budgetTokens, used_tokens: used,
    files: included, dropped, markdown: md,
  };
}

function renderContextMarkdown({ intent, included, dropped, used, budgetTokens, store }) {
  const lines = [`# Minimal Context: ${intent}`];
  lines.push(`\n**Budget:** ${used} / ${budgetTokens} tokens used.`);
  lines.push(`**Files:** ${included.length} included, ${dropped.length} dropped.\n`);
  if (included.length === 0) {
    lines.push('_No files fit the budget._');
    return lines.join('\n');
  }
  lines.push('| File | Tokens | Mode | Domain | Blast |');
  lines.push('|------|-------:|------|--------|------:|');
  for (const f of included) {
    let domain = '—';
    let blast = 0;
    try {
      const row = store.getFileByPath ? store.getFileByPath(f.path) : null;
      if (row) {
        blast = row.centrality || 0;
        if (row.domain_id) {
          const d = store.db.prepare('SELECT name FROM domains WHERE id = ?').get(row.domain_id);
          if (d) domain = d.name;
        }
      }
    } catch {}
    lines.push(`| ${f.path} | ${f.tokens} | ${f.include} | ${domain} | ${blast} |`);
  }
  if (dropped.length > 0) {
    lines.push(`\n**Dropped (${dropped.length}):**`);
    for (const d of dropped.slice(0, 10)) {
      lines.push(`- ${d.path} (${d.tokens} tokens, ${d.reason})`);
    }
  }
  return lines.join('\n');
}

/**
 * getProgressiveDisclosureTree({ store, projectRoot }) → tree
 *
 * Pre-computed hierarchy: domain → top files in domain → their summaries.
 * Useful for AI tools that want a "table of contents" of the codebase
 * before drilling into specifics.
 *
 * Tree shape:
 *   {
 *     domains: [{
 *       name, file_count, route_count,
 *       top_files: [{ path, blast_radius, exports }],
 *     }]
 *   }
 */
function getProgressiveDisclosureTree({ store }) {
  if (!store || !store.db) return { domains: [] };
  const domainList = store.getDomainsList();
  const out = [];
  for (const d of domainList) {
    const files = store.db.prepare(`
      SELECT path, centrality FROM files
      WHERE domain_id = (SELECT id FROM domains WHERE name = ?)
      ORDER BY centrality DESC
      LIMIT 5
    `).all(d.name);
    const topFiles = files.map(f => {
      const file = store.getFileByPath(f.path);
      const exports = file ? store.db.prepare(`
        SELECT name FROM symbols WHERE file_id = ? AND exported = 1 LIMIT 5
      `).all(file.id).map(r => r.name) : [];
      return { path: f.path, blast_radius: f.centrality || 0, exports };
    });
    out.push({
      name: d.name,
      file_count: d.fileCount,
      route_count: d.routeCount,
      top_files: topFiles,
    });
  }
  return { domains: out };
}

/**
 * getTokenBudgetReport({ store, projectRoot, intent, budget }) → report
 *
 * Diagnostic complement to getMinimalContextForIntent. Returns a per-file
 * cost breakdown + the proportion of total repo that fits the budget.
 */
function getTokenBudgetReport({ store, projectRoot, intent, budgetTokens = DEFAULT_BUDGET, temporalStore = null }) {
  const r = getMinimalContextForIntent({ store, projectRoot, intent, budgetTokens, temporalStore });
  const totalFilesIndexed = store.db ? store.db.prepare('SELECT COUNT(*) as c FROM files').get().c : 0;
  const totalReprBytes = store.db ? store.db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM files').get().s : 0;
  const totalTokensApprox = Math.ceil(totalReprBytes / CHARS_PER_TOKEN);
  return {
    intent: r.intent,
    budget_tokens: r.budget_tokens,
    used_tokens: r.used_tokens,
    files_included: r.files.length,
    files_dropped: r.dropped.length,
    total_files_in_repo: totalFilesIndexed,
    repo_tokens_approx: totalTokensApprox,
    efficiency: totalTokensApprox > 0
      ? Math.round((r.used_tokens / totalTokensApprox) * 10000) / 100  // percent
      : 0,
  };
}

module.exports = {
  getMinimalContextForIntent,
  getProgressiveDisclosureTree,
  getTokenBudgetReport,
  DEFAULT_BUDGET,
  CHARS_PER_TOKEN,
};
