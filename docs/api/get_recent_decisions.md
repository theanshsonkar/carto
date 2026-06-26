# `get_recent_decisions`

List recent validation decisions and architectural choices the AI has made in this project. Returns time-descending rows.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "time_range": {
      "type": "string",
      "description": "Time window like \"7d\", \"24h\", \"1h\" (default \"7d\")."
    },
    "kind": {
      "type": "string",
      "description": "Optional filter — e.g. \"validation\"."
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
| `time_range` | string | Time window like "7d", "24h", "1h" (default "7d"). |
| `kind` | string | Optional filter — e.g. "validation". |

## See also

- [Index of all MCP tools](./README.md)