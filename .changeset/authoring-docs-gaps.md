---
"@executor-js/app-templates": patch
---

The app-authoring skill now says to check `accounts.oauthSetup` for a first-party
client before asking for one, that self-host follows the hosted examples, and that
the connect tools need `body: {}`. It documents rename and slug changes, the
45-second webhook limit, the migration file size limit, `ctx.files`, which names a
dynamic router can be called with, and skills-only apps, and it fixes the hello,
`live-inbox` and MCP `signal` examples.
