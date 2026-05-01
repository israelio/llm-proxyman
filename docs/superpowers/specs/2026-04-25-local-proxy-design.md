# Local Proxy — Design Spec
Date: 2026-04-25

## Overview

A local HTTP proxy that intercepts Claude Code requests (OpenAI-compatible API format), forwards them to a configurable upstream LLM, and exposes a web interface to inspect all traffic in real time.

## Goals

- Transparent proxy: Claude Code points at proxy instead of LLM directly, behavior unchanged
- Real-time web UI: see requests and streaming responses as they happen
- Developer tooling: search, filter, export, token stats, clear history
- Optional persistence: in-memory by default, SQLite when PERSIST=true

## Architecture

Single Node.js process, single port (default 8080). Routes split by responsibility:

- `/v1/*` — proxy: forward to upstream LLM, capture traffic
- `/` — web UI: single HTML page (vanilla JS)
- `/api/*` — REST API: list, search, filter, export, clear
- `/events` — SSE stream: push live updates to web UI

### Data Flow

```
Claude Code
  → POST /v1/chat/completions (proxy:8080)
    → capture request body
    → forward to upstream LLM (:8001)
    → stream response chunks back to Claude Code
    → accumulate full response + extract token usage
    → broadcast record to SSE subscribers
    → store in memory (+ write to SQLite if PERSIST=true)
```

## Components

### 1. Proxy Middleware (`src/proxy.js`)

- Handles all `/v1/*` routes via `http-proxy-middleware` or manual `http`/`https` forwarding
- Detects streaming (`stream: true`) vs non-streaming requests
- For streaming: pipes SSE chunks to Claude Code, accumulates chunks for storage
- For non-streaming: buffers full response, stores it
- Extracts `usage` field (input_tokens, output_tokens) from response; falls back to character-based estimate if absent
- On completion: saves record to store, broadcasts via SSE

### 2. History Store (`src/store.js`)

- In-memory array of request records (capped at 1000 entries by default)
- Each record:
  ```json
  {
    "id": "uuid",
    "timestamp": "ISO8601",
    "method": "POST",
    "path": "/v1/chat/completions",
    "model": "string",
    "status": "pending|streaming|complete|error",
    "durationMs": 1234,
    "request": { /* full request body */ },
    "response": { /* full response body */ },
    "chunks": ["..."],
    "usage": {
      "inputTokens": 100,
      "outputTokens": 200,
      "totalTokens": 300
    },
    "error": null
  }
  ```
- Methods: `add`, `update`, `getAll`, `getById`, `search`, `clear`
- If `PERSIST=true`: writes to SQLite via `better-sqlite3` on each `update(complete)`; loads history on startup

### 3. SSE Endpoint (`/events`)

- Browser clients subscribe with `EventSource('/events')`
- Events emitted: `request:start`, `request:chunk`, `request:complete`, `request:error`
- Each event carries the full record (or partial for chunks)
- Multiple simultaneous browser tabs supported

### 4. REST API (`src/api.js`)

| Route | Method | Purpose |
|---|---|---|
| `/api/requests` | GET | List all (supports `?search=`, `?model=`, `?status=`, `?from=`, `?to=`) |
| `/api/requests/:id` | GET | Single record |
| `/api/requests` | DELETE | Clear all history |
| `/api/export` | GET | Download as JSON or CSV (`?format=json\|csv`) |
| `/api/stats` | GET | Aggregate token totals, request counts |

### 5. Web UI (`public/index.html`)

Single HTML file with embedded CSS and JS (no build step).

**Layout:**
- Top toolbar: search input, model filter dropdown, status filter, date range, export button, clear button
- Left panel: request list — each row shows timestamp, model, status badge, duration, total tokens; live highlight for in-progress
- Right panel: tabbed detail view
  - **Request**: formatted JSON of messages + params
  - **Response**: live streaming display (chunks append as they arrive) → formatted full response on complete
  - **Tokens**: input / output / total token counts, running session totals
  - **Raw**: full request + response JSON, copy-to-clipboard button
- Bottom status bar: total requests, total tokens (input + output), session duration

**Real-time behavior:**
- SSE connection auto-reconnects on disconnect
- New request appears in list immediately as "pending"
- Status badge updates: pending → streaming → complete/error
- Response tab streams live while request is in-flight

## Configuration

All via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `8080` | Port for proxy + web UI |
| `UPSTREAM_URL` | `http://127.0.0.1:8001` | Upstream LLM base URL |
| `PERSIST` | `false` | Enable SQLite persistence |
| `DB_PATH` | `./proxy-history.db` | SQLite file path |
| `MAX_HISTORY` | `1000` | Max in-memory records |

## File Structure

```
local-proxy/
  src/
    index.js       # entry point, Express app, wires everything
    proxy.js       # proxy middleware
    store.js       # history store (memory + optional SQLite)
    api.js         # REST API routes
    sse.js         # SSE broadcaster
  public/
    index.html     # web UI (single file, no build)
  package.json
  .env.example
  README.md
```

## Dependencies

- `express` — HTTP server
- `http-proxy-middleware` or manual proxy via `node:http` — upstream forwarding
- `better-sqlite3` — optional persistence (loaded only if PERSIST=true)
- `uuid` — record IDs

No frontend build tooling. No TypeScript. No framework beyond Express.

## Token Counting

1. Primary: extract `usage.prompt_tokens` / `usage.completion_tokens` (OpenAI format) or `usage.input_tokens` / `usage.output_tokens` (Anthropic format) from response body
2. Fallback: rough estimate — characters / 4 for both request and response

## Error Handling

- Upstream unreachable: return 502 to Claude Code, record error in store, emit `request:error` SSE event
- Malformed upstream response: log + store raw, mark status=error
- SSE client disconnect: remove from subscriber list silently

## Non-Goals

- Authentication / auth tokens
- Request modification / mocking
- Multi-user / multi-tenant
- HTTPS termination
