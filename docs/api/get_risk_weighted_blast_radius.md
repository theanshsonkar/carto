# `get_risk_weighted_blast_radius`

Combine static dependents with runtime call counts (from ingest_otlp_traces or similar) to rank routes by real-world risk. `risk = dependents × runtime_calls + dependents`.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "otlp_path": {
      "type": "string",
      "description": "Optional OTLP file for runtime data."
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
| `otlp_path` | string | Optional OTLP file for runtime data. |

## See also

- [Index of all MCP tools](./README.md)