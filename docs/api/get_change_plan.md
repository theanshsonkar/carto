# `get_change_plan`

Given a natural-language intent (e.g. "add rate limiting to /api/users"), returns: files to touch, domains affected, blast radius, and similar patterns in the codebase.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "intent": {
      "type": "string",
      "description": "Natural language description of the change you want to make"
    }
  },
  "required": [
    "intent"
  ]
}
```

## Required arguments

- `intent`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `intent` | string | Natural language description of the change you want to make |

## See also

- [Index of all MCP tools](./README.md)