# `get_hotspot_files`

Top files by churn × blast_radius score over a window. The CodeHealth heuristic: high-churn files in high-blast-radius positions are where bugs cluster.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "time_range": {
      "type": "string",
      "description": "Window like \"30d\", \"90d\" (default \"90d\")."
    },
    "limit": {
      "type": "number",
      "description": "Max rows (default 20)."
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
| `time_range` | string | Window like "30d", "90d" (default "90d"). |
| `limit` | number | Max rows (default 20). |

## See also

- [Index of all MCP tools](./README.md)