# `find_consumers_of_api`

> ⚠️ **Deprecated (CF-7).** Use `org(view="consumers")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

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