# `impact`

Impact of changing code: blast radius (default), multi-file simulate, import neighbors, or data flow. Signature capability — "what breaks if I touch this?"

## Input schema

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "Relative file path (modes: blast, neighbors, data_flow)."
    },
    "files": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "File paths for mode=\"simulate\" (change a set at once)."
    },
    "mode": {
      "type": "string",
      "enum": [
        "blast",
        "simulate",
        "neighbors",
        "data_flow"
      ],
      "description": "blast=transitive dependents (default); simulate=union for a file set; neighbors=import graph neighbors; data_flow=upstream/downstream + routes/models/env."
    },
    "hops": {
      "type": "number",
      "description": "Neighbor hops (mode=\"neighbors\", default 1, max 3)."
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
| `file` | string | Relative file path (modes: blast, neighbors, data_flow). |
| `files` | array | File paths for mode="simulate" (change a set at once). |
| `mode` | string | blast=transitive dependents (default); simulate=union for a file set; neighbors=import graph neighbors; data_flow=upstream/downstream + routes/models/env. |
| `hops` | number | Neighbor hops (mode="neighbors", default 1, max 3). |

## See also

- [Index of all MCP tools](./README.md)