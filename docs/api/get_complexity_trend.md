# `get_complexity_trend`

> ⚠️ **Deprecated (CF-7).** Use `history(view="complexity")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

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