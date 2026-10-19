---
"apps": patch
---

`accountRouter` keeps a tool's definitions in its schema's root `$defs` instead of
copying them into each account branch. Listings share root `$defs` entries
among tools, so an API linked through an account is no longer described with a
separate copy of every definition for each tool. A branch whose definitions
differ from another's, or whose references reach beyond its own `$defs`, keeps
them inside the branch as before.
