# `dismiss_gap`

Mark a specific gap as intentional. Writes the dismissal to the gaps table so the same gap does not re-surface on the next run. Idempotent — re-dismissing updates the reason. Only call this when the user explicitly says the gap is intentional; never dismiss on your own judgment.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "gap_hash": {
      "type": "string",
      "description": "The gap_hash from get_gaps output."
    },
    "reason": {
      "type": "string",
      "description": "Short explanation of why this gap is intentional. Optional but strongly encouraged."
    }
  },
  "required": [
    "gap_hash"
  ]
}
```

## Required arguments

- `gap_hash`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `gap_hash` | string | The gap_hash from get_gaps output. |
| `reason` | string | Short explanation of why this gap is intentional. Optional but strongly encouraged. |

## See also

- [Index of all MCP tools](./README.md)