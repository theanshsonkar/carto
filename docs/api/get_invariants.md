# `get_invariants`

Architectural invariants mined from the import graph: "Domain X never imports from Y", "Files in Z always export N symbols", etc. Confidence-scored.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "domain": {
      "type": "string",
      "description": "Optional domain filter."
    },
    "threshold": {
      "type": "number",
      "description": "Confidence threshold 0-1 (default 0.85)."
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
| `domain` | string | Optional domain filter. |
| `threshold` | number | Confidence threshold 0-1 (default 0.85). |

## See also

- [Index of all MCP tools](./README.md)