# `get_high_impact_files`

Get the files with the highest blast radius — most other files depend on them. Changing these files is highest risk.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "number",
      "description": "Number of files to return (default 10)"
    }
  },
  "required": []
}
```

## Required arguments

_None._

## Properties

| Name | Type | Description |
|------|------|-------------|
| `limit` | number | Number of files to return (default 10) |

## See also

- [Index of all MCP tools](./README.md)