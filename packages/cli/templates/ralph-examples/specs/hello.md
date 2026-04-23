# Spec — greet()

## Signature

```python
def greet(name: str) -> str: ...
```

## Behavior

- `greet("world")` returns `"Hello, world!"`
- `greet("")` returns `"Hello, !"` (no guard on empty — the greeting is still
  valid, just sparse; tests should pin this so a later refactor doesn't silently
  add a guard).
- `greet("日本語")` returns `"Hello, 日本語!"` (unicode passes through unchanged;
  no normalization, no encoding).

## Non-behavior

- `greet` does not print. It returns a string.
- `greet` does not accept non-string input. Passing anything else is undefined —
  tests do not need to cover it.

## Test cases (minimum)

1. plain name → exact expected string
2. empty name → exact expected string
3. unicode name → exact expected string
