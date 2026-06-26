# `get_domain_health`

Per-domain growth rate, instability, recent events, and hotspot files. Use to spot domains drifting out of bounds.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "domain": {
      "type": "string",
      "description": "Optional domain filter."
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

## See also

- [Index of all MCP tools](./README.md)