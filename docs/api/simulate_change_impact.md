# `simulate_change_impact`

> ⚠️ **Deprecated (CF-7).** Use `impact(files, mode="simulate")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

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