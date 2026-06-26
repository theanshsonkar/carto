# `get_semantic_diff`

Beyond line-by-line: detect renames, symbol relocations across files, and new-domain introductions from a unified diff.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "diff": {
      "type": "string",
      "description": "Unified diff text."
    }
  },
  "required": [
    "diff"
  ]
}
```

## Required arguments

- `diff`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `diff` | string | Unified diff text. |

## See also

- [Index of all MCP tools](./README.md)