---
id: parameterized-queries
severity: BLOCKER
---

# Parameterize every query

Database and shell commands must be built with parameters or a query builder,
never by concatenating user input into a string. String concatenation is how
injection happens.
