---
"@executor-js/hosted-self-host": patch
---

Self-host SSO admits a member from an allowed domain when the identity provider asserts
`email_verified` only at its UserInfo endpoint, as Okta's org authorization server does. The ID
token is still verified first. UserInfo claims are used only when their subject matches the ID
token's, and claims in the ID token take precedence.
