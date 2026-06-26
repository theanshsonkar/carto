# bench/swe-bench — SWE-bench-Verified harness for Carto

> Block 1.E core artifact (PEAK §10). Produces the Anthropic-attention
> input described in PEAK §16 Stage A: a clean delta between **Claude
> Sonnet alone** and **Claude Sonnet + Carto MCP** on multi-file
> coding tasks.

## What this harness does

For each task in a task set, the harness runs two arms:

| Arm | Agent setup |
|-----|------------|
| **control** | Claude Sonnet with filesystem tools only (no Carto). |
| **carto**   | Claude Sonnet with filesystem tools **+** Carto MCP server. |

Each arm produces a diff. The scorer compares that diff against the
task's expected solution and records pass/fail/partial. The aggregator
walks the JSONL, computes pass-rates per arm, the delta, and a 95%
bootstrap confidence interval — then emits a markdown report.

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Task set    │───▶│   Harness    │───▶│  Aggregator  │
│  (mini-suite │    │  per-task ×  │    │  → REPORT.md │
│   or SWE-V)  │    │  per-arm     │    │  + delta CI  │
└──────────────┘    └──────────────┘    └──────────────┘
```

## Layout

| File | Purpose |
|------|---------|
| `harness.js` | The per-task runner. Picks an agent, invokes it, records the diff to JSONL. |
| `agent.js` | Two `Agent` implementations: `StubAgent` (deterministic, no API) and `AnthropicAgent` (real API + optional Carto MCP). |
| `mini-suite.js` | 5 deterministic synthetic tasks for CI. No external API needed. |
| `score.js` | Per-task scoring: pass / partial / fail, with single-file vs multi-file split. |
| `aggregate.js` | Walks results JSONL, computes pass-rates + bootstrap 95% CI, emits markdown. |
| `mcp-bridge.js` | Spawns `carto serve` and exposes a minimal `{listTools(), callTool()}` API for the carto arm. |
| `run.sh` | Operator entry point — flags below. |
| `results/` | JSONL run logs and the rendered REPORT.md. Gitignored. |

## Running

The harness is **gated on `ANTHROPIC_API_KEY`** for the real arm. In
CI we always run the mini-suite, which uses `StubAgent` and is
deterministic. To run against real Claude locally:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
bench/swe-bench/run.sh --task-set sample  --arm carto    # mini-suite (StubAgent — no API)
bench/swe-bench/run.sh --task-set sample  --arm control
bench/swe-bench/run.sh --task-set verified --arm both    # full SWE-bench-Verified (requires API + HF dataset)
```

Flags accepted by `run.sh`:

| Flag | Values | Default |
|------|--------|---------|
| `--task-set` | `sample` (mini-suite, deterministic) <br> `verified` (real SWE-bench-Verified) | `sample` |
| `--arm`     | `control` (Claude alone) <br> `carto` (Claude + Carto MCP) <br> `both` (run both, then aggregate) | `both` |
| `--out`     | results directory                                                | `bench/swe-bench/results/` |
| `--limit`   | max tasks (sample only)                                          | all |
| `--help`    | usage                                                            | — |

## Reproducibility

- **Deterministic seed**: `StubAgent` is fully deterministic.
- **Recorded traces**: every Anthropic API request + response is
  written to `results/<run-id>.trace.jsonl`. Reviewers can replay the
  exact tape without re-spending tokens.
- **Pinned model**: the model id is captured in the run header.
  Anthropic publishes model snapshots — pin to a snapshot id like
  `claude-sonnet-4-20250514` for true reproducibility.
- **Bootstrap CI**: 1000 resamples, 95% interval. Same seed across
  runs → same CI bounds.

## What the report looks like

```markdown
# Carto · SWE-bench-Verified results — sample task-set

Run id: `mini-2026-06-26T12-34-56Z`
Model:  claude-sonnet-4-20250514 (stub)
Tasks:  5

| Metric | control | carto | delta | 95% CI |
|--------|--------:|------:|------:|-------:|
| Pass rate (all)    | 60.0%  | 100.0% | **+40.0pp** | [+8.0, +60.0] |
| Pass rate (single) | 100.0% | 100.0% | +0.0pp      | [-20.0, +20.0] |
| Pass rate (multi)  | 33.3%  | 100.0% | **+66.7pp** | [+22.2, +88.8] |
```

The multi-file split is the headline — that's the slice where
structural context matters most, and where PEAK §10 sets the ≥10pp
delta target.

## Status & honesty

- **Sample task-set ships in v0**: 5 synthetic tasks designed to
  exercise the harness end-to-end. Not the real benchmark.
- **Verified task-set requires SWE-bench-Verified dataset access** —
  available from Hugging Face. The harness reads JSONL of tasks; see
  `agent.js` comments for the expected shape.
- The mini-suite's outcomes are **hardcoded per task** to make CI
  deterministic. The first time real Claude runs against this harness
  is the first time we'll know the *actual* delta.

## Where this fits in the strategy

PEAK §16 Stage A. The single artifact that turns the Anthropic
partnership conversation from a *pitch* into a *data conversation*.
Carto + Claude beats Claude alone by Npp on multi-file tasks → that
number is what gets engineers at Anthropic to take the next call.
