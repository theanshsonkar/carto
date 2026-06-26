# `get_safety_checklist`

Per-file safety checklist: blast radius, cross-domain coupling, missing tests, temporal hotspot, unresolved interventions. Run before writing a high-impact change.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string"
    }
  },
  "required": [
    "file"
  ]
}
```

## Required arguments

- `file`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `file` | string |  |

## See also

- [Index of all MCP tools](./README.md)