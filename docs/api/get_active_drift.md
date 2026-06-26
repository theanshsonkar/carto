# `get_active_drift`

Domains with active drift in the last 7d: growth, threshold breaches. Use to spot domains drifting before they reach a critical event.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "threshold": {
      "type": "number",
      "description": "Drift threshold 0-1 (default 0.2 = 20%)."
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
| `threshold` | number | Drift threshold 0-1 (default 0.2 = 20%). |

## See also

- [Index of all MCP tools](./README.md)