# `get_intervention_history`

> ⚠️ **Deprecated (CF-7).** Use `memory(kind="interventions")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

List interventions (Carto-issued violations and suggestions) optionally filtered by file. Use to see prior warnings on a file before editing it.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "Optional file filter (relative path from project root)."
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
| `file` | string | Optional file filter (relative path from project root). |

## See also

- [Index of all MCP tools](./README.md)