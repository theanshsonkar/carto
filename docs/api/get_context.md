# `get_context`

Get full structural context for a file: domain, blast radius, import neighbors, routes, models, env vars, and cross-domain dependencies. Single call for everything.

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