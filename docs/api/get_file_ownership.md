# `get_file_ownership`

Implicit ownership detection via `git blame`. Returns top author + per-author line counts. Fails soft if git is unavailable.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string"
    }
  },
  "required": [
    "file"
  ]
}
```

## Required arguments

- `file`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `file` | string |  |

## See also

- [Index of all MCP tools](./README.md)