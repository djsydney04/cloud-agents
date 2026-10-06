# Host API v1

The current API uses `/api`; incompatible future changes will get a new prefix. Every API route requires `Authorization: Bearer <host-token>`. Tokens are never accepted in URLs or cookies. No CORS access is enabled. Static UI assets contain no credentials.

| Method | Route | Result |
|---|---|---|
| GET | `/api/host` | Version, configured/used capacity, Docker/image/disk health, credential-presence booleans |
| GET | `/api/settings` | Persisted resource policy and revision |
| PUT | `/api/settings` | Validate and save full policy atomically; no host restart |
| GET | `/api/jobs` | Newest-first job history |
| POST | `/api/jobs` | Validated request; 201 and queued job |
| GET | `/api/jobs/{uuid}` | Job state |
| POST | `/api/jobs/{uuid}/cancel` | Idempotent cancellation |
| GET | `/api/jobs/{uuid}/logs` | `{ "output": "..." }`, latest 500 lines |
| GET | `/api/jobs/{uuid}/archive` | Terminal workspace as streaming gzip tar |
| DELETE | `/api/jobs/{uuid}` | 204 after removing a terminal job's container, files and record |

Create body:

```json
{
  "provider": "codex",
  "prompt": "Add a small test for the parser and run it.",
  "repository": "https://github.com/owner/repo",
  "cpus": 1,
  "memory_mb": 2048,
  "timeout_secs": 1800
}
```

Providers: `codex`, `claude`, `smoke`. Repository defaults to empty (new local repo). Resources default to the values above. Prompt limit: 32,000 bytes. Memory minimum: 256 MB. Timeout: 10–86,400 seconds. Resource requests cannot exceed host budgets. Request bodies are limited to 64 KiB; unknown fields are rejected. History is capped at 1,000 retained runs; delete old runs before adding more.

Job fields add `id`, `status`, `created_at`, nullable `started_at`, nullable `finished_at`, nullable `exit_code`, nullable `error`. Times are Unix seconds. Statuses: `queued`, `starting`, `running`, `cancelling`, `cancelled`, `succeeded`, `failed`.

Errors normally return `{ "error": "human-readable reason" }`: 400 validation, 401 missing/incorrect token, 404 unknown run, 409 credential/state/history conflict, 500 host operation failure. Framework-level malformed JSON/body-limit errors may use plain text. Clients poll every 2.5–3 seconds; this preview does not offer WebSockets or interactive stdin.

## Live settings

```json
{"cpus":4,"memory_mb":8192,"max_jobs":2,"min_free_gb":5,"paused":false,"revision":0}
```

Read the current revision before updating. A successful PUT increments it and persists the policy. A stale revision, unavailable Docker daemon, active reservation exceeding the proposed budget, or queued run that would no longer fit returns 409. Limits above observed Docker capacity return 400. Changing settings requires the same owner token as run creation. `/api/host` also returns `paused` and `health.docker_cpus` / `health.docker_memory_mb`.

## Account configuration

`PUT /api/credentials` accepts `{"kind":"openai-key","value":"..."}` over the authenticated private connection. Supported kinds are `openai-key`, `anthropic-key`, `claude-token`, `github-token`, and `codex-json`. A null value removes that credential. Returns 204; validation errors return 400. The normal 64 KiB API body limit applies. There is no credential-read endpoint. CLI and API share validation and owner-only atomic storage; running jobs retain their existing snapshot until completion.
