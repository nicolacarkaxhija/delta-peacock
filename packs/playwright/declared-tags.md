---
id: declared-tags
severity: MINOR
languages: [typescript, javascript]
paths: ["tests/**"]
---

# Only declared tags

A tag selects tests for a run, so a tag no run knows selects nothing. Axis tags are the tags that place a test on the site, environment, locale and device axes, such as `@site:eu` or `@not-device:mobile`, built from the sites, environments, locales and devices the configuration file named by `review.repoConfigPath` lists; feature tags are the keys it lists under `tags.features`. A test carries only axis tags and the feature tags the config declares, never `@smoke` or another tag the config does not list. Tags belong in the tag option, never in the test title.

Good:

```ts
test("a guest reads a shared note", { tag: ["@sharing"] }, async ({ notes }) => {
  await expect(notes.sharedBanner()).toBeVisible();
});
```

Bad:

```ts
test("a guest reads a shared note @sharing", { tag: ["@quick"] }, async ({ notes }) => {
  await expect(notes.sharedBanner()).toBeVisible();
});
```
