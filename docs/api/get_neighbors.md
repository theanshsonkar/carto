# `get_neighbors`

Get import graph neighbors of a file — files it imports and files that import it. Returns nodes and edges for visualization.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "Relative file path from project root"
    },
    "hops": {
      "type": "number",
      "description": "How many hops to traverse (default 1, max 3)"
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
| `hops` | number | How many hops to traverse (default 1, max 3) |

## See also

- [Index of all MCP tools](./README.md)