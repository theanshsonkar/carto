# `get_microservice_cut_points`

Natural microservice cut-points: domains with high cohesion (intra-edges) AND low external coupling. Use to plan extraction-style refactors.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "threshold": {
      "type": "number",
      "description": "Cohesion threshold 0-1 (default 0.7)."
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
| `threshold` | number | Cohesion threshold 0-1 (default 0.7). |

## See also

- [Index of all MCP tools](./README.md)