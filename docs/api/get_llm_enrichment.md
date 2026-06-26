# `get_llm_enrichment`

Per-node summary via a local LLM. Opt-in only; returns disabled stub until `ai.llm` is wired in carto.config.json.

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