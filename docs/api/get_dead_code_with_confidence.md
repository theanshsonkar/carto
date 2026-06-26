# `get_dead_code_with_confidence`

Files with zero static dependents AND (when runtime data is supplied) zero observed runtime hits. The "safe to delete" list.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "otlp_path": {
      "type": "string",
      "description": "Optional OTLP file for runtime confirmation."
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
| `otlp_path` | string | Optional OTLP file for runtime confirmation. |

## See also

- [Index of all MCP tools](./README.md)