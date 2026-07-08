# `get_service_boundary_violations`

> ⚠️ **Deprecated (CF-7).** Use `org(view="violations")` instead. This name still resolves and returns byte-identical output for a deprecation window, but is no longer listed by default and emits a one-line notice.

Cross-repo edges that import private/internal surface (heuristic: target path contains internal / private / _lib).

## Input schema

```json
{
  "type": "object",
  "properties": {},
  "required": []
}
```

## Required arguments

_None._

## Properties

_None._

## See also

- [Index of all MCP tools](./README.md)