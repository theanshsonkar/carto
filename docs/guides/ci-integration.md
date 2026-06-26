# Guide: CI integration

> Where carto fits into your CI pipeline, beyond the GitHub Action.

## The default — GitHub Action

[`docs/guides/pre-merge-review.md`](./pre-merge-review.md) covers the canonical case: drop the Action onto every PR, get sticky-comment impact reports automatically.

This guide is for the cases where the Action isn't the right fit: GitLab, Bitbucket, custom CI, pre-commit, monorepo-specific gates.

## GitLab CI

```yaml
# .gitlab-ci.yml
carto-impact:
  stage: test
  image: node:20
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  cache:
    key: carto-${CI_COMMIT_REF_SLUG}
    paths:
      - .carto/
  script:
    - npm install -g carto-md
    - test -d .carto || carto init
    - carto sync
    - carto pr-impact --base origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME --head HEAD --format markdown > impact.md
    - cat impact.md
  artifacts:
    paths: [impact.md]
```

Posting to the merge-request as a comment requires `glab`:

```yaml
    - glab mr note ${CI_MERGE_REQUEST_IID} -F impact.md
```

## Bitbucket Pipelines

```yaml
# bitbucket-pipelines.yml
pipelines:
  pull-requests:
    '**':
      - step:
          name: Carto Impact
          image: node:20
          script:
            - npm install -g carto-md
            - carto init || carto sync
            - carto pr-impact --base $BITBUCKET_PR_DESTINATION_BRANCH --head HEAD --fail-on HIGH
```

## CircleCI

```yaml
# .circleci/config.yml
version: 2.1
jobs:
  carto-impact:
    docker:
      - image: cimg/node:20.10
    steps:
      - checkout
      - restore_cache:
          keys: [carto-{{ .Branch }}, carto-]
      - run: npm install -g carto-md
      - run: test -d .carto || carto init
      - run: carto sync
      - run: carto pr-impact --base origin/main --head HEAD --format markdown
      - save_cache:
          key: carto-{{ .Branch }}
          paths: [.carto/]
```

## Custom CI / shell script

The whole thing is just three commands. Drop them into whatever runner you use:

```bash
#!/usr/bin/env bash
set -euo pipefail

npm install -g carto-md

if [ ! -d .carto ]; then
  carto init
else
  carto sync
fi

carto pr-impact \
  --base "${BASE_REF:-origin/main}" \
  --head HEAD \
  --format markdown \
  --fail-on HIGH
```

Exit codes:

- 0 — comment rendered, risk below threshold
- 1 — misuse / index missing / git failure
- 2 — `--fail-on` threshold tripped

## Pre-commit hook

For "fail fast" before pushing. Add to `.git/hooks/pre-commit`:

```bash
#!/bin/sh
git diff --cached | carto validate --fail-on HIGH
```

Now a `git commit` that would produce a HIGH-risk change exits 2 and the commit is blocked. The dev sees the violation reasons in the same terminal.

Note: `carto init`'s installed pre-commit hook calls `carto sync`, not `carto validate`. If you want both, prepend the validate line:

```bash
#!/bin/sh
# Spec 22: validate the staged diff first
git diff --cached | carto validate --fail-on HIGH || exit 2

# carto-md: keep index fresh on git events
carto sync >/dev/null 2>&1 || true
```

## Caching tips

Re-running `carto init` from scratch is fast but not free (~10 seconds for a medium repo). On CI, cache `.carto/`:

```yaml
# GitHub Actions
- uses: actions/cache@v4
  with:
    path: .carto/
    key: carto-${{ hashFiles('**/*.ts', '**/*.js', '**/*.py', '**/*.go') }}
    restore-keys: carto-
```

The cache key hashes source files — any change invalidates the cache, but the source-file hash *captures* what changed, so reuse is high across PRs.

After cache restore, run `carto sync` (not `init`). Sync is incremental — mtime+size cached, only changed files re-parsed.

## Slack notifications (drift digest)

Not built in yet — but easy to wire from CI. Run `carto check --json` on a weekly cron, post the cross-domain section to Slack:

```bash
carto check --json | jq '.crossDomain | length' \
  | xargs -I {} curl -X POST -H 'Content-Type: application/json' \
      --data "{\"text\": \"This week: {} cross-domain edges in repo X\"}" \
      $SLACK_WEBHOOK_URL
```

## Don't gate everything

A few patterns we've learned not to recommend:

- **Gating *every* PR on `--fail-on LOW`** — too noisy. LOW is just "a file changed" — every PR trips it.
- **Running carto on `push` events** — wastes runner minutes; the impact report is only useful in PR context where there's a base branch to diff against.
- **Running on docs-only changes** — `path-filters` in your workflow to skip MD-only PRs saves minutes:

```yaml
on:
  pull_request:
    paths-ignore: ['**/*.md', 'docs/**']
```

## Related

- [`docs/guides/pre-merge-review.md`](./pre-merge-review.md) — the canonical GitHub Action setup
- [`docs/guides/monorepo-setup.md`](./monorepo-setup.md) — caching considerations for large repos
- [`docs/troubleshooting.md`](../troubleshooting.md) — what to do when CI fails
