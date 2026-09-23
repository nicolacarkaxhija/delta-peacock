---
id: SFRA-LOGGING-CATEGORIES
name: Always Use a Named Log Category
severity: MAJOR
language:
  - javascript
paths:
  - "cartridges/app_*/cartridge/controllers/**/*.js"
  - "cartridges/int_*/cartridge/controllers/**/*.js"
  - "cartridges/app_*/cartridge/scripts/**/*.js"
  - "cartridges/int_*/cartridge/scripts/**/*.js"
  - "cartridges/app_*/cartridge/models/**/*.js"
  - "cartridges/int_*/cartridge/models/**/*.js"
  - "cartridges/app_*/cartridge/experience/**/*.js"
  - "cartridges/int_*/cartridge/experience/**/*.js"
category: Observability
tags: [sfcc, logging, log-category]
---

Give every logger a named category so logs can be filtered and routed. Logging to the root logger makes that impossible.

Flag only a call that writes to the root logger: `Logger.getLogger()` or `getLogger('')` with no category, `Logger.getRootLogger()`, or a level method called straight on the `dw/system/Logger` module (`Logger.error(...)` where `Logger` is the module itself). Any `getLogger('name')` with a non-empty category is compliant — don't judge the category's wording, where the logger is created, or code that doesn't log at all.

## Bad

```javascript
var Logger = require("dw/system/Logger");
Logger.error("Order not found: " + orderNo); // root logger, no category
```

## Good

```javascript
var logger = require("dw/system/Logger").getLogger("order", "order.export");
logger.error("Order {0} not found", orderNo);
```
