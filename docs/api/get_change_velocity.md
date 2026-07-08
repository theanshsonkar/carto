# `get_change_velocity`

> ⚠️ **Deprecated (CF-7).** Use `history(view="velocity")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

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