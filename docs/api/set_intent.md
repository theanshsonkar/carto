# `set_intent`

Capture a user-stated intent about this project — product type, stack, or a scope note ("single-user for now"). Product-type gates every rule in the rule engine, so calling this correctly is how the AI unlocks (or narrows) gap detection. Notes accumulate — this tool never overwrites prior notes, only appends.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "product_type": {
      "type": "string",
      "description": "The product classification, e.g. \"saas-with-auth\" or \"unsupported\"."
    },
    "stack": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional explicit stack list, e.g. [\"Next.js\", \"Supabase\"]. Replaces the auto-detected stack."
    },
    "note": {
      "type": "string",
      "description": "A single scope statement from the user. Timestamped and appended to the notes array."
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
| `product_type` | string | The product classification, e.g. "saas-with-auth" or "unsupported". |
| `stack` | array | Optional explicit stack list, e.g. ["Next.js", "Supabase"]. Replaces the auto-detected stack. |
| `note` | string | A single scope statement from the user. Timestamped and appended to the notes array. |

## See also

- [Index of all MCP tools](./README.md)