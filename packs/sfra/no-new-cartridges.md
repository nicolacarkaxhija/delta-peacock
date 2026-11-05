---
id: no-new-cartridges
severity: MAJOR
languages: []
paths: ["cartridges/**"]
check:
  type: semgrep
  files: ["cartridges/*/cartridge/*.properties"]
  message: "A change never adds a cartridge: new code goes into an existing custom cartridge."
---

# No new cartridges

A change never adds a cartridge: new code goes into an existing custom cartridge. Every cartridge lengthens the cartridge path, and a feature split across cartridges is harder to find and to override. A new cartridge shows as a new `<name>.properties` file that declares the cartridge id.

Good: the gift pack controller goes into `cartridges/app_shop_core/cartridge/controllers/GiftPack.js`.

Bad:

```properties
## cartridge.properties for cartridge app_shop_gifts
demandware.cartridges.app_shop_gifts.id=app_shop_gifts
```
