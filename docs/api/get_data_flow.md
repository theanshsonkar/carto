# `get_data_flow`

> ⚠️ **Deprecated (CF-7).** Use `impact(file, mode="data_flow")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

Per-file data-flow snapshot: upstream imports + downstream importers + routes + models + env vars in the file. The AI-friendly view, not full taint analysis.

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