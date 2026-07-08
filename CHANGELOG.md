# Changelog

All notable changes to Carto land here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [2.1.1] - 2026-07-08

Correctness, trust, and real portability. The external-audit fixes land, the tool surface collapses to a default core-10, and the container becomes a single verifiable file you can move between machines.

### Added
- **Single-file container** - `carto export` packs `.carto/anci.{yaml,bin}` into one portable `.anci` file; `carto load <file>` unpacks it on another machine with no re-index and verifies the content digest. Loaded contents are treated as untrusted data, never instructions.
- **Container identity** - the ANCI manifest now records source commit, tree hash, carto version, tree-sitter grammar versions, and a sha256 content digest. The same repo rebuilds to the same digest.
- **Staleness warnings** - MCP responses and `carto doctor` warn "graph is N commits stale" instead of silently serving old numbers.
- **Model extractors** - Zod (`z.object`) and Drizzle (`pgTable`/`sqliteTable`/`mysqlTable`) schemas are now extracted and surfaced by `get_models`.
- **Temporal auto-backfill** - `carto init` backfills git history automatically (bounded to ~200 commits); pass `--no-temporal` to skip. Temporal and predictive tools now return real data with no manual step.
- **Audit CI gate** - `test/audit-supabase.js` pins the external-audit findings so trust can't silently regress.

### Changed
- **MCP surface collapsed** from ~76 flat tools into a handful of parameterized families (`impact`, `memory`, `history`, `patterns`, `org`) plus a default core-10, so the tool list stops burning context at session start. Former tool names still resolve as deprecated shims with byte-identical output.
- **Domain classification** now routes through a single source of truth, so `get_data_flow` and `get_cross_domain` always agree; repo-declared domain globs in `carto.config.json` are the primary source, with inference as the fallback.
- **`get_canonical_pattern`** requires a non-trivial, well-connected exemplar (ignores demo/example/fixture routes).
- **`get_change_plan`** matches intent on word boundaries instead of naive substring.
- **`get_conventions`** mines naming/export/directory patterns with confidence instead of a single trivial rule.
- README reworked around portability ("build once, load anywhere"), the active-guardrail framing, and container identity.
- Test suite expanded to 417 tests.

### Fixed
- Domain misclassification from over-broad keyword seeds (byte-size utility, theme resolver, and similar).
- Deterministic file discovery (sorted POSIX paths) so content digests are reproducible across machines.

## [2.1.0] — 2026-06-26

The big one. Five new memory layers, six new languages, two-axis growth across the MCP surface.

### Added
- **76 MCP tools** across temporal, brain, predictive, adjacent, org, and AI retrieval groups (was 22).
- **Episodic memory** — every `validate_diff` call now writes to `.carto/carto.db`. New chats can ask `did_we_discuss_this` and read the prior verdict. Tools: `did_we_discuss_this`, `get_decision_log`, `get_session_context`, `get_pending_decisions`, `get_intervention_history`.
- **Temporal layer** — snapshots, churn, deltas, git-history backfill. Tools: `get_architectural_drift`, `get_domain_evolution`, `get_hotspot_files`, `get_arch_events`, `get_temporal_context`, `get_change_velocity`, `get_complexity_trend`.
- **Brain layer** — invariants and conventions mined from the import graph, action patterns mined from git history. Tools: `get_invariants`, `get_conventions`, `get_canonical_pattern`, `get_action_patterns`, `get_working_memory`, `get_active_suggestions`, `scaffold_for_intent`.
- **Predictive layer** — per-file P(causes next incident) score blending blast radius, churn, coupling, intervention history, test coverage. Tools: `get_predictive_risk`, `get_safety_checklist`, `get_drift_digest`, `get_test_coverage_map`, `validate_change`.
- **AI retrieval** — token-budgeted context picker with hybrid retrieval (structural + lexical + semantic) and RRF fusion. Tools: `get_minimal_context_for_intent`, `get_progressive_disclosure_tree`, `get_token_budget_report`.
- **Org / multi-repo** — cross-repo detection, service graph, npm/pypi/go-mod/maven edge resolution. Tools: `get_org_architecture`, `get_service_dependency_graph`, `get_cross_repo_blast_radius`, `find_consumers_of_api`, `get_service_boundary_violations`, `get_org_domain_mapping`.
- **Adjacent signals** — cross-language call graph, IaC resources, OTLP runtime ingestion, risk-weighted blast radius, dead code with confidence, semantic diff.
- **Language extractors** — PHP (Laravel, Symfony, Eloquent), Swift (Vapor, structs), Kotlin (Spring, Ktor, data classes), Dart (Flutter widgets, Shelf), R (Plumber, Shiny, R6, S7). All tier-1.
- **Plugin API** for third-party language extractors. Unified framework router collapses the per-language plugins under a single interface.
- **ACP agent mode** — `carto agent` runs as a full ACP agent for Zed, JetBrains, VS Code. BYOK for Anthropic, OpenAI, Gemini, Groq, Ollama, OpenRouter, Together, Azure.
- **MCP middleware** — `carto mcp-middleware --block-on HIGH -- <inner>` wraps any stdio MCP server and blocks risky writes before they reach the model.
- **CLI** — new subcommands: `explain`, `diff`, `validate`, `status`, `why`, `doctor`, `check`, `pr-impact`. `init` now auto-wires Claude Code, Codex, Windsurf, Zed in addition to Cursor and Kiro.
- **Benchmarks** — SWE-bench-Verified harness for measuring the Carto delta (`bench/swe-bench/`).
- **Docs** — auto-generated per-tool reference for all 76 tools (`docs/api/`), concept walkthroughs (blast radius, domains, import graph, MCP integration, ANCI), guides (CI integration, monorepo setup, onboarding, adding features safely, pre-merge review), V1→V2 migration, quickstart, troubleshooting.

