---
"@executor-js/hosted-self-host": patch
---

A refused SSO sign-in returns to the login page with the reason: the provider didn't verify the
email address, the domain isn't approved, the account isn't a member, the instance isn't set up,
or the address already has a password account. It used to end on a raw JSON error.
