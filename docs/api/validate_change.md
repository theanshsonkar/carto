# `validate_change`

Pre-write governance: given a file + proposed full content, synthesizes a diff vs disk and runs validate_diff. Use in IDE onWillSaveTextDocument hooks.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string"
    },
    "content": {
      "type": "string"
    }
  },
  "required": [
    "file",
    "content"
  ]
}
```

## Required arguments

- `file`
- `content`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `file` | string |  |
| `content` | string |  |

## See also

- [Index of all MCP tools](./README.md)