# `did_we_discuss_this`

Substring search over the episodic memory log (decisions + interventions) for prior discussions of a topic. Use to avoid re-deciding settled questions.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "topic": {
      "type": "string",
      "description": "Topic to search for, e.g. \"auth\", \"snake_case\", \"blast radius\"."
    }
  },
  "required": [
    "topic"
  ]
}
```

## Required arguments

- `topic`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `topic` | string | Topic to search for, e.g. "auth", "snake_case", "blast radius". |

## See also

- [Index of all MCP tools](./README.md)