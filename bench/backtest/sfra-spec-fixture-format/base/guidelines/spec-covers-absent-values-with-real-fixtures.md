---
id: spec-covers-absent-values-with-real-fixtures
severity: MINOR
languages: [javascript]
paths:
  - "test/unit/**/*.js"
  - "test/mocks/**/*.js"
tags: [judged]
---

# Specs cover absent values with production shaped fixtures

Specs cover the absent flag and absent values, use fixture data in the format production sends, and assert one property per case. Flag a new spec that asserts several properties in one case, or whose fixture contradicts the documented data format.

## Bad

```javascript
it('decorates', function () {
    expect(line.size).to.equal('39');
    expect(line.gender).to.equal('women');
    expect(line.isGiftPack).to.be.true;
});
```

## Good

```javascript
it('sets the size', function () { expect(decorate(pack('39;5.5')).size).to.equal('39'); });
it('leaves the size empty without the flag', function () { expect(decorate(plain()).size).to.be.undefined; });
```
