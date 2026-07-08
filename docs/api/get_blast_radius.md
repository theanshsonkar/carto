# `get_blast_radius`

> ⚠️ **Deprecated (CF-7).** Use `impact(file, mode="blast")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

Get all files, routes, and domains affected by changing a specific file. Includes risk level per route.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "Relative file path from project root"
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

## See also

- [Index of all MCP tools](./README.md)