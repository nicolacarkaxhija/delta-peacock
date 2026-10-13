---
id: base-page-stays-small
severity: MINOR
languages: [typescript]
paths: ['screens/**']
exclusions:
  - "A member that two or more screens use, or that runs for every screen, belongs on the base screen."
---

# The base screen stays small: what one screen needs lives on that screen

Every spec imports screens/base.ts, so a line added there selects the whole suite on every pull request. A new behavior goes on the screen that owns it, and the base screen grows only when several screens need the same thing.

A member that two or more screens use, or that runs for every screen, belongs on the base screen.

Good:

```ts
// screens/editor.ts
export class EditorScreen extends BaseScreen {
  fontPicker(): Locator {
    return this.page.getByTestId('font_picker');
  }
}
```

Bad:

```ts
// screens/base.ts, in a pull request about the editor
export class BaseScreen {
  fontPicker(): Locator {
    return this.page.getByTestId('font_picker');
  }
}
```
