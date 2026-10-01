---
id: one-behavior-per-test
severity: MINOR
languages: [typescript, javascript]
paths: ["tests/**"]
tags: [judged]
---

# One behavior per test

A test checks one behavior a user would name, and its title says which; a second behavior gets its own test. A failure then names what broke without anyone reading the body.

Good:

```ts
test("a saved note stays after a reload", async ({ notes }) => {
  await notes.add("Buy milk");
  await notes.reload();
  await expect(notes.items()).toHaveText(["Buy milk"]);
});
```

Bad:

```ts
test("notes work", async ({ notes, settings }) => {
  await notes.add("Buy milk");
  await expect(notes.items()).toHaveCount(1);
  await settings.switchTheme("dark");
  await expect(settings.theme()).toHaveText("Dark");
});
```
