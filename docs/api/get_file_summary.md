# `get_file_summary`

Get a 3-sentence description of what a file does, its role in the project, and its key dependencies and dependents.

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