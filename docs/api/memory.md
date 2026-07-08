# `memory`

Episodic memory: search past decisions (default), decision log, recent decisions, session recap, pending work, or a file's intervention history. Ask "did we already decide this?"

## Input schema

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "search",
        "log",
        "recent",
        "session",
        "pending",
        "interventions"
      ],
      "description": "search=substring over the log (default); log=recent decision log; recent=validation decisions; session=full session recap; pending=unfinished/HIGH-risk work; interventions=warnings on a file."
    },
    "query": {
      "type": "string",
      "description": "Search topic (kind=\"search\")."
    },
    "file": {
      "type": "string",
      "description": "File filter (kind=\"interventions\")."
    },
    "hours": {
      "type": "number",
      "description": "Lookback hours (kind=\"log\"/\"pending\")."
    },
    "time_range": {
      "type": "string",
      "description": "Window like \"7d\" (kind=\"recent\")."
    },
    "filter": {
      "type": "string",
      "description": "Decision-kind filter (kind=\"recent\")."
    },
    "session_id": {
      "type": "number",
      "description": "Session id (kind=\"session\")."
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
| `kind` | string | search=substring over the log (default); log=recent decision log; recent=validation decisions; session=full session recap; pending=unfinished/HIGH-risk work; interventions=warnings on a file. |
| `query` | string | Search topic (kind="search"). |
| `file` | string | File filter (kind="interventions"). |
| `hours` | number | Lookback hours (kind="log"/"pending"). |
| `time_range` | string | Window like "7d" (kind="recent"). |
| `filter` | string | Decision-kind filter (kind="recent"). |
| `session_id` | number | Session id (kind="session"). |

## See also

- [Index of all MCP tools](./README.md)