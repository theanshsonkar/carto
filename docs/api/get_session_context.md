# `get_session_context`

> ⚠️ **Deprecated (CF-7).** Use `memory(kind="session")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

Full context for an AI session: every decision and every intervention, ordered chronologically. Use to recap what happened in a long-running session.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "number",
      "description": "Session id. Defaults to the most recent active session."
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
| `session_id` | number | Session id. Defaults to the most recent active session. |

## See also

- [Index of all MCP tools](./README.md)