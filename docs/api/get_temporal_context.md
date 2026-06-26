# `get_temporal_context`

A file's full temporal context: first_seen_ts, last_modified_ts, commit_count, blast_radius, recent events, age in days.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "Relative file path."
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

## See also

- [Index of all MCP tools](./README.md)