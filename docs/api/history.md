# `history`

Temporal/architectural history: domain drift (default), domain evolution, hotspots, arch events, a file's timeline, change velocity, complexity trend, churn-vs-blast, domain health. Requires `carto temporal init`.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "view": {
      "type": "string",
      "enum": [
        "drift",
        "evolution",
        "hotspots",
        "events",
        "file",
        "velocity",
        "complexity",
        "churn",
        "health"
      ],
      "description": "Which historical view to return (default drift)."
    },
    "domain": {
      "type": "string",
      "description": "Domain filter (drift/evolution/health)."
    },
    "file": {
      "type": "string",
      "description": "File (file/complexity views)."
    },
    "time_range": {
      "type": "string",
      "description": "Window like \"30d\", \"90d\"."
    },
    "limit": {
      "type": "number",
      "description": "Row cap (hotspots)."
    },
    "severity": {
      "type": "string",
      "description": "Event severity (events)."
    },
    "kind": {
      "type": "string",
      "description": "Event kind (events)."
    },
    "days": {
      "type": "number",
      "description": "Lookback days (velocity)."
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
| `view` | string | Which historical view to return (default drift). |
| `domain` | string | Domain filter (drift/evolution/health). |
| `file` | string | File (file/complexity views). |
| `time_range` | string | Window like "30d", "90d". |
| `limit` | number | Row cap (hotspots). |
| `severity` | string | Event severity (events). |
| `kind` | string | Event kind (events). |
| `days` | number | Lookback days (velocity). |

## See also

- [Index of all MCP tools](./README.md)