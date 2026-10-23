---
"apps": patch
---

`mcpRouter` no longer fails discovery when a Streamable HTTP server refuses the
optional GET event stream, for example with a 401, while answering every POST.
The client carries on without the stream, as the MCP SDK does. A refused POST
still reports rejected credentials, and the legacy SSE transport's GET, which is
its session, still fails as before.
