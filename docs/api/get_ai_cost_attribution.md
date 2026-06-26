# `get_ai_cost_attribution`

Per-AI-client decision counts + violation counts. Use to attribute cross-domain coupling cost to individual AI sessions / developers.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "hours": {
      "type": "number",
      "description": "Lookback hours (default 168 = 7d)."
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
| `hours` | number | Lookback hours (default 168 = 7d). |

## See also

- [Index of all MCP tools](./README.md)