# `get_change_velocity`

Commits-per-day over a window (requires temporal store). Useful for spotting development tempo shifts.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "days": {
      "type": "number",
      "description": "Lookback days (default 30)."
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
| `days` | number | Lookback days (default 30). |

## See also

- [Index of all MCP tools](./README.md)