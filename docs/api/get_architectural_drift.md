# `get_architectural_drift`

Per-domain growth/shrink and event count over a time window. Run `carto temporal init` first to backfill from git history.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "domain": {
      "type": "string",
      "description": "Optional domain filter (e.g. AUTH)."
    },
    "time_range": {
      "type": "string",
      "description": "Window like \"30d\", \"90d\", \"1y\" (default \"30d\")."
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
| `domain` | string | Optional domain filter (e.g. AUTH). |
| `time_range` | string | Window like "30d", "90d", "1y" (default "30d"). |

## See also

- [Index of all MCP tools](./README.md)