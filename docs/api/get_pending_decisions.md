# `get_pending_decisions`

Recent decisions with pending/unresolved/HIGH-risk flags in their payload. Surfaces unfinished AI work from the episodic log.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "hours": {
      "type": "number",
      "description": "Lookback window in hours (default 6)."
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
| `hours` | number | Lookback window in hours (default 6). |

## See also

- [Index of all MCP tools](./README.md)