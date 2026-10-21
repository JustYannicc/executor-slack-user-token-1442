---
"apps": patch
---

An `mcpRouter` tool's `readOnlyHint`, as `toolAnnotations` returns it to an approval rule,
now follows the tool's kind, as its listing already did. A `kinds` entry is the app's own
classification, so it replaces the server's hint: a tool the app names a mutation asks under
`readOnlyHint === true ? undefined : always()` even when the server calls it read-only, and an
unhinted tool the app names a query runs without approval. Before, the listing showed the app's
classification while the rule read the server's hint.
