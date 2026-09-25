---
id: no-secrets-in-files
severity: BLOCKER
languages: [typescript]
paths: ['**']
---

# No secrets, passwords or card numbers in a committed file

.env holds every secret; the config names variables, never values. Even the Adyen test cards are variables, because no card number belongs in git.

Good:

```ts
password: { var: 'E2E_STOREFRONT_PASSWORD_STG' }
```

Bad:

```ts
password: '********', // the real value pasted in
cardNumber: '****', // a test card, still a card number
```
