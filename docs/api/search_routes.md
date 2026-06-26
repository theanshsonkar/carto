# `search_routes`

Search API routes by path or method. Case-insensitive.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query e.g. \"auth\", \"POST\", \"/api/users\""
    }
  },
  "required": [
    "query"
  ]
}
```

## Required arguments

- `query`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `query` | string | Search query e.g. "auth", "POST", "/api/users" |

## See also

- [Index of all MCP tools](./README.md)