# `get_action_patterns`

Procedural patterns mined from git history: "when developers add X, they also touch Y". Filter by natural-language intent.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "intent": {
      "type": "string",
      "description": "Optional intent filter (e.g. \"add route\")."
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
| `intent` | string | Optional intent filter (e.g. "add route"). |

## See also

- [Index of all MCP tools](./README.md)