---
id: page-objects-extend-base
severity: MAJOR
languages: [typescript]
paths: ['pages/**', 'components/**']
---

# Page objects extend BasePage; shared fragments are component objects

pages/base.ts carries consent handling, stabilization and URL resolution by page key; a class that skips it opens pages its own way and loses all three.

A fragment many pages render, such as the header, the footer or the consent banner, is not a page: it has no page key and never navigates. It lives under components/ as a component object named for what it is, with no Page suffix, extends Component from components/component.ts, and a page object composes it as a property. Specs reach it through the page they stand on, so there is no fixture per fragment.

Good:

```ts
// pages/home.ts
export class HomePage extends BasePage {
  readonly header = new Header(this.page, this.target);
  readonly footer = new Footer(this.page, this.target);
}

// components/footer.ts
export class Footer extends Component {
  shell(): Locator {
    return this.page.getByTestId('footer').first();
  }
}

// the spec
await expect(home.footer.shell()).toBeVisible();
```

Bad:

```ts
// a page class that skips BasePage
export class WishlistPage {
  constructor(private page: Page) {}
}

// a fragment posing as a page, with a fixture of its own
export class FooterPage extends BasePage {
  shell(): Locator {
    return this.page.getByTestId('footer').first();
  }
}
```
