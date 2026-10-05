# Host API v1

The current API uses `/api`; incompatible future changes will get a new prefix. Every API route requires `Authorization: Bearer <host-token>`. Tokens are never accepted in URLs or cookies. No CORS access is enabled. Static UI assets contain no credentials.

| Method | Route | Result |
|---|---|---|
| GET | `/api/host` | Version, configured/used capacity, Docker/image/disk health, credential-presence booleans |
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
