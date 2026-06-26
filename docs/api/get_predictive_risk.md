# `get_predictive_risk`

Predictive risk score per file: P(this file causes the next incident). Combines blast radius, churn, cross-domain coupling, intervention history, test presence into a 0-1 score.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "Optional single-file filter; otherwise scores all files."
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
| `file` | string | Optional single-file filter; otherwise scores all files. |

## See also

- [Index of all MCP tools](./README.md)