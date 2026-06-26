# `get_env_vars`

Get all environment variables used in this project, with which files use them and which domains they belong to.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "domain": {
      "type": "string",
      "description": "Optional domain filter e.g. AUTH, PAYMENTS"
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
| `domain` | string | Optional domain filter e.g. AUTH, PAYMENTS |

## See also

- [Index of all MCP tools](./README.md)