# `get_hot_in_prod_no_tests`

Files whose routes receive >0 runtime hits but have no detected test file. The "ship a test here first" list.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "otlp_path": {
      "type": "string",
      "description": "Path to OTLP file (required)."
    }
  },
  "required": [
    "otlp_path"
  ]
}
```

## Required arguments

- `otlp_path`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `otlp_path` | string | Path to OTLP file (required). |

## See also

- [Index of all MCP tools](./README.md)