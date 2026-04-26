# local-llm-proxy

A local HTTP proxy that intercepts Claude Code traffic and exposes a real-time web UI to inspect all requests and responses, token usage, and timing.

## Install

```bash
npm install
```

## Web UI

Open `http://localhost:8080` after starting the proxy.

- **Left panel** — request list with status, model, duration, token count
- **Right panel tabs:**
  - **Request** — full message payload sent to the LLM
  - **Response** — live streaming display, then full response on completion
  - **Tokens** — input / output / total token counts
  - **Raw** — full JSON, copy to clipboard
- **Toolbar** — search, filter by model/status, export JSON/CSV, clear history

---

## Use Case 1: Monitor Claude Code with a Local LLM

You have a local LLM running at `http://127.0.0.1:8001` (Ollama, LM Studio, llama.cpp, etc.).

```
Claude Code → proxy (:8080) → local LLM (:8001)
```

**Start the proxy:**

```bash
# Default: upstream is http://127.0.0.1:8001
npm start

# Or explicitly:
UPSTREAM_URL=http://127.0.0.1:8001 npm start
```

**Configure Claude Code to use the proxy:**

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
```

Add to your shell profile (`~/.zshrc` or `~/.bashrc`) to make it permanent:

```bash
echo 'export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"' >> ~/.zshrc
```

Then in Claude Code settings, select your local model as the provider.

---

## Use Case 2: Monitor Claude Code Against the Real Anthropic API

You want to inspect what Claude Code sends and receives when talking to the real Claude API — useful for debugging prompts, understanding token usage, or auditing requests.

```
Claude Code → proxy (:8080) → api.anthropic.com
```

**Start the proxy pointing at the Anthropic API:**

```bash
UPSTREAM_URL=https://api.anthropic.com npm start
```

**Tell Claude Code to route through the proxy:**

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
```

Your existing `ANTHROPIC_API_KEY` is passed through transparently — the proxy forwards all headers including authentication.

> **Note:** The proxy runs on HTTP locally but forwards to HTTPS upstream. Your API key is only in memory on your own machine and is never logged to disk unless you enable `PERSIST=true`.

---

## Configuration

All settings via environment variables (or a `.env` file — copy `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `8080` | Port for the proxy and web UI |
| `UPSTREAM_URL` | `http://127.0.0.1:8001` | Upstream LLM or API to forward to |
| `PERSIST` | `false` | Persist request history to SQLite across restarts |
| `DB_PATH` | `./proxy-history.db` | SQLite file path (when `PERSIST=true`) |
| `MAX_HISTORY` | `1000` | Max requests kept in memory |

**`.env` file example:**

```bash
PROXY_PORT=8080
UPSTREAM_URL=https://api.anthropic.com
PERSIST=true
DB_PATH=./history.db
```

---

## Scripts

```bash
npm start        # start proxy
npm run dev      # start with --watch (auto-restart on file changes)
npm test         # run test suite
```

---

## Switching Between Local LLM and Real API

```bash
# Local LLM
UPSTREAM_URL=http://127.0.0.1:8001 npm start

# Real Anthropic API
UPSTREAM_URL=https://api.anthropic.com npm start
```

In both cases, Claude Code is configured the same way:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
```
