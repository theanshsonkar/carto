# Guide: Pre-merge review

> Architecture review at PR time, automatically. The reviewer sees structural impact alongside the diff.

## What the GitHub Action does

On every pull request:

1. Checks out the PR head
2. Restores `.carto/` from `actions/cache` (or runs `carto init` cold)
3. Runs `carto pr-impact --base $BASE --head $HEAD --format markdown`
4. Posts the result as a sticky comment on the PR (one comment per PR, updated in place on every push)

The whole flow runs in 30–120 seconds on a warm cache, 1–3 minutes cold.

## Setup

In `.github/workflows/carto.yml`:

```yaml
name: Carto Impact Report
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
  pull-requests: write
jobs:
  carto:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }       # full history — pr-impact needs the base ref
      - uses: theanshsonkar/carto@v2.0.9
```

That's the entire config. The action handles npm install, cache restore, sync, pr-impact, and the comment.

## What the comment looks like

```markdown
## 🗺️ Carto Impact Report

This PR touches **AUTH** and **DATABASE** domains.

| Metric | Value |
|--------|-------|
| Risk | 🔴 HIGH |
| Blast radius (union) | 47 files |
| Files changed | 6 |
| Cross-domain violations introduced | 2 |
| Files without tests in blast radius | 5 of 31 |
| High-impact file changed | src/auth/session.ts (8 direct dependents) |

<details>
<summary>Affected routes (4)</summary>

- POST /auth/login — risk: HIGH
- GET /auth/me — risk: HIGH
- POST /auth/register — risk: MEDIUM
- POST /api/users — risk: LOW

</details>

<details>
<summary>Cross-domain violations (2)</summary>

- auth/login.ts now imports from payments/billing.ts (AUTH→PAYMENTS)
- database/user-repo.ts now imports from auth/jwt.ts (DATABASE→AUTH)

</details>

<details>
<summary>Files without tests in blast radius (5)</summary>

- src/auth/middleware.ts
- src/auth/jwt-helpers.ts
- …
</details>
```

## What a reviewer does with this

Look at the four signals in order:

1. **Risk badge.** HIGH / MEDIUM / LOW / SAFE. If it's SAFE or LOW, you can mostly skip the structural review and focus on the code itself. If it's HIGH, look more carefully.

2. **Cross-domain violations.** Each one is a new dependency between domains. Sometimes correct (a refactor moving shared logic), sometimes a smell (auth pulling from payments). Reviewer applies judgment.

3. **Files without tests.** Files in the blast radius that don't have a sibling test file. Lower confidence in the change because there's no automated check. Suggest the author add tests, or document why not.

4. **High-impact file changed.** Anything modifying a >20-dependent file deserves an extra read-through. Subtle changes to a widely-used utility have outsized blast.

## Failing the build on risk

For repos that want a harder gate, set `fail-on` in the workflow:

```yaml
- uses: theanshsonkar/carto@v2.0.9
  with:
    fail-on: HIGH
```

Now the build fails when the risk is HIGH. PRs need to lower the risk (split, add tests, refactor) before they can merge.

Use sparingly. HIGH-risk changes are sometimes correct and *necessary* — the right reviewer call is "look more carefully", not "block automatically".

## Inputs reference

| Input         | Default     | What it does |
|---------------|-------------|--------------|
| `carto-version` | `latest`  | Pin in production for reproducibility. |
| `base`        | auto        | Git ref the PR branched from. Auto-detected from `origin/$GITHUB_BASE_REF`. |
| `head`        | auto        | Git ref of the PR head. Auto-detected from `$GITHUB_SHA`. |
| `fail-on`     | _(empty)_   | Fail when risk ≥ this severity. `HIGH`, `MEDIUM`, or `LOW`. |
| `comment-mode`| `sticky`    | `sticky` updates existing comment, `new` posts a new one every push, `none` skips the comment (renders to stdout). |
| `node-version`| `20`        | Node version on the runner. |

## Outputs

| Output       | Description |
|--------------|-------------|
| `risk`       | `SAFE` / `LOW` / `MEDIUM` / `HIGH` — gate downstream steps on it. |
| `comment-url`| URL of the posted comment. |

## Running it locally (mirror the CI)

```bash
carto pr-impact --base origin/main --head HEAD
carto pr-impact --base origin/main --head HEAD --format json
carto pr-impact --base origin/main --head HEAD --fail-on HIGH
```

Same engine, same output. Useful for testing changes before pushing.

## Related

- [`docs/guides/ci-integration.md`](./ci-integration.md) — broader CI patterns
- [`docs/concepts/blast-radius.md`](../concepts/blast-radius.md) — the math behind the metric
