# `get_gaps`

The current gap list for this repo — grounded findings from the rule engine ("SHOULD − IS"). Each gap ties to a file + rule_id + evidence. Ranked HIGH > MEDIUM > LOW. Dismissed gaps are excluded by default. Call this when the user asks "what should I fix?", when you enter a new repo for the first time, or before recommending changes to a file. If the response is empty and the project is unsupported, tell the user the rule engine only ships for Next.js + Supabase SaaS-with-auth today.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "rule_id": {
      "type": "string",
      "description": "Optional rule filter, e.g. \"money-as-float\"."
    },
    "file": {
      "type": "string",
      "description": "Optional file filter."
    },
    "severity": {
      "type": "string",
      "description": "Optional severity filter: HIGH | MEDIUM | LOW."
    },
    "include_dismissed": {
      "type": "boolean",
      "description": "Include gaps the user has already dismissed (default false)."
    },
    "refresh": {
      "type": "boolean",
      "description": "Re-run the rule engine before returning (default false — uses last cached run)."
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
| `rule_id` | string | Optional rule filter, e.g. "money-as-float". |
| `file` | string | Optional file filter. |
| `severity` | string | Optional severity filter: HIGH \| MEDIUM \| LOW. |
| `include_dismissed` | boolean | Include gaps the user has already dismissed (default false). |
| `refresh` | boolean | Re-run the rule engine before returning (default false — uses last cached run). |

## See also

- [Index of all MCP tools](./README.md)