---
description: Is this session governed by Clevr, by which engine, in which mode, and what did it last decide.
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/hooks/clevr-status.mjs"`

Show the status block above to the user exactly as it is, in a code block, and add nothing else. If it says the gate is not connected, repeat the two variables to set. Do not run any other tool.
