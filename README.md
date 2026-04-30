# Sygil

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

Sygil chains Claude, Codex, Cursor, and local models into deterministic, replayable coding workflows. You define a graph of agent sessions in `workflow.json` — nodes are agent sessions, edges carry typed gates that decide whether to advance, retry, or fail. Sygil drives the agents, evaluates the gates, and writes a complete NDJSON event log so any run can be replayed exactly: same scheduler decisions, same retry timing, same gate verdicts. Temporal does this for general workflows; Sygil does it agent-native.

Adapters are heterogeneous per node — mix Claude SDK on one node, Codex CLI on the next, and Qwen on Ollama on the third in the same DAG. Local-first by design: no callhome, no license server, no hosted service. The `local-oai` adapter works with any OpenAI-compatible server out of the box.

## Quick start

```bash
git clone https://github.com/akshatvasisht/sygil.git
cd sygil
npm install
npm run build
export ANTHROPIC_API_KEY=sk-ant-...
cd my-project
node /path/to/sygil/packages/cli/dist/index.js init
node /path/to/sygil/packages/cli/dist/index.js run tdd-feature "add OAuth2 login"
```

`sygil run` opens a real-time monitor in your browser. Pass `--no-monitor` for headless.

## Commands

`init` · `run` · `validate` · `resume` · `replay` · `list` · `export` · `import-template`

Full flag reference and `workflow.json` schema: [docs/API.md](docs/API.md).

## Adapters

- **Tier 1** — `claude-sdk`, `claude-cli`. Primary tested paths.
- **Tier 2** — `codex`, `cursor`, `gemini-cli`, `local-oai`, `echo`. Full unit + integration coverage; soak underway.

`local-oai` defaults to Ollama at `http://localhost:11434/v1` and works with any OpenAI-compatible server (Qwen 2.5 7B+, Llama 3.2 8B+, Mistral Nemo). Override the endpoint via `SYGIL_LOCAL_OAI_URL`.

`sygil init` checks which adapters are available in your environment.

## Documentation

* **[SETUP.md](docs/SETUP.md)** — install, environment variables, adapter credentials
* **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — workflow model, gates, scheduler, run state, WebSocket protocol
* **[API.md](docs/API.md)** — CLI reference, flags, `workflow.json` schema
* **[TESTING.md](docs/TESTING.md)** — test strategy and running tests
* **[STYLE.md](docs/STYLE.md)** — coding standards and conventions
* **[OBSERVABILITY.md](docs/OBSERVABILITY.md)** — Prometheus scrape + OTLP push

## License

See [LICENSE](LICENSE) for details.
