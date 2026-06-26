# `get_drift_digest`

Weekly architectural digest: domain drift, hotspots, events, predicted-risk top 10. CLI-renderable markdown.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "time_range": {
      "type": "string",
      "description": "Window like \"7d\", \"30d\" (default \"7d\")."
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
| `time_range` | string | Window like "7d", "30d" (default "7d"). |

## See also

- [Index of all MCP tools](./README.md)