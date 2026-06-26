# Concept: ANCI

> **Architecturally Normalized Code Index** — the open file format for any codebase to describe its architecture to AI tools.

## The problem

Every AI coding tool today re-discovers a codebase's architecture from scratch on every session. Cursor builds its own embedding index. Cline builds its own. Continue builds its own. Same parsing, every tool, every session, every time. Wasted CPU; wasted disk; inconsistent results.

What's missing is a *format*. OpenAPI did this for REST APIs — once any API has an `openapi.yaml`, every tool consumes it the same way. ANCI is the equivalent for codebases.

## What it is

Two files at `.carto/anci.{yaml,bin}`. Together they describe:

- the domain partition (which files belong to which cluster)
- the import graph (forward + reverse adjacency)
- per-file metadata (path, language, exports)
- popcount index (files ranked by transitive dependents)

The split is hybrid by design:

- **`anci.yaml`** — strict-subset YAML 1.2, human-readable, grep-able. Holds the schema version, generator info, domain names, and counts. ~1–4 KB.
- **`anci.bin`** — binary body. Magic `0x49434E41` ("ANCI"), version byte, six sections (forward graph, reverse graph, popcount, paths, file→domain, domain names) packed via Roaring-bitmap-like compression. ~200 KB to ~5 MB depending on repo size.

Why split: a 100K-file repo as pure YAML is 50–500 MB — too large for an AI tool to consume per-session. The binary section solves the size problem without sacrificing the human-readable header.

## Carto is the reference implementation

`carto sync` writes both files automatically on every full sync. The same data the MCP server hands the AI is what ANCI captures on disk. Any tool can consume it without speaking MCP:

```js
const { loadAnci } = require('carto-md/src/anci/consumer');

const reader = loadAnci('./.carto');
console.log(reader.domains);                                    // [{name, file_count}, ...]
console.log(reader.getHighImpactFiles(5));                      // top 5 by transitive dependents
console.log(reader.blastRadius('src/auth/session.ts'));         // { count, hops, files }
console.log(reader.simulateChangeImpact([                       // multi-file change blast radius
  'src/auth/session.ts',
  'src/db/connection.ts',
]));
```

`loadAnci()` has zero dependencies. Anyone shipping an AI tool can drop it in and consume Carto's index without taking on Carto's whole tarball.

## The CLI surface

```bash
carto anci publish               # re-emit anci.{yaml,bin} from the current index
carto anci show                  # human-readable summary
carto anci validate ./.carto     # validate a published pair
```

Publish runs implicitly on `carto sync`, so you only need to invoke these manually if you're debugging.

## Versioning

The spec is at `docs/anci/v0.1-DRAFT.md`. It's a draft; the wire format may break between v0.1.x patches. v1.0+ will follow semver and consumers refusing unsupported major versions is the contract.

The header version is what consumers look at first:

```yaml
anci:
  version: "0.1.0-DRAFT"
  generator: "carto-md@2.0.9"
  generated_at: "2026-06-26T12:34:56Z"
```

A consumer should reject anything outside its supported major.minor prefix.

## Why publish a spec at all

If only Carto consumes Carto's binary format, it's just an internal optimization. If three AI tools agree on a format, it becomes the standard. The OpenAPI precedent: Swagger shipped as a proprietary format in 2011, became de-facto by 2014, formalized as the OpenAPI Initiative by 2016.

Carto's bet is the same: publish the binary spec early, support it as the reference implementation, and let the ecosystem coalesce. Once 3+ AI tools read ANCI, every AI tool has to.

## Status

- Spec: v0.1 DRAFT, published in [`docs/anci/v0.1-DRAFT.md`](../anci/v0.1-DRAFT.md)
- Carto generates the files on every `carto sync`
- Consumer library shipped: `src/anci/consumer.js`
- Partner integration: TBD — first one is the unblocker

## Related

- [`docs/anci/v0.1-DRAFT.md`](../anci/v0.1-DRAFT.md) — the spec itself
- [`mcp-integration.md`](./mcp-integration.md) — the alternative consumption path (live, slightly more flexible, but every consumer pays the MCP-protocol surface tax)
