---
id: errors-never-swallowed
severity: MAJOR
languages: [typescript, javascript]
tags: [judged]
---

# Errors are never swallowed

A catch handles the failure it expects and lets every other one through: it rethrows with the cause, or logs with enough context to act on. Returning a default for an expected absence, such as a missing optional file, is handling. An empty catch, or a catch that returns a default for every error, hides the unexpected failure from everyone who could fix it.

Good:

```ts
try {
  return await readSettings(file);
} catch (error) {
  // No settings file yet means the defaults apply.
  if (isMissingFile(error)) return {};
  throw new Error(`settings in ${file} are unreadable`, { cause: error });
}
```

Bad:

```ts
try {
  return await readSettings(file);
} catch {
  return {};
}
```
