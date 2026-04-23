# Fix plan — hello demo

Priority order. Do the first unchecked TODO. Check off with `- [x]` when done.
Split big items in place. Mark blocked items `- [!]` with a reason.

- [ ] Create `hello.py` that exposes a function `greet(name: str) -> str`
      returning `"Hello, {name}!"` (see `specs/hello.md` for exact shape).
- [ ] Add a pytest file `test_hello.py` covering the three cases from
      `specs/hello.md`: plain name, empty string, and unicode name.
- [ ] Run `pytest -q` and confirm all tests pass. If pytest isn't installed,
      use Python's built-in `unittest` instead and adjust the test file.
- [ ] Add a `README.md` documenting how to run the tests and one usage
      example.
