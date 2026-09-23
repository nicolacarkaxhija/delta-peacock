---
id: conventional-titles
severity: MINOR
languages: [markdown, yaml, json, shell, javascript, typescript]
paths: ["docs/**", ".github/**", "scripts/**", "src/**", "*.md"]
---

# Commit subjects and pull request titles are conventional

Every commit subject, pull request title, release name or changelog line the change writes, or teaches in its docs and templates, reads `type(scope): summary` on one line, with the ticket key once at the end after a comma. A script or template that produces such a line produces that shape, and never adds a trailer or an attribution line.

Good:

```sh
git commit -m "fix(export): keep the header row when the report is empty, PROJ-142"
```

Bad:

```sh
git commit -m "PROJ-142 Fixed export" -m "Co-Authored-By: someone <someone@example.com>"
```
