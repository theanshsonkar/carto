# `get_decision_log`

> ⚠️ **Deprecated (CF-7).** Use `memory(kind="log")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

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