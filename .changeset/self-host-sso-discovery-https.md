---
"@executor-js/hosted-self-host": patch
---

Self-host SSO reads the provider's discovery document once at startup, from exactly
`SSO_DISCOVERY_URL`, and does not follow redirects. Every endpoint it names must use HTTPS. If
the document is unusable, SSO stays unavailable and the log says why; other sign-in keeps working.
