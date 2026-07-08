# `patterns`

Semantic + procedural patterns mined from the repo: architectural invariants (default), naming/export/dir conventions, canonical exemplar, or "when X changes, Y changes" action patterns.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "invariants",
        "conventions",
        "canonical",
        "actions"
      ],
      "description": "invariants=mined rules (default); conventions=naming/export/dir; canonical=best exemplar; actions=git co-change patterns."
    },
    "domain": {
      "type": "string",
      "description": "Domain filter (invariants/canonical)."
    },
    "threshold": {
      "type": "number",
      "description": "Confidence threshold (invariants)."
    },
    "file": {
      "type": "string",
      "description": "File or directory (conventions)."
    },
    "pattern_type": {
      "type": "string",
      "description": "route_handler | model_definition (canonical)."
    },
    "intent": {
      "type": "string",
      "description": "Intent filter (actions)."
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
| `kind` | string | invariants=mined rules (default); conventions=naming/export/dir; canonical=best exemplar; actions=git co-change patterns. |
| `domain` | string | Domain filter (invariants/canonical). |
| `threshold` | number | Confidence threshold (invariants). |
| `file` | string | File or directory (conventions). |
| `pattern_type` | string | route_handler \| model_definition (canonical). |
| `intent` | string | Intent filter (actions). |

## See also

- [Index of all MCP tools](./README.md)