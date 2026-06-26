# `find_consumers_of_api`

Across all org repos, find every file importing a given npm/pypi/go/maven target.

## Input schema

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Target package or module name"
    }
  },
  "required": [
    "target"
  ]
}
```

## Required arguments

- `target`

## Properties

| Name | Type | Description |
|------|------|-------------|
| `target` | string | Target package or module name |

## See also

- [Index of all MCP tools](./README.md)