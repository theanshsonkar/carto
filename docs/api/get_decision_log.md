# `get_decision_log`

Recent decisions from the episodic-memory log, optionally annotated with concurrent architectural events from the temporal store.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "hours": {
      "type": "number",
      "description": "Lookback hours (default 168 = 7d)."
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
| `hours` | number | Lookback hours (default 168 = 7d). |

## See also

- [Index of all MCP tools](./README.md)