# `get_file_receipts`

For one file, returns receipts — everything Carto knows: change history, blast radius, prior interventions and decisions touching this file, active gaps on this file, cross-domain deps. Read-only. Use before proposing a change to a file to understand what depends on it and what has been said about it before.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "Relative file path from project root."
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
| `file` | string | Relative file path from project root. |

## See also

- [Index of all MCP tools](./README.md)