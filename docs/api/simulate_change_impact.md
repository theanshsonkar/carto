# `simulate_change_impact`

Given a list of files, returns all files transitively affected by changing them simultaneously, with hop distance. Powered by the bitmap engine — only feasible at this speed (sub-millisecond) with bitmap OR-aggregation. Use when planning a refactor that touches multiple files.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Array of relative file paths from project root"
    }
  },
  "required": [
    "files"
  ]
}
```

## Required arguments

- `files`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `files` | array | Array of relative file paths from project root |

## See also

- [Index of all MCP tools](./README.md)