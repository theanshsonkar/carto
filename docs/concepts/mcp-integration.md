# Concept: MCP Integration

> The protocol layer that makes Carto's index visible to your AI tool.

## What MCP is

The [Model Context Protocol](https://modelcontextprotocol.io) is an open protocol Anthropic introduced in late 2024 for connecting LLMs to external tools and data. An MCP **server** exposes tools and resources; an MCP **client** (Cursor, Claude Desktop, Kiro, Claude Code, Cline, Continue, Windsurf, Zed) calls them on behalf of the model.

Carto runs an MCP server in stdio mode. You start it with `carto serve`, but you almost never do that by hand — your AI tool spawns it.

## What `carto init` writes

For each AI tool it detects on your machine, init writes the appropriate MCP config:

| Tool | Config file | Format |
|------|-------------|--------|
| Cursor          | `~/.cursor/mcp.json`                                      | `{ mcpServers: { carto: ... } }` |
| Claude Code     | `<project>/.mcp.json`                                     | same |
| Claude Desktop  | `~/Library/Application Support/Claude/claude_desktop_config.json` | same (cross-platform paths in README) |
| Kiro            | `~/.kiro/settings/mcp.json`                               | same |
| Codex CLI       | `~/.codex/config.toml`                                    | `[mcp_servers.carto]` |
| VS Code Copilot | `<project>/.vscode/mcp.json`                              | `{ servers: { carto: { type: "stdio", ... } } }` |
| Windsurf        | `~/.codeium/windsurf/mcp_config.json`                     | `{ mcpServers: { carto: ... } }` |

Each config tells the tool: *"when the user starts a chat, run `carto serve` as a child process and route MCP traffic to it"*.

## The tools Carto exposes

Carto exposes a small **default core (~10 tools)** plus a handful of **parameterized families** (`impact`, `memory`, `history`, `patterns`, `org`), so your AI tool spends its context budget on your codebase instead of a long tool menu. The full capability set stays reachable: the ~30 former sibling tools (`get_blast_radius`, `simulate_change_impact`, `did_we_discuss_this`, ...) resolve as **deprecated shims** with byte-identical output, and advanced/experimental tools are available by widening the surface (`CARTO_MCP_TIER=advanced`, or `carto.config.json` -> `mcp.tier`).

The groups below map every capability by what it answers. Categories match the [`docs/api/`](../api/) layout, which is the full per-tool reference (auto-generated from `src/mcp/server.js`). Your AI tool picks whichever fits the question mid-task; you don't choose by hand.

### Core graph (16) — project shape, blast radius, change planning

- **`get_architecture()`** — 500-word overview. The right *first* call for any new task.
- **`get_blast_radius(file)`** — every file affected by changing this one, with hop distance.
- **`get_change_plan(intent)`** — natural-language intent → files to touch, affected domains, similar patterns.
- **`simulate_change_impact(files)`** — union of the blast radius for *multiple* files at once. The bitmap engine is what makes this feasible at scale.
- **`get_high_impact_files(n)`** — top N files by transitive dependents.
- **`get_cross_domain()`** — every import edge that crosses a domain boundary.

Plus `get_structure`, `get_context`, `get_neighbors`, `get_domain`, `get_domains_list`, `get_routes`, `search_routes`, `get_models`, `get_env_vars`, `get_file_summary`, `get_similar_patterns`.

### Episodic memory (5) — what your AI decided last week

- **`validate_diff(diff)`** — given a unified diff: violations, blast radius, risk grade, suggestions. Sub-15ms p99. **Every call writes a row to the decision log** — the rest of this category reads from it.
- **`did_we_discuss_this(topic)`** — substring search over the decision log. Six-week recall, conversational.
- **`get_recent_decisions(time_range, kind?)`**, **`get_session_context(session_id?)`**, **`get_intervention_history(file?)`** — the underlying log surfaced different ways.

### Temporal (9) — how the architecture changed over time

- **`get_architectural_drift()`** — per-domain growth/shrink + event count over a window.
- **`get_hotspot_files()`** — top files by churn × blast_radius (the CodeHealth heuristic).
- **`get_domain_evolution(domain)`** — time-series of one domain's file count by snapshot.

Plus `get_arch_events`, `get_temporal_context`, `get_change_velocity`, `get_complexity_trend`, `get_churn_vs_blast_radius`, `get_domain_health`.

### Brain (10) — invariants, conventions, action patterns

Carto's "rules of the codebase" — mined from the import graph and git history, not written by hand.

- **`get_invariants(domain?, threshold?)`** — confidence-scored architectural rules: *"AUTH never imports from PAYMENTS"*.
- **`get_conventions(file?)`** — naming, export, and directory conventions that apply to a given location.
- **`get_action_patterns(intent?)`** — *"when developers add X, they also touch Y"* — procedural patterns from git history.
- **`scaffold_for_intent(intent)`** — anchor file + co-changed files + canonical pattern + conventions.

Plus `get_canonical_pattern`, `get_working_memory`, `get_active_suggestions`, `get_pending_decisions`, `get_active_drift`, `dismiss_suggestion`.

### Predictive (7) — P(file causes the next bug)

- **`get_predictive_risk(file?)`** — 0–1 score per file combining blast radius, churn, cross-domain coupling, prior interventions, and test coverage.
- **`get_safety_checklist(file)`** — per-file pre-edit safety summary.
- **`validate_change(file, content)`** — pre-write governance: diffs `content` vs disk then runs `validate_diff`.
- **`get_drift_digest(time_range)`** — weekly architectural digest in CLI-renderable markdown.

Plus `get_microservice_cut_points`, `get_file_ownership`, `get_cross_team_coupling`, `get_ai_cost_attribution`.

### AI-native retrieval (14) — context that fits the budget

- **`get_minimal_context_for_intent(intent, budget_tokens)`** — token-budgeted hybrid retrieval (structural + lexical + semantic, fused with RRF, boosted by same-domain and recent-churn). Usually returns 6–12 files instead of the usual 40+.
- **`get_progressive_disclosure_tree()`** — domain → top files → exports, structured for an LLM to drill into.
- **`get_token_budget_report(intent, budget)`** — diagnostic complement: which files would be picked and at what cost.

Plus `get_data_flow`, `get_interface_contract`, `get_dependency_surface`, `get_upgrade_risk`, `get_test_coverage_map`, `get_stale_docs`, `get_decision_log`, `get_evolution_delta`, `get_change_velocity`, `explain_change_in_natural_language`.

### Adjacent (8) — runtime, IaC, cross-language, dead code

- **`get_cross_language_call_graph()`** — match frontend `fetch()` to backend route handlers across language boundaries.
- **`get_iac_resources()`** — Terraform / Helm / Pulumi / CDK resources discovered in the repo.
- **`ingest_otlp_traces(path)`** + **`get_risk_weighted_blast_radius(otlp?)`** — combine static dependents with runtime call counts.
- **`get_dead_code_with_confidence(otlp?)`** — zero static dependents AND zero runtime hits → the safe-to-delete list.
- **`get_semantic_diff(diff)`** — rename + symbol-relocation detection beyond line-level.

Plus `get_hot_in_prod_no_tests`, `get_llm_enrichment`.

### Org / multi-repo (7) — service graphs across repos

- **`get_org_architecture()`** — org-wide summary across registered repos.
- **`get_cross_repo_blast_radius(repo)`** — *"if I break repo X, who notices?"*
- **`find_consumers_of_api(target)`** — every file importing a given npm/pypi/go/maven package across the org.
- **`get_service_dependency_graph()`**, **`get_service_boundary_violations()`** — service-shape views.

Plus `get_org_domain_mapping`, `get_microservices_migration_cut_points`.

> Full per-tool API reference at [`docs/api/`](../api/). You don't memorize these — your AI picks the right one mid-task.

## How the AI knows when to call which tool

The model reads the tool descriptions Carto provides in the `tools/list` response. Each description is one sentence written so the model has enough context to choose. Examples:

> *"Get a 500-word project overview: domains, entry points, stack, key patterns. **Use this first.**"*

> *"Given a unified diff: violations (cross-domain imports, high-blast files), blast radius per file, risk level (SAFE/LOW/MEDIUM/HIGH), suggestions. Each call is recorded in the episodic memory log so other tools can ask 'did we discuss this?'. Sub-15ms p99."*

The "Use this first" hint matters. The model orients itself with `get_architecture()`, then narrows to specific tools based on what the user asked.

## Lazy re-parse on stale files

When the model asks about `src/lib/db.ts` and you've edited it since the last `carto sync`, the MCP server stats the file, sees the mtime is newer than the DB row, and re-parses it inline (~50 ms). The model gets a fresh answer; you didn't think about freshness at all.

That's why Carto doesn't need a daemon. Git hooks handle the "I just committed" case; lazy re-parse handles the "I edited but didn't commit yet" case. Together they cover ~100% of real usage.

## Wiring it manually

If `carto init` didn't detect your AI tool, the README's [Manual MCP wiring](../../README.md) section (collapsed `<details>` block right after the install snippet) has copy-paste snippets for every supported client. The shape is always:

```json
{
  "mcpServers": {
    "carto": {
      "command": "carto",
      "args": ["serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Restart the tool, and it'll show carto in its MCP server list.

## Debugging

- `carto doctor` runs a sanity check on Node version, native modules, the index, git hooks, and the *presence* of MCP config files (it doesn't validate their content — that varies per tool).
- Set `CARTO_DEBUG=1` before launching your AI tool to make the MCP server log every tool call to stderr.
- Read [`troubleshooting.md`](../troubleshooting.md) for known gotchas.

## Related

- [Model Context Protocol spec](https://modelcontextprotocol.io)
- [`anci.md`](./anci.md) — the file-format Carto exports for tools that prefer reading a static file over speaking MCP
