# `get_similar_patterns`

Given a file, find structurally similar files — same import pattern, same route shape, or same domain. Use to find conventions to follow before writing new code.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "Relative file path from project root"
    },
    "limit": {
      "type": "number",
      "description": "Max results to return (default 5)"
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
| `file` | string | Relative file path from project root |
| `limit` | number | Max results to return (default 5) |

## See also

- [Index of all MCP tools](./README.md)