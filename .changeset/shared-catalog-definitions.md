---
"apps": patch
"@executor-js/sdk": patch
"@executor-js/utils": patch
"@executor-js/mcp": patch
"@executor-js/mcp-auth": patch
"@executor-js/hosted-server": patch
"@executor-js/hosted-web": patch
"@executor-js/local-server": patch
"@executor-js/local-web": patch
"@executor-js/ui": patch
---

An app's tool catalog sends each JSON Schema definition, and each distinct `$defs` of its tools'
schemas, once, instead of a copy in every tool that reaches it. A densely connected OpenAPI
document, such as Stripe's, now lists its tools: its 8 MB description had made a
384-million-character catalog that could not be sent, and now sends 6.8 million characters. The
tools and schemas a catalog lists are unchanged. Apps get this when they are rebuilt on this `apps`
release. Kept tool listings hold each distinct `$defs` once too.

`tools.list` pages end before the tool that would take the page's JSON past 16 Mi characters, so a
page of such tools stays a size a client and a Worker can hold. Follow `next` for the rest.
In-process readers that keep every page pass `unboundedPages`.

The hosted connection tool picker and the local Tools tab list the schema-free index and read a
selected tool's schemas on their own, through the new local `GET /dashboard/api/apps/:app/tools/:tool`.