### Changed
- Test suite expanded to 346 tests covering the v2.1 surface.
- README rewritten around episodic memory and predictive risk.

### Removed
- V1 import path; the `-v2` suffix is gone from internal modules.

## [2.0.9] — 2026-06-07

### Added
- **Prebuilt native binaries** for macOS arm64, Linux x64 (glibc + musl), Windows x64. No C++ toolchain needed for the common case.
- **GitHub Action** — `carto/pr-impact` drops a sticky PR comment with blast radius, cross-domain violations, affected routes, risk badge. `fail-on: HIGH|MEDIUM|LOW` gates the workflow.
- **ANCI v0.1-DRAFT** — Architecturally Normalized Code Index. `.carto/anci.{yaml,bin}` written on every `carto sync`. Reference consumer in `src/anci/consumer.js`.
- **Scale-test harness** — `bench/scale-test/` plus an expanded test suite.

### Changed
- `carto sync` emits the ANCI export alongside the SQLite store; bitmap mtime invariant fixed so reads never see a stale graph.

### Fixed
- Stale spec-version references scrubbed from extractor and CLI comments.

## [2.0.8] — 2026-06-05

### Changed
- **Reshape release.** Diff validation lands as the primary surface. The bitmap engine replaces the SQLite path for graph queries (10× median, sub-millisecond at 7K files). Import graph is now accurate by construction. Fresh-by-default — `carto sync` runs on every git event.
- README leads with the AI tool integration story; Origin section restored. Codex CLI setup added.

## [2.0.7] — 2026-06-02

### Added
- Codex CLI setup instructions.

### Fixed
- Correctness fixes across the extractor stack.
- MCP resilience — server no longer crashes on malformed tool calls.
- Security hardening — `.cartoignore` blocks `.env` and credential files by default; secrets never enter `AGENTS.md`.

## [2.0.6] — 2026-06-01

### Added
- ACP agent mode (`carto agent`) with BYOK LLM support — initial cut.
- VS Code Copilot and Windsurf added to the MCP config section.

### Changed
- README restructured to lead with AI tool integration.
- `carto init` migrated to the V2 SQLite indexer (Spec 4).
- Prominent update notice wired into `init`, `serve`, `impact`, `check` (Spec 4.5).

### Fixed
- `Project Structure` block in `AGENTS.md` now populates correctly under the V2 sync path.

## [2.0.3 – 2.0.5] — 2026-05-31

### Added
- GitHub Actions CI (Spec 3): test matrix across Node 20/22 on Ubuntu, macOS, Windows.

### Changed
- `get_change_plan` replaced keyword-grep with real graph traversal (Spec 2).
- Lockfile sync at 2.0.3; `.npmrc` with `legacy-peer-deps` for Windows CI.

### Fixed
- `carto check` SQLite query path; serve/sync CLI cleanup.

## [2.0.0] — 2026-05-29

### Added
- **V2 architecture.** SQLite store with WAL mode replaces JSON blobs. Recursive directory watcher with debounce, burst detection, dirty-flag recluster.
- **Tree-sitter parser** with grammars for 8 languages. JS/TS plugins use tree-sitter for imports and symbols; Babel runs only on API handler files.
- **Language plugins** — Rust, Java, C++, C#, Ruby (Rails routes including `resources :foo` CRUD expansion, Sinatra, ActiveRecord), expanded Python and Go.
- **Domain clustering** — Leiden + CPM, four new MCP tools, lazy context generation.
- **Worker pool** for parsing; mtime + size cache; the 300-file smartSelect cap is gone.
- Benchmark suite, correctness tests, V2 CONTRIBUTING.md.

### Changed
- `carto check` rewritten against the SQLite store. `serve` and `sync` CLI surfaces updated.

## [1.x] — 2026-05-01 – 2026-05-02

Early releases. Go import graph, Flask routes, custom domain config, initial MCP server. See git history for detail.

[2.1.0]: https://github.com/theanshsonkar/carto/releases/tag/v2.1.0
[2.0.9]: https://github.com/theanshsonkar/carto/releases/tag/v2.0.9
[2.0.8]: https://github.com/theanshsonkar/carto/releases/tag/v2.0.8
[2.0.7]: https://github.com/theanshsonkar/carto/releases/tag/v2.0.7
[2.0.6]: https://github.com/theanshsonkar/carto/releases/tag/v2.0.6
