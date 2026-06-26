# `get_canonical_pattern`

Highest-quality example of a pattern in the codebase (e.g. canonical route handler). Use as a copy-paste template before writing similar code.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "pattern_type": {
      "type": "string",
      "description": "route_handler | model_definition"
    },
    "domain": {
      "type": "string",
      "description": "Optional domain filter."
    }
  },
  "required": [
    "pattern_type"
  ]
}
```

## Required arguments

- `pattern_type`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `pattern_type` | string | route_handler \| model_definition |
| `domain` | string | Optional domain filter. |

## See also

- [Index of all MCP tools](./README.md)