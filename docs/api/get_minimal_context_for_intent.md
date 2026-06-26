# `get_minimal_context_for_intent`

Token-budgeted context picker. Given a natural-language intent + a budget (default 4000 tokens), returns the minimum file set needed via hybrid retrieval (structural + lexical + semantic) with RRF fusion and high-blast / same-domain / recent-changes boosts. Reports per-file token cost.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "intent": {
      "type": "string",
      "description": "Natural-language description of the change."
    },
    "budget_tokens": {
      "type": "number",
      "description": "Token budget (default 4000)."
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
| `budget_tokens` | number | Token budget (default 4000). |

## See also

- [Index of all MCP tools](./README.md)