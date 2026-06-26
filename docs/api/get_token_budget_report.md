# `get_token_budget_report`

Diagnostic complement to get_minimal_context_for_intent. Returns context efficiency as a fraction of repo size (used / total tokens approx).

## Input schema

```json
{
  "type": "object",
  "properties": {
    "intent": {
      "type": "string",
      "description": "Intent to budget for."
    },
    "budget_tokens": {
      "type": "number"
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
| `intent` | string | Intent to budget for. |
| `budget_tokens` | number |  |

## See also

- [Index of all MCP tools](./README.md)