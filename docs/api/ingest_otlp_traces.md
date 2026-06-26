# `ingest_otlp_traces`

Parse an OpenTelemetry OTLP JSON/JSONL trace file and aggregate per-route hit counts. Use the resulting counts with get_risk_weighted_blast_radius.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to OTLP file"
    }
  },
  "required": [
    "path"
  ]
}
```

## Required arguments

- `path`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `path` | string | Path to OTLP file |

## See also

- [Index of all MCP tools](./README.md)