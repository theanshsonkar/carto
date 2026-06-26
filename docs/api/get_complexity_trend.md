# `get_complexity_trend`

A single file's presence across snapshots + commit count + current blast_radius. Use to track how a file's footprint evolved.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "Relative file path."
    },
    "time_range": {
      "type": "string",
      "description": "Window like \"90d\" (default \"90d\")."
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
| `file` | string | Relative file path. |
| `time_range` | string | Window like "90d" (default "90d"). |

## See also

- [Index of all MCP tools](./README.md)