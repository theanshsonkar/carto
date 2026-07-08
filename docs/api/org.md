# `org`

Cross-repo / multi-repo view: org architecture (default), service dependency graph, cross-repo blast radius, API consumers, per-repo domains, boundary violations, or migration cut points. Requires `carto org init`.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "view": {
      "type": "string",
      "enum": [
        "architecture",
        "graph",
        "blast",
        "consumers",
        "domains",
        "violations",
        "migration"
      ],
      "description": "Which org-wide view to return (default architecture)."
    },
    "repo": {
      "type": "string",
      "description": "Producer repo (view=\"blast\")."
    },
    "target": {
      "type": "string",
      "description": "Package/module (view=\"consumers\")."
    }
  },
  "required": []
}
```

## Required arguments

_None._

## Properties

| Name | Type | Description |
|------|------|-------------|
| `view` | string | Which org-wide view to return (default architecture). |
| `repo` | string | Producer repo (view="blast"). |
| `target` | string | Package/module (view="consumers"). |

## See also

- [Index of all MCP tools](./README.md)