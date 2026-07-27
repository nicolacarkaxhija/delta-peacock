---
id: SFRA-NO-TOP-REQUIRE
name: Defer Service-Module require() in Controllers and Models
severity: MAJOR
language:
  - javascript
paths:
  - "cartridges/app_*/cartridge/controllers/**/*.js"
  - "cartridges/int_custom_*/cartridge/controllers/**/*.js"
  - "cartridges/app_*/cartridge/models/**/*.js"
  - "cartridges/int_custom_*/cartridge/models/**/*.js"
category: Performance
tags: [sfra, sfcc, performance, require]
---

In a controller or model, a service module loaded with a top-level `require()` is initialized on every request, even for routes that never use it. Move that require inside the route or function that needs it.

Flag only a top-level require of a **service** module — a path containing `/services/`, or a variable name ending in `Service`. Leave the normal top-level require block alone: `require('server')`, middleware, `dw/*` modules, helpers, models, and `module.superModule` all belong at the top, and a require already deferred inside a route is the goal, not a violation.

## Bad

```javascript
var pricingService = require("*/cartridge/scripts/services/pricingService"); // top-level service

server.get("Quote", function (req, res, next) {
  res.json({ quote: pricingService.calculate(req.querystring.pid) });
  next();
});
```

## Good

```javascript
server.get("Quote", function (req, res, next) {
  var pricingService = require("*/cartridge/scripts/services/pricingService"); // deferred
  res.json({ quote: pricingService.calculate(req.querystring.pid) });
  next();
});
```
