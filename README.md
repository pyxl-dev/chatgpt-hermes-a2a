# chatgpt-hermes-a2a

POC: ChatGPT Web → OpenAI Secure MCP Tunnel → MCP-to-A2A bridge → Hermes Agent A2A → local Mac.

This repository is intentionally thin: it does not fork Hermes Agent or OpenAI's tunnel client. It wires existing protocol surfaces together, provides repeatable diagnostics, and produces a report that can be pasted back into ChatGPT.

## Quick start

On the Mac where Hermes is installed:

```bash
git clone https://github.com/pyxl-dev/chatgpt-hermes-a2a.git
cd chatgpt-hermes-a2a
chmod +x scripts/run-all.sh
./scripts/run-all.sh
```

The script performs non-destructive checks, attempts to start the Hermes gateway if needed, verifies the local A2A Agent Card, installs the local Node dependencies, runs an MCP→A2A smoke test, inspects OpenAI `tunnel-client` availability/configuration, and writes a timestamped report under `reports/`.

It does **not** expose Hermes on the public internet and does not change `A2A_HOST` away from loopback.

See `docs/architecture.md` and `docs/security.md`.
