# `get_intervention_history`

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