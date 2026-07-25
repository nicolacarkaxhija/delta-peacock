---
id: no-eval
severity: CRITICAL
languages: [javascript, typescript, python, php, ruby]
---

# No dynamic code execution on untrusted input

Do not pass user-controlled data to eval, Function, exec, or an equivalent
dynamic evaluator. Parse and validate instead. Dynamic execution turns a data
bug into remote code execution.
