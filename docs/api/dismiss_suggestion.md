# `dismiss_suggestion`

Mark a suggestion ID as dismissed for the current session. Acknowledgment-only; the underlying signal still exists.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Suggestion id from get_active_suggestions."
    }
  },
  "required": [
    "id"
  ]
}
```

## Required arguments

- `id`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `id` | string | Suggestion id from get_active_suggestions. |

## See also

- [Index of all MCP tools](./README.md)