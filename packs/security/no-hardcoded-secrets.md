---
id: no-hardcoded-secrets
severity: BLOCKER
---

# No hard-coded secrets

Credentials, API keys, tokens and connection strings must be read from the
environment or a secret manager, never written as a literal in source or
committed to configuration. A leaked secret in history is compromised even
after it is removed.
