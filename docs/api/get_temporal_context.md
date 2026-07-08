# `get_temporal_context`

> ⚠️ **Deprecated (CF-7).** Use `history(view="file")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

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