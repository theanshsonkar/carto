# `get_cross_repo_blast_radius`

Direct downstream consumers of a producer repo. "If I break repo X, who notices?"

## Input schema

```json
{
  "type": "object",
  "properties": {
    "repo": {
      "type": "string",
      "description": "Producer repo name"
    }
  },
  "required": [
    "repo"
  ]
}
```

## Required arguments

- `repo`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `repo` | string | Producer repo name |

## See also

- [Index of all MCP tools](./README.md)