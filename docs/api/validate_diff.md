# `validate_diff`

Given a unified diff, returns: violations (cross-domain imports, high-blast files), blast radius per file, risk level (SAFE/LOW/MEDIUM/HIGH), and suggestions. Sub-15ms p99 on a 7K-file repo. Each call is recorded in the episodic memory log so other tools can ask "did we discuss this?".

## Input schema

```json
{
  "type": "object",
  "properties": {
    "diff": {
      "type": "string",
      "description": "Unified diff text (output of `git diff` / GitHub PR patch)."
    },
    "session_id": {
      "type": "number",
      "description": "Optional session id. Defaults to the most recent active session, or a fresh one."
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
| `diff` | string | Unified diff text (output of `git diff` / GitHub PR patch). |
| `session_id` | number | Optional session id. Defaults to the most recent active session, or a fresh one. |

## See also

- [Index of all MCP tools](./README.md)