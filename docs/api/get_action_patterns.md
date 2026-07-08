# `get_action_patterns`

> ⚠️ **Deprecated (CF-7).** Use `patterns(kind="actions")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

Procedural patterns mined from git history: "when developers add X, they also touch Y". Filter by natural-language intent.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "intent": {
      "type": "string",
      "description": "Optional intent filter (e.g. \"add route\")."
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
| `intent` | string | Optional intent filter (e.g. "add route"). |

## See also

- [Index of all MCP tools](./README.md)