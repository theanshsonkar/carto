# `get_churn_vs_blast_radius`

Scatter data of churn vs blast_radius for every changed file in a window. Use to find risk hotspots.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "time_range": {
      "type": "string",
      "description": "Window like \"90d\" (default \"90d\")."
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
| `time_range` | string | Window like "90d" (default "90d"). |

## See also

- [Index of all MCP tools](./README.md)