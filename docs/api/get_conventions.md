# `get_conventions`

Naming + export + directory conventions that apply to a given file or directory. Confidence-scored. Use before writing new code in this location.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "Relative file path or directory."
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
| `file` | string | Relative file path or directory. |

## See also

- [Index of all MCP tools](./README.md)