# `get_models`

Get all data models (Prisma, Pydantic, TypeScript interfaces, Zod schemas) across the project, optionally filtered by domain.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "domain": {
      "type": "string",
      "description": "Optional domain filter e.g. AUTH, DATABASE"
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
| `domain` | string | Optional domain filter e.g. AUTH, DATABASE |

## See also

- [Index of all MCP tools](./README.md)