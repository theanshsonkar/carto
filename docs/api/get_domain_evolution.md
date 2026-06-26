# `get_domain_evolution`

Time-series of a single domain's file count, by snapshot. Use to chart a domain's growth over the last quarter.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "domain": {
      "type": "string",
      "description": "Domain name (e.g. AUTH)."
    },
    "time_range": {
      "type": "string",
      "description": "Window like \"30d\", \"90d\" (default \"90d\")."
    }
  },
  "required": [
    "domain"
  ]
}
```

## Required arguments

- `domain`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `domain` | string | Domain name (e.g. AUTH). |
| `time_range` | string | Window like "30d", "90d" (default "90d"). |

## See also

- [Index of all MCP tools](./README.md)