# `get_evolution_delta`

Architectural delta across a time window (requires temporal store). Returns per-domain before/after file counts + event count.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "domain": {
      "type": "string"
    },
    "time_range": {
      "type": "string",
      "description": "Window like \"30d\", \"90d\" (default \"30d\")."
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
| `domain` | string |  |
| `time_range` | string | Window like "30d", "90d" (default "30d"). |

## See also

- [Index of all MCP tools](./README.md)