# sama-orchestration — RCA Platform

MCP-based Root Cause Analysis platform. Biến 1 ticket sự cố (Mattermost) thành 1 **Fix Plan** có căn cứ rồi (sau khi người duyệt) giao **Claude Code** thực thi trong branch → PR.

```
Mattermost ticket
      │
      ▼
 [Stage 1] Triage          Haiku 4.5 — classify severity/service/domain
      │
      ▼
 [Stage 2] Investigate     Opus 4.8 — agentic loop với MCP tools (read-only)
      │                    deploy_recent → sentry_issues → logs_search → ...
      ▼
 [Stage 3] Root Cause      Opus 4.8 — synthesize + adversarial verify
      │
      ▼
 [Stage 4] Fix Plan        Opus 4.8 — markdown artifact (Goal/Tasks/Verify/Rollback)
      │
      ▼
 Mattermost reply          Fix Plan + nút duyệt
      │
      │  👍 /rca/approve/:caseId
      ▼
 [Executor]                Claude Code headless trong git worktree → branch → PR
```

---

## Architecture

```
sama-orchestration/          ORCHESTRATOR — brain + control plane
├── src/
│   ├── config/              env.js · anthropic.js · mongo.js
│   ├── ingest/              Mattermost adapter (parse → Incident)
│   ├── orchestrator/        pipeline.js · investigate.js · rootcause.js · fixplan.js
│   ├── mcp-client/          MCP client → mcp-diagnostic
│   ├── executor/            Claude Code runner (WRITE plane, approval-gated)
│   ├── memory/              recurrence detection (MongoDB)
│   ├── security/            redact.js · audit.js
│   └── cli/diagnose.js      smoke-test CLI
│
mcp-diagnostic/              READ-ONLY MCP SERVER — generic source drivers
├── inventory.yaml           ⭐ topology mida = DATA (không phải code)
└── src/
    ├── registry/            inventory.js · resolver.js
    ├── sources/             sentry · docker-logs · jenkins · git drivers
    └── handler/verb.handler.js   4 MCP tools
```

**Hai app, hai process, hai credential:**

| | `sama-orchestration` | `mcp-diagnostic` |
|---|---|---|
| Port | `7400` | `7401` |
| Plane | READ + WRITE control | READ-ONLY tuyệt đối |
| Credentials | Anthropic key, ops Mongo | Sentry token, Docker, Jenkins |
| Viết prod? | Không (chỉ qua Claude Code trong branch) | Không bao giờ |

---

## Setup

### 1. Prerequisites

- Node.js ≥ 20
- npm hoặc pnpm
- `mcp-diagnostic` chạy trên Swarm manager node (để `docker service logs` hoạt động)

### 2. Install

```bash
# Orchestrator
cd sama-orchestration
npm install

# Diagnostic MCP server
cd mcp-diagnostic
npm install
```

### 3. Environment

**Orchestrator** — copy `.env.example` → `.env`:

```env
PORT=7400
ANTHROPIC_API_KEY=sk-ant-...

MCP_DIAGNOSTIC_URL=http://localhost:7401/mcp
MCP_OPS_TOKEN=<shared-secret>

OPS_MONGO_URI=mongodb://localhost:27017/rca-ops

# Mattermost
MATTERMOST_WEBHOOK_SECRET=<webhook-secret>
MATTERMOST_URL=https://<mattermost-host>
MATTERMOST_BOT_TOKEN=<bot-token>

# Executor (Phase 4)
EXECUTOR_REPOS_ROOT=/srv/repos
EXECUTOR_ALLOWED_REPOS=sama-api
EXECUTOR_TARGET_BRANCH=develop
BITBUCKET_API_URL=https://<bitbucket-host>
BITBUCKET_ACCESS_TOKEN=<token>
BITBUCKET_PROJECT=<project-key>
```

**mcp-diagnostic** — copy `mcp-diagnostic/.env.example` → `mcp-diagnostic/.env`:

```env
PORT=7401
MCP_OPS_TOKEN=<same-shared-secret>

SENTRY_API_TOKEN=<read-only token — scope: project:read event:read>
SENTRY_ORG=<org-slug>

DOCKER_BIN=docker
JENKINS_URL=https://<jenkins-host>
JENKINS_USER=<user>
JENKINS_TOKEN=<read-only api token>
REPOS_ROOT=/srv/repos
```

### 4. Điền inventory.yaml

File `mcp-diagnostic/inventory.yaml` mô tả topology thật của hệ thống — điền Sentry project slug, Docker Swarm service names, Jenkins job names, shard routing cho mida:

```yaml
services:
  - name: api
    instances:
      - id: api-1
        shard: 1
        sources:
          errors: sentry-api   # điền Sentry project slug thật
          logs: docker-api-1   # điền Docker Swarm service name thật
          deploy: jenkins-api  # điền Jenkins job name thật
```

Thêm service mới = thêm entry vào yaml, **không sửa code driver**.

### 5. Run

```bash
# Terminal 1 — diagnostic MCP server (nên chạy trên Swarm manager)
cd mcp-diagnostic && npm run dev

# Terminal 2 — orchestrator
cd sama-orchestration && npm run dev
```

