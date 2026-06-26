# Migration: V1 → V2

> Notes for anyone who installed `carto-md` pre-2.0.6.

## What V2 changed

V1 stored the index as JSON files at `.carto/cache/graph-cache.json` and `.carto/cache/hashes.json`. V2 stores it as SQLite at `.carto/carto.db` with a derived bitmap sidecar at `.carto/bitmap.bin`.

Why: SQLite handles 100K-file repos cleanly where the JSON approach started getting slow at ~10K files. The bitmap layer makes graph queries 100–10,000× faster than SQL at scale (see [`docs/scale.md`](../scale.md)).

V1 has been fully deleted from the tree as of carto-md@2.0.6.

## What you need to do

In most cases — nothing. `carto init` (or any `carto` command that touches the index) detects the old V1 cache files and migrates them transparently on first run.

Specifically, the migration:

1. Reads `.carto/cache/graph-cache.json` if present (V1 metadata)
2. Notices it's incompatible with the V2 schema
3. Runs a fresh `carto sync` to repopulate `.carto/carto.db` from source
4. Leaves the V1 files in place (they're harmless dead bytes)

The Spec 7 test suite explicitly covers this case: *"carto init migrates leftover V1 graph-cache.json cleanly (no errors)"*.

## Manual cleanup (optional)

After the first V2 sync succeeds, the V1 files are no longer read. Reclaim a bit of disk:

```bash
rm -f .carto/cache/graph-cache.json
rm -f .carto/cache/hashes.json
rmdir .carto/cache  # if empty
```

Or just `carto remove && carto init` for a clean slate.

## MCP wiring changes

V1 exposed 12 MCP tools. V2 ships ~75, organized into 8 categories (core graph, episodic memory, temporal, brain, predictive, AI-native retrieval, adjacent, org-wide).

The highest-impact additions from V1:

- `get_architecture()` — the "use this first" tool
- `get_file_summary(file)` — surfaces what `carto why` shows
- `get_change_plan(intent)` — real graph traversal (V1 was keyword grep — Spec 2 rewrite)
- `get_similar_patterns(file)` — Jaccard-similarity over import sets
- `validate_diff(diff)` — sub-15ms pre-write governance, writes every call into the episodic log
- `did_we_discuss_this(topic)` — six-week recall over the decision log
- `get_predictive_risk(file?)` — P(file causes the next incident) score
- `get_minimal_context_for_intent(intent, budget)` — token-budgeted hybrid retrieval (structural + lexical + semantic with RRF fusion)
- `simulate_change_impact(files)` — bitmap-backed multi-file blast radius

Plus the temporal trio (`get_architectural_drift`, `get_domain_evolution`, `get_hotspot_files`), the brain stack (`get_invariants`, `get_conventions`, `get_action_patterns`, `scaffold_for_intent`), and the org/cross-repo set (`get_org_architecture`, `get_service_dependency_graph`, `find_consumers_of_api`).

Full reference: [`docs/api/`](../api/).

If your AI tool was configured against V1 and you're seeing tool-not-found errors, restart the tool to pick up the V2 server's new `tools/list` response. The wire protocol is the same.

## ACP agent

V1's ACP agent (in Zed / JetBrains / VS Code via `carto agent`) used its own in-memory index. V2's ACP agent shares the SQLite index with the MCP server (Spec 5). Re-running `carto init` in your project ensures both ACP and MCP see the same data.

## `.cartoignore` defaults

V2 expanded the default exclusion list from 12 patterns to 39 (Spec 8: SSH keys, AWS/GCP creds, `.netrc`, kubeconfig, etc.). If your project had a custom `.cartoignore`, it's preserved — Carto only writes a default when none exists. To pick up the new defaults, delete your `.cartoignore` and run `carto init` to regenerate.

## Git hooks

V1 didn't install git hooks. V2 (Spec 9) installs four:

- `pre-commit`
- `post-checkout`
- `post-merge`
- `post-rewrite`

Each runs `carto sync >/dev/null 2>&1 || true` — never blocks git, never errors loudly. If you already have hooks for other purposes, Carto appends to them non-destructively. Run `carto doctor` to confirm the hooks installed.

## Behavior changes worth flagging

| Behavior | V1 | V2 |
|----------|----|----|
| File-discovery cap | hard cap at ~50K files | uncapped |
| Index format | JSON | SQLite + bitmap |
| Re-parse on edit | only via `carto watch` | lazy at MCP query time + git hooks |
| `get_change_plan` | keyword grep | real graph traversal |
| Cross-domain detection | path-based | graph-clustered |
| ACP / MCP share index | no | yes |
| Read-only MCP DB | no | yes |
| Default `.cartoignore` | 12 patterns | 39 patterns |

If you depended on a V1-specific behavior that's no longer accurate, file an issue — we may have broken something we shouldn't have.

## Pinned-version recommendation

If you're upgrading in CI, pin a known-good Carto version:

```yaml
# .github/workflows/carto.yml
- uses: theanshsonkar/carto@v2.0.9
  with:
    carto-version: '2.0.9'    # pin instead of `latest`
```

This way the action's output (and the PR-comment shape) stays stable across CI runs even when newer Carto versions ship.

## Related

- [`docs/troubleshooting.md`](../troubleshooting.md) — what to do when migration goes sideways
- [Spec 6](../../Progress/working.md) in `Progress/working.md` — the deletion that removed V1
