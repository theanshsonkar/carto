# `get_arch_events`

Architectural events (domain split, merge, growth, hotspot emergence). Severity filter: minor | major | critical.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "severity": {
      "type": "string",
      "description": "Filter: minor | major | critical."
    },
    "kind": {
      "type": "string",
      "description": "Optional kind filter (e.g. domain_growth, hotspot_active)."
    },
    "time_range": {
      "type": "string",
      "description": "Window like \"90d\" (default \"90d\")."
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
| `severity` | string | Filter: minor \| major \| critical. |
| `kind` | string | Optional kind filter (e.g. domain_growth, hotspot_active). |
| `time_range` | string | Window like "90d" (default "90d"). |

## See also

- [Index of all MCP tools](./README.md)