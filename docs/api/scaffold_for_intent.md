# `scaffold_for_intent`

For a natural-language intent ("add a payment route"), returns: anchor file + co-changed files + canonical pattern + conventions to follow. Combines invariants, conventions, and procedural memory.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "intent": {
      "type": "string",
      "description": "Natural-language description of the change."
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
| `intent` | string | Natural-language description of the change. |

## See also

- [Index of all MCP tools](./README.md)