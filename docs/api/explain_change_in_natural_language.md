# `explain_change_in_natural_language`

Given a unified diff, returns a plain-language summary + risk + violation list + suggestions. Powered by validate_diff.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "diff": {
      "type": "string"
    }
  },
  "required": [
    "diff"
  ]
}
```

## Required arguments

- `diff`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `diff` | string |  |

## See also

- [Index of all MCP tools](./README.md)