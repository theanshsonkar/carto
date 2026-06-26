# Troubleshooting

> Real failure modes, with fixes.

## Install / native modules

### `node-gyp rebuild` fails on install

Symptom: `npm install -g carto-md` exits with C++ errors mentioning `tree-sitter` or `better-sqlite3`.

Why: no prebuilt binary for your platform → falling back to compile-from-source → no C++ toolchain present.

Fix: install build tools, then retry.

| OS | Command |
|---|---|
| macOS | `xcode-select --install` |
| Ubuntu / Debian | `sudo apt-get install build-essential python3` |
| RHEL / Fedora | `sudo dnf groupinstall "Development Tools"` |
| Windows | `npm install --global windows-build-tools` (run from elevated PowerShell) |
| Alpine | `apk add --no-cache python3 make g++` |

If you're on a supported platform (macOS arm64/x64, Linux x64 glibc + musl, Windows x64), you *shouldn't* be hitting this. Run `carto doctor` — the output will tell you which native module is the problem.

### Node version refused at install time

```
[CARTO] Node v16.x.x is too old. carto-md requires Node ≥ v18.
```

Upgrade Node. https://nodejs.org/ — even-numbered LTS releases (18, 20, 22) are best.

### Missing optional grammars

```
⚠ Tree-sitter grammars (2 of 8 missing: tree-sitter-rust, tree-sitter-java)
```

The optional language grammars failed to prebuild on your platform. Files in those languages still get indexed — Carto falls back to regex extraction (less accurate but functional).

To force a grammar to install:

```bash
npm install -g tree-sitter-rust
```

If that fails too, the platform doesn't have a prebuild and won't compile. That's fine — regex fallback works.

## Index / sync

### `carto sync` says "0 files re-parsed" but I changed files

Cache hit. Carto stats each file's mtime+size and skips ones that haven't changed. If you genuinely changed a file but mtime didn't move (rare — usually copying a same-content file), force a re-parse:

```bash
touch src/the/file.ts
carto sync
```

For a full rebuild from scratch:

```bash
carto remove
carto init
```

### `carto check` claims unstable clustering

```
[CARTO] Warning: 8.2% of files changed domain since last sync — clustering unstable.
```

The Leiden+CPM clusterer can be sensitive when the codebase is borderline between two stable partitions. If this happens repeatedly:

1. Pin the important files with `anchor` in `carto.config.json`. See [`docs/concepts/domains.md`](./concepts/domains.md).
2. If a domain is genuinely splitting (a refactor in progress), this is informational — accept the drift.
3. If you don't care about exact domain names but want stability, set keyword hints in `carto.config.json` so the names are forced.

### Index is huge

A 100K-file repo produces a 160 MB `carto.db` and 20 MB `bitmap.bin`. Larger than expected? Most likely you're indexing `node_modules/`, a `vendor/` dir, or a generated `dist/`. Run:

```bash
carto inspect | head -20
```

That shows the file count. If it's way bigger than your source tree, edit `.cartoignore` to exclude the offender:

```
node_modules/
vendor/
**/__generated__/
build/
dist/
out/
```

## MCP / AI tool integration

### AI tool doesn't see Carto's tools

1. Restart the AI tool (it loads MCP config at startup).
2. Run `carto doctor` — it surfaces whether config files exist for the tools you have installed.
3. If `doctor` says "MCP configuration: no MCP config files found", re-run `carto init` (it auto-wires).
4. If `init` doesn't detect your tool, see the README's manual config snippets in the [Manual MCP wiring](../README.md) section (collapsed `<details>` block right after the install snippet).

### MCP server crashes

Pre-2.0.7 the MCP server could crash on tool errors and the AI tool would see `-32000 Failed to reconnect`. Fixed in 2.0.7. If you're seeing it on a newer version, set `CARTO_DEBUG=1` before launching the AI tool to capture stderr.

### "Lazy re-parse" doesn't fire on stale files

The MCP server stats the file on every file-aware query and re-parses if mtime is newer than the DB row. If a query returns stale data:

1. Check the file's mtime: `stat src/the/file.ts`
2. Compare against the DB row: `carto inspect | grep "last full sync"`
3. If mtime is older, sync was after edit and the data isn't stale.
4. If mtime is newer but the data is stale, file a bug — that's the regression test target.

## Validation API / PR Action

### `carto pr-impact` says "No carto index"

The action's cache restored an empty `.carto/`. Either:

- Cache key isn't invalidating. Check `hashFiles` glob in the workflow.
- First run on this branch — let it run `carto init` cold once.
- Index was removed; run `carto init` manually inside the workflow before pr-impact.

### Sticky comment isn't sticky

The action looks for the `<!-- carto-impact-report -->` marker in existing PR comments and updates the first match. If multiple comments have the marker (somehow), the action updates the first. If you see duplicate comments, check that the workflow isn't running twice (e.g. matrix builds, multiple triggers).

### `--fail-on HIGH` trips too often

Lower the threshold to `MEDIUM` for a softer gate, or use `--fail-on` only on `main`-bound PRs and not feature-branch PRs. Or accept that HIGH-risk PRs deserve careful review and let the gate work as intended.

## SWE-bench harness

### `bench/swe-bench/run.sh --task-set verified` says "dataset not found"

Download the SWE-bench-Verified dataset from Hugging Face:

```bash
pip install huggingface_hub
huggingface-cli download princeton-nlp/SWE-bench_Verified \
  --repo-type dataset --local-dir ~/swe-bench-verified
```

Or set `CARTO_SWE_VERIFIED_PATH=/path/to/test.jsonl`.

### AnthropicAgent throws on `--arm carto`

You ran `--task-set verified` without `ANTHROPIC_API_KEY`. Set the key, or stick to `--task-set sample` which uses the deterministic StubAgent.

### Cost runaway during a real-API run

Set an Anthropic spend limit on your account dashboard *before* a long run. The harness emits per-task token counts to the JSONL output — tail it during the run to spot anomalies early:

```bash
tail -f bench/swe-bench/results/<run-id>.jsonl | jq .tokensInput
```

## General

### `carto doctor` is the right starting point

For any "something is broken" report, run `carto doctor` first. It checks Node, native modules, the index, git hooks, MCP config, .cartoignore. The output points at the broken component with a `Fix:` line.

### Found a real bug

Open an issue with:

- `node --version`
- `carto --version`
- Output of `carto doctor`
- Output of `carto inspect | head -30`
- Steps to reproduce

The maintainer triage is fast on real bugs with reproducible info. The triage is slow on vague "carto doesn't work" reports.
