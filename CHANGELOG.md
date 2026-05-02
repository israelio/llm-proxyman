# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.1.10](https://github.com/israelio/llm-proxyman/compare/v0.1.8...v0.1.10) (2026-05-02)

### 0.1.8 (2026-05-02)


### Features

* add Anthropic and Local LLM preset buttons for upstream switching ([42f6478](https://github.com/israelio/llm-proxyman/commit/42f6478d34b10d60249963c800e282f39982d779))
* add Codex/OpenAI support — auto-route gpt-* to api.openai.com ([6e5f06c](https://github.com/israelio/llm-proxyman/commit/6e5f06c4ef56583709f2046ca592ef53c4795fa2))
* add collapsible JSON tree to request, response, and raw tabs ([bda71c5](https://github.com/israelio/llm-proxyman/commit/bda71c5f4526f05b5aee04881d7ace7f8279c6d8))
* add entry point ([07d4887](https://github.com/israelio/llm-proxyman/commit/07d48878024fcb325145c2bfb85bd7eeed0160ae))
* add history store ([becd415](https://github.com/israelio/llm-proxyman/commit/becd415ca5f675cd77772fd5aabaf16bfdb2de64))
* add JSON syntax highlighting with pretty/raw toggle ([b5262c8](https://github.com/israelio/llm-proxyman/commit/b5262c87ad1cb10a40955826ab398dc504ccf1dd))
* add optional SQLite persistence via node:sqlite ([982db6c](https://github.com/israelio/llm-proxyman/commit/982db6c53a9cc2389d86bae3eb6038bf7af27acb))
* add proxy middleware ([bddc907](https://github.com/israelio/llm-proxyman/commit/bddc907c8816b6632c55ce02bdb3dc4ee351f907))
* add REST API ([f79e098](https://github.com/israelio/llm-proxyman/commit/f79e09878f9a208c5af449184dc58b7927fd8880))
* add SSE broadcaster ([cb9d3f3](https://github.com/israelio/llm-proxyman/commit/cb9d3f36094f9a6e8643bc8dcb6020e176ef6efb))
* add web UI ([f1b5d36](https://github.com/israelio/llm-proxyman/commit/f1b5d36567dfd38c57c709846a648109de3c3636))
* auto mode routes Sonnet/Opus/Haiku to Anthropic, others to local LLM ([99ae1f8](https://github.com/israelio/llm-proxyman/commit/99ae1f8e29287952650bf1b77544b32f58e6e5d1))
* auto-scroll button + per-source token stats in status bar ([74e9906](https://github.com/israelio/llm-proxyman/commit/74e990650c6af5281f3cbcf0c010c2843071323e))
* env UPSTREAM_URL overrides config file, add Docker support ([7978f87](https://github.com/israelio/llm-proxyman/commit/7978f8759ec468ecd010c6d0e1ddcc3e6158309b))
* header with version, key-click collapse toggle, human-readable duration ([cba00d2](https://github.com/israelio/llm-proxyman/commit/cba00d271d26011bd7c786a196e0636dd594630e))
* MITM CONNECT support + gzip decompression for Codex/chatgpt.com traffic ([ef4f109](https://github.com/israelio/llm-proxyman/commit/ef4f1093b5c82c83e62751c610ffbfee9996581e))
* persistence on by default; survive restarts with full history and config ([8834109](https://github.com/israelio/llm-proxyman/commit/88341090de23bddee70838f433aa22e11402c037))
* runtime upstream switcher, fix Anthropic token parsing, collapse JSON by default ([358fa58](https://github.com/israelio/llm-proxyman/commit/358fa58bf894c23e9c43e6b53b35c0eda5c6fa5d))
* smarter JSON tree — SSE parsing, embedded JSON, name hints ([d74afdf](https://github.com/israelio/llm-proxyman/commit/d74afdf7d2b48c6d0fe06264d93a4e82404aed35))
* WebSocket interception, UI text summaries, silent MITM routing ([94d7461](https://github.com/israelio/llm-proxyman/commit/94d74613a8451b45c12296a32550268a732aab16))


### Bug Fixes

* cleanup on client disconnect, propagate socket closes in MITM ([757e43e](https://github.com/israelio/llm-proxyman/commit/757e43e6251db95c91ccbebad3eb174a359fa5ab))
* close stale EventSource before reconnecting to prevent duplicate events ([996004c](https://github.com/israelio/llm-proxyman/commit/996004cfaebfddf5fdf88b48968416e57a7743bb))
* detect OpenAI stats for chatgpt.com MITM traffic ([420cc4b](https://github.com/israelio/llm-proxyman/commit/420cc4b16391fc048844cd9008ce773e029fe88c))
* disable gzip compression and improve upstream config error handling ([91a9895](https://github.com/israelio/llm-proxyman/commit/91a9895e1bccc8687cbc2663c75955b72bacb6e8))
* drop empty GET noise, null instead of empty string for no-body requests ([b9fa544](https://github.com/israelio/llm-proxyman/commit/b9fa54419ee29d32b36e91459e91b5f993b25ab9))
* port-map for MITM routing (fixes keep-alive), add WebSocket upgrade tunneling ([138e446](https://github.com/israelio/llm-proxyman/commit/138e446f03897dcfa2acf3865cd1d459f6668c3d))
* preserve local LLM URL when switching modes; anthropic mode never overwrites upstreamUrl ([1935baf](https://github.com/israelio/llm-proxyman/commit/1935baf8238a900f13a5b0d0de93df4bcb97d52d))
* regenerate package-lock.json with correct name and version ([c174c16](https://github.com/israelio/llm-proxyman/commit/c174c16645f76f2e2a7c339988e00d1eabf175f7))
* rename project in README to local-llm-proxy ([52f1109](https://github.com/israelio/llm-proxyman/commit/52f11099fab879e3ec119c729b50dee81bc130a1))
* use app.use() catch-all instead of app.all('*') for MITM routes ([514718f](https://github.com/israelio/llm-proxyman/commit/514718f490256f3eb30c4db6308113da017f071c))