---

## Usage

### Smoke-test MCP tools (không cần LLM)

```bash
# List available tools
npm run diagnose tool

# Xem Sentry issues của service api
npm run diagnose tool sentry_issues '{"service":"api","statsPeriod":"24h"}'

# Xem logs lỗi
npm run diagnose tool logs_search '{"service":"api","level":"error","since":"1h"}'

# Xem deployment gần đây
npm run diagnose tool deploy_recent '{"service":"api"}'
```

### Chạy full RCA pipeline từ file

```bash
npm run diagnose incident docs/sample-incident.json
```

Fix Plan được ghi ra `docs/fix-plans/<caseId>.md`.

### Trigger manual qua API

```bash
curl -X POST http://localhost:7400/rca/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Checkout 500 errors after deploy",
    "description": "sama-api trả 500 từ 14:00, sau khi deploy lúc 13:45",
    "affectedService": "sama-api",
    "severity": "high",
    "domain": "test.myshopify.com"
  }'
```

### Approve Fix Plan → thực thi Claude Code

```bash
# Approve (sau khi nhận Fix Plan từ Mattermost)
curl -X POST http://localhost:7400/rca/approve/<caseId>

# Reject
curl -X POST http://localhost:7400/rca/reject/<caseId>
```

### Mattermost webhook

Trỏ Mattermost outgoing webhook về `POST http://<host>:7400/webhook/mattermost`.

---

## MCP Tools (Phase 1)

| Tool | Mô tả | Dùng khi nào |
|---|---|---|
| `sentry_issues` | List Sentry issues theo service, sort by freq | Bắt đầu mọi incident dạng exception |
| `sentry_issue_detail` | Stacktrace + breadcrumbs + tags của 1 issue | Drill into issue tìm thấy ở trên |
| `logs_search` | Tìm structured logs Docker Swarm, lọc level/domain/grep | Confirm hypothesis từ Sentry, tìm lỗi không có exception |
| `deploy_recent` | Jenkins builds + git commits gần đây | Luôn gọi sớm — "cái gì vừa đổi?" |

Tools sau thêm ở **Phase 5**: `events_query`, `db_query`, `metrics_query`, `queue_status`, `cache_status`, `infra_health`.

---

## Source Drivers

Mỗi driver implement interface `{ type, capabilities[], query(verb, params, sourceCfg) }` và normalize kết quả về **`CanonicalEvent`**. LLM không biết Mongo hay ClickHouse, shard nào — chỉ thấy canonical envelope.

| Driver | Type | Capabilities |
|---|---|---|
| `sentry.source.js` | `sentry` | `errors` |
| `docker-logs.source.js` | `docker-logs` | `logs` |
| `jenkins.source.js` | `jenkins` | `deploy` |
| `git.source.js` | `git` | `deploy` |
| *(Phase 5)* `mongo.source.js` | `mongo` | `events`, `db` |
| *(Phase 5)* `clickhouse.source.js` | `clickhouse` | `events`, `metrics` |
| *(Phase 5)* `rabbitmq.source.js` | `rabbitmq` | `queue` |
| *(Phase 5)* `redis.source.js` | `redis` | `cache` |

---

## Models

| Model | Dùng cho | Pricing (2026) |
|---|---|---|
| `claude-opus-4-8` | Investigate loop, root cause, fix plan | $5/$25 per MTok |
| `claude-sonnet-4-6` | Log summarize (dự phòng) | $3/$15 |
| `claude-haiku-4-5` | Triage / classify ticket | $1/$5 |

Estimate **$0.5–$2 / incident** với prompt caching bật (cache system prompt + tool defs).

---

## Security

| | Biện pháp |
|---|---|
| Read/write separation | `mcp-diagnostic` là process riêng, DB user read-only, không có write tool |
| Approval gate | Claude Code chỉ chạy sau `POST /rca/approve/:caseId` — không auto-execute |
| Least privilege | Sentry/Jenkins/Mongo credential đều read-only |
| Injection | `execFile` (không shell) — service/repo từ `inventory.yaml`, không từ LLM args |
| Redaction | `security/redact.js` scrub secrets/PII trước khi vào model |
| Audit | Mọi tool call + write action log qua `security/audit.js` |
| Auth | MCP server sau ops bearer token; webhook Mattermost verify HMAC secret |

---

## Roadmap

| Phase | Status | Mô tả |
|---|---|---|
| 0 — Walking skeleton | ✅ | `pnpm dev` cả 2 app, health 200 |
| 1 — READ plane | ✅ | Sentry/logs/deploy drivers + generic verbs + inventory registry |
| 2 — Brain | ✅ | Agentic loop + root cause + adversarial verify + fix plan |
| 3 — Mattermost | ✅ | Ticket → Fix Plan → reply channel + recurrence detection |
| 4 — WRITE plane | ✅ | Approval gate → Claude Code → branch → PR |
| 5 — Hardening | ⬜ | Mongo/ClickHouse/RabbitMQ/Redis drivers, `events_query` heterogeneous (Mongo shard-1 vs ClickHouse shard-2), tenant→shard routing, traceId correlation, eval suite |

Chi tiết từng phase: [plan.md](plan.md).
