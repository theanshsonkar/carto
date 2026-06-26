# `get_domain`

Get all routes, models, functions, and context for a specific domain (AUTH, PAYMENTS, TRPC, DATABASE, EVENTS, NOTIFICATIONS, CORE).

## Input schema

```json
{
  "type": "object",
  "properties": {
    "domain": {
      "type": "string",
      "description": "Domain name e.g. AUTH, PAYMENTS, DATABASE"
    }
  },
  "required": [
    "domain"
  ]
}
```

## Required arguments

- `domain`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `domain` | string | Domain name e.g. AUTH, PAYMENTS, DATABASE |

## See also

- [Index of all MCP tools](./README.md)