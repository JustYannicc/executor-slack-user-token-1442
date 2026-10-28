---
"apps": patch
"executor": minor
---

Add opt-in opaque app addresses and sandboxed embedded App tabs to hosted Executor.
Nested addresses and separate-tab screens remain the defaults. HTTPS dashboard
auth cookies now use the host-only `__Host-` prefix on every deployment. Existing
HTTPS browser sessions need one sign-in after upgrading; HTTP self-host cookie
names, database sessions and bearer credentials are unchanged. HTTPS preference,
passkey-enrollment and anonymous visitor cookies are also host-only.
