---
id: natural-comments
severity: MINOR
languages: [typescript]
paths: ['tests/**', 'pages/**', 'components/**', 'support/**', 'test-runner.config.ts']
---

# Comments are one short natural line

A comment says what the code cannot: a storefront quirk, a ticket, a reason. It never narrates the change, the session or the author, and it uses commas or colons, not dashes.

Good:

```ts
// The accept control renders inside a shadow root, so it is matched by role.
```

Bad:

```ts
// Fixed this after a long debugging session. Before it was flaky, now it finally works!
// Tried three selectors first, see the chat.
```
