# Testing Guidelines

## Strategy
This project uses [Framework Name] for automated testing. We prioritize [Unit/Integration/E2E] tests for [Critical Component].

## Running Tests

### Automated Suite
Run the full suite:
```bash
[command, e.g., pytest or npm test]
```
Run with coverage:
Bash

[command for coverage]

### Manual Verification
For hardware or visual components that cannot be easily mocked:

[Scenario A]: [Steps to reproduce]

[Scenario B]: [Steps to reproduce]

## Mocking Standards
External APIs should be mocked using [Library].

Database connections should use [Strategy, e.g., in-memory SQLite].
