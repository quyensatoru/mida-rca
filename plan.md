# MCP-based Root Cause Analysis Platform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — dùng `superpowers:executing-plans` (hoặc subagent-driven-development) để thực thi plan này task-by-task. Steps dùng checkbox (`- [ ]`) để tracking.
>
> **Repo:** `sama-orchestration` (hiện trống). **Ngôn ngữ:** Node.js ≥ 20, ES Modules — đồng nhất với `sama-mcp` / `sama-api`.

**Goal:** Biến 1 ticket sự cố (Mattermost) thành 1 **Fix Plan** có căn cứ — qua một pipeline RCA tự động dùng MCP tools đọc Sentry / logs / metrics / DB, rồi (sau khi người duyệt) giao cho **Claude Code** thực thi trong branch → PR. Mục tiêu: giảm mạnh thời gian fix bug thủ công, biến AI agent thành 1 SRE có khả năng observability + RCA + memory.

**3 nguyên tắc cốt lõi (hướng đi chuẩn):**

1. **Tách READ (chẩn đoán) khỏi WRITE (sửa), có approval gate ở giữa.**
   - Plane chẩn đoán = **read-only tuyệt đối** (DB user read-only, không write tool, process riêng, credential riêng). Không thể đụng prod.
   - Plane sửa = **Claude Code** chạy trong git worktree/branch → PR; không commit thẳng main, không chạy nếu Fix Plan chưa duyệt.
   - Đây là property an toàn quan trọng nhất.

2. **Diagnostic Sources tổng quát — KHÔNG hardcode mida vào code** *(theo phản hồi của bạn — idea 1)*. Lớp chẩn đoán là tập **source driver theo *loại* nguồn** (sentry, docker-logs, loki, mongo, clickhouse, rabbitmq, prometheus, jenkins, git…) + 1 **topology registry** (data). mida chỉ là *một file inventory*, không phải giả định nằm trong code. → tái dùng được cho hệ khác, và "take" được kiến trúc phân mảnh (xem 2 section mới bên dưới).

3. **PULL, không PUSH** *(idea 3)*. KHÔNG dựng pipeline ship log về RCA. Query nguồn có sẵn lúc chẩn đoán + **normalize-on-read** về 1 canonical envelope + correlation bằng traceId. Sentry vẫn là backbone lỗi; RCA *đọc từ* nó, không thay thế (xem section "Ingestion strategy").

---

## Bối cảnh hệ thống (đã khảo sát repo)

`mida` là kiến trúc **microservices** nối qua RabbitMQ, chung MongoDB/ClickHouse/Redis:

| Service | Vai trò | Stack |
|---|---|---|
| `sama-api` | Backend chính (session recording/replay) | Koa, Mongoose 6, ClickHouse, RabbitMQ, Redis, **Sentry** |
| `sama-recorder` / `sama-hm` / `sama-search` | Recorder / heatmap / search | Node |
| `sama-cms` | Shopify embedded admin | React/Vite |
| `sama-mcp` | **MCP analytics đã có** (reference pattern) | Express v5 + `@modelcontextprotocol/sdk` 1.28 + StreamableHTTP |
| `sama-orchestration` | **Đích — RCA platform** | (plan này) |

**Observability surface có sẵn để làm nguồn tín hiệu RCA:**

| Nguồn | Truy cập | Giá trị RCA |
|---|---|---|
| **Sentry** (`@sentry/node`, traces 0.25) | Sentry REST API | ⭐ Nguồn lỗi/exception số 1 — stacktrace, breadcrumbs, tần suất, **gắn với release** |
| **Logs JSON** (`sama-api/logger`) ra stdout | Docker Swarm `docker service logs` | Log structured `{filename, caller, level, domain, message, time}`, lọc theo `domain` (shop) + `level` |
| **MongoDB** (Mongoose 6) | Mongo read-only user | DB state, slow ops, collection stats, replication lag |
| **ClickHouse** | SQL read-only | Time-series/event metrics (rate, error, latency) |
| **RabbitMQ** (6 queues) | Management API | Queue depth, DLQ, consumer count — backup queue = sự cố kinh điển |
| **Redis** | `INFO` / `SLOWLOG` | Memory, hit/miss, evictions |
| **Jenkins** + git (Bitbucket) | Jenkins API / git | "Cái gì vừa đổi?" — correlate sự cố ↔ deploy gần nhất |
| **Docker Swarm** | `docker service ps/ls`, `docker stats` | Replica health, restart count, resource |

Deployment = **Docker Swarm** (không phải k8s) → collect logs/health qua `docker service ...`, không phải `kubectl`.

**Topology phân mảnh (đa shard, storage dị thể) — đây là phần khó, plan này giải bằng registry:**

```
            ┌── shard 1 ──▶ api-1 ──▶ events: MongoDB          ┌── recorder-1   ┌── heatmap-1 (Mongo HmV1)
proxy/LB ──▶│                                                  │                │
(domain →   └── shard 2 ──▶ api-2 ──▶ events: ClickHouse  ─────┴── recorder-2   └── heatmap-2 (Mongo HmV2)
 proxy idx)        ▲ cùng "events" nhưng storage KHÁC NHAU
```

mida **đã mã hoá topology thành data**: `ProxyModel` (DB Proxy, collection `shops`) map `domain → proxy` (số shard); rồi `SessionModels[proxyIndex]` / `PageViewHmModels[proxyIndex]` chọn đúng connection (`ApiV1/ApiV2`, `HeatmapV1/HeatmapV2`). Một số shard lưu event vào **Mongo**, số khác vào **ClickHouse** (`USE_CLICKHOUSE` trong sama-api). → RCA **không tự nghĩ ra routing** mà **tái dùng đúng `ProxyModel`** làm tenant→shard resolver (xem section "Diagnostic Sources + Topology Registry").

**Decisions đã chốt (qua hỏi đáp):**
1. **Runtime:** Node.js thuần (ESM). Reasoning qua **Anthropic SDK** (`@anthropic-ai/sdk`). Execute qua **Claude Code CLI headless**.
2. **Autonomy:** **HITL** — auto-diagnose + sinh Fix Plan, người duyệt **trước khi** Claude Code execute (branch/worktree → PR).
3. **Ticket source:** **Mattermost** trước (CRM/Slack cắm sau qua adapter interface).

---

## Architecture

```
                                          ┌──────────────────────────────────────┐
  Mattermost                              │        sama-orchestration (brain)      │
  (#incidents) ──webhook──▶  ingest/ ───▶ │                                        │
                            (adapter →    │  PIPELINE (deterministic outer loop)   │
                             Incident)    │  ┌──────────────────────────────────┐  │
                                          │  │ 1. Triage   (Haiku 4.5)          │  │
                                          │  │    + Memory recall (recurrence?) │  │
                                          │  │ 2. Investigate  ◀── AGENTIC LOOP │  │
                                          │  │    (Opus 4.8 + read-only MCP)    │  │
                                          │  │    hypothesis ledger, budget cap │  │
                                          │  │ 3. Root Cause + adversarial check│  │
                                          │  │ 4. Generate Fix Plan (markdown)  │  │
                                          │  └───────────────┬──────────────────┘  │
                                          │     MCP Client   │   post Fix Plan      │
                                          └──────────────────┼──────────┬──────────┘
                                                             │          │
                          ┌──────────────────────────────────▼───┐      ▼
                          │  mcp-diagnostic (READ-ONLY MCP server)│   Mattermost
                          │  Express v5 + MCP StreamableHTTP      │   (Fix Plan +
                          │  ops-token auth · per-request server  │    👍 Approve / 👎 Reject)
                          │                                       │          │
                          │  GENERIC VERBS (resolve qua registry):│          │ approve
                          │  errors_* logs_* events_* metrics_*   │          ▼
                          │  queue_* cache_* deploy_* infra_*     │
                          │            │ inventory.yaml (topology) │   ┌───────────────────────┐
                          └───┬────┬───┴┬────┬────┬────┬────┬──────┘   │  executor/            │
                              │    │    │    │    │    │    │          │  Claude Code headless │
                          ┌───▼┐ ┌─▼─┐ ┌▼──┐┌▼──┐┌▼──┐┌▼──┐┌▼────┐    │  in git worktree      │
                          │Sntr│ │Dkr│ │Mng││CH ││Rbt││Rds││Jnkn │    │  → branch → PR        │
                          └────┘ └───┘ └───┘└───┘└───┘└───┘└─────┘    └───────────────────────┘
                            SOURCE DRIVERS (theo loại nguồn, đều READ-ONLY)      ▲ WRITE (gated)
                            → normalize-on-read về canonical envelope
                                                                          ▲ WRITE plane (gated)
        ── READ plane (an toàn, không đụng prod) ──┤ approval gate ├── WRITE plane ──
```

**Tại sao đây là hướng đi chuẩn:**
- **MCP là biên tool**: các diagnostic tool read-only tái sử dụng được — vừa cho orchestrator tự động, vừa cho người dùng (trỏ Claude Desktop/Code vào cùng MCP server để điều tra thủ công). Đúng tinh thần MCP.
- **Read/write separation + approval gate**: plane chẩn đoán *về mặt vật lý* không thể ghi prod; plane sửa bị cô lập trong branch + PR review. Gate là cầu nối duy nhất.
- **Hypothesis-driven**: agent đặt giả thuyết falsifiable và đi tìm bằng chứng để xác nhận/bác bỏ, **không** dump toàn bộ log vào LLM → rẻ hơn, nhanh hơn, chính xác hơn.
- **Memory làm hệ thống tích lũy**: mỗi sự cố giải quyết xong dạy lại hệ thống; phát hiện tái diễn → rút ngắn chẩn đoán.

---

## Diagnostic Sources (generic) + Topology Registry  *(idea 1 + idea 2)*

**Yêu cầu:** KHÔNG hardcode tên service/DB/shard của mida vào code. Lớp chẩn đoán là **diagnostic source tổng quát**; mida chỉ là *một cấu hình inventory*.

### 3 lớp tách bạch

**1. Source driver — theo *loại* nguồn, không theo mida.** Mỗi driver hiện thực 1 interface chung và **normalize kết quả về canonical envelope**:

```javascript
// mcp-diagnostic/src/sources/<type>.source.js — interface chung cho mọi driver
export default {
    type: 'mongo',                       // sentry | docker-logs | loki | mongo | clickhouse | rabbitmq | prometheus | jenkins | git | http-probe
    capabilities: ['events', 'db'],      // verb nào driver này phục vụ
    async query(verb, params, sourceCfg) {
        // ... gọi nguồn thật, rồi map -> CanonicalEvent[] (hoặc structured)
    },
};
```

**2. Inventory / Topology registry — DATA, không phải code.** Mô tả topology thật: service → instance → shard → map tới source nào + credential ref + routing rule. File `inventory.yaml` (hoặc collection Mongo):

```yaml
# mcp-diagnostic/inventory.yaml — topology mida là DATA, không nằm trong code
tenancy:
  # tái dùng ProxyModel của mida: domain -> proxy index (shard)
  resolver: { type: mongo, conn: $PROXY_URI, collection: shops, key: domain, value: proxy }
services:
  - name: api
    instances:
      - { id: api-1, shard: 1, sources: { errors: sentry-api, logs: docker-api-1, events: mongo-api-1 } }
      - { id: api-2, shard: 2, sources: { errors: sentry-api, logs: docker-api-2, events: ch-api-2 } }   # storage KHÁC
  - name: heatmap
    instances:
      - { id: hm-1, shard: 1, sources: { logs: docker-hm-1, hm: mongo-hm-1 } }
      - { id: hm-2, shard: 2, sources: { logs: docker-hm-2, hm: mongo-hm-2 } }
sources:
  sentry-api:   { type: sentry,      project: <slug> }
  docker-api-1: { type: docker-logs, service: <swarm-service>, node: <node> }
  mongo-api-1:  { type: mongo,       conn: $API_URI_1, collection: events }
  ch-api-2:     { type: clickhouse,  conn: $CH_URI,    table: events }    # cùng verb 'events', driver khác
```

**3. Generic verbs (MCP tools):** `errors_search`, `errors_detail`, `logs_search`, `events_query`, `metrics_query`, `queue_status`, `cache_status`, `infra_health`, `deploy_recent`. Tool nhận `target` (`service` / `instance` / `tenant` / `window`), **resolver** tra registry → ra (các) source cụ thể → fan-out → driver normalize → merge. **LLM chỉ thấy verb + canonical envelope — không biết Mongo hay ClickHouse, không biết shard nào.**

### "Take hết" sự rời rạc của mida bằng cách nào *(trả lời idea 2)*

Có — nhưng *chỉ vì* lớp source ở trên là **topology-aware + storage-agnostic**. Cơ chế:

- **Tenant resolution:** Incident có `domain` → resolver hỏi `ProxyModel` (đúng cơ chế mida đang dùng) → `shard index` → biết phải hỏi `api-{n}` / `recorder-{n}` / `heatmap-{n}`, Mongo-v{n} hay ClickHouse.
- **Heterogeneous storage = việc của driver, KHÔNG phải của LLM:** verb `events_query` trên shard-1 → resolve ra `mongo` source; trên shard-2 → resolve ra `clickhouse` source. Hai driver khác nhau nhưng **trả về cùng canonical envelope**. Đây chính là cách "take hết" hệ phân mảnh: *normalize tại biên driver, topology là data*.
- **Blast radius nhiều instance:** verb fan-out song song tới các instance liên quan rồi merge theo `ts` / `traceId`.
- **Coverage incremental:** không cần phủ 100% ngày 1. Bắt đầu nguồn tín hiệu cao + đồng nhất across shard (Sentry, logs); thêm nguồn DB dị thể *sau cùng 1 verb* — abstraction cho mở rộng coverage mà không viết lại. Chỗ chưa cover → registry đánh dấu `unsupported`, verb trả "no source" rõ ràng (không giả vờ đã phủ hết).

---

## Ingestion strategy: PULL (không build pipeline push)  *(idea 3)*

**Câu hỏi của bạn:** có cần tracing ship thẳng log lên RCA MCP để gom hết về 1 format không?

**Trả lời: KHÔNG dựng push pipeline. Dùng PULL + normalize-on-read + correlation.**

| | **PULL** (federated query) — KHUYẾN NGHỊ | PUSH (centralize log pipeline) |
|---|---|---|
| Infra mới | Không — query nguồn có sẵn lúc chẩn đoán | Cả 1 pipeline (Vector/Fluent-bit → Loki/CH/OpenSearch) |
| Trùng lặp | Không đụng Sentry | **Trùng Sentry** — dựng lại observability |
| Chi phí / retention / PII | Gần 0; dữ liệu ở yên chỗ cũ | Storage + egress + retention + PII burden |
| Touch prod | Không (chỉ đọc) | Phải gắn shipper vào *mọi* service |
| Bắt đầu | Ngay | Hàng tháng — lệch trọng tâm RCA |

**Mấu chốt:** vấn đề thật của hệ phân mảnh KHÔNG phải "log nằm nhiều chỗ" — mà là **không join được Sentry error ↔ log line ↔ DB state ↔ deploy gây ra nó**. Centralize storage là sai hướng & đắt. Giải đúng bằng 3 thứ rẻ:

**1. Canonical event envelope (normalize-on-read)** — mọi driver map về 1 schema → "1 format để phân tích" mà KHÔNG cần pipeline. Normalize lúc ĐỌC (trong driver), không phải lúc GHI (trong pipeline):

```javascript
// mcp-diagnostic/src/helpers/envelope.js
/**
 * @typedef {Object} CanonicalEvent
 * @property {string} ts            ISO8601
 * @property {string} source        'sentry'|'docker-logs'|'mongo'|'clickhouse'|'rabbitmq'|'jenkins'|'git'
 * @property {string} service       'api'|'recorder'|'heatmap'|...
 * @property {string|null} instance 'api-1'|'api-2'|...
 * @property {string|null} tenant   domain
 * @property {number|null} shard
 * @property {string|null} level    'error'|'warn'|'info'|...
 * @property {string} kind          'error'|'log'|'metric'|'event'|'deploy'|'queue'
 * @property {string|null} traceId  để join across service
 * @property {string} message
 * @property {Object} attrs         field đã chuẩn hoá
 * @property {string|null} link     deep-link về nguồn gốc (URL Sentry issue, build Jenkins...)
 */
export const toEvent = (partial) => ({ traceId: null, level: null, attrs: {}, link: null, ...partial });
```

**2. Correlation key (traceId)** — thứ DUY NHẤT đáng thêm vào codebase mida: propagate 1 request/correlation ID xuyên service (middleware nhẹ ở `sama-api`/recorder/...). mida đã có Sentry tracing (`tracesSampleRate: 0.25`) → tận dụng trace/span id của Sentry, đẩy nó vào dòng log (`logger` đã có field sẵn, chỉ thêm `traceId`). Thay đổi nhỏ, đòn bẩy lớn — KHÁC HẲN dựng cả pipeline.

**3. Per-incident evidence snapshot (gom CÓ CHỌN LỌC)** — khi RCA chạy, GHI bundle evidence đã normalize vào `rca_cases`. → mỗi sự cố CÓ 1 bundle "1 format, dễ phân tích" — nhưng **chỉ cho sự cố đang điều tra**, không phải toàn bộ log mọi lúc. Đây mới là phần "gom về 1 định dạng" đáng làm.

**Sentry coexist thế nào:** Sentry vẫn là backbone lỗi/exception (mạnh ở error + trace lớn). RCA dùng nó làm **điểm vào**, rồi pull thêm log/DB/deploy để hoàn thiện bức tranh. Không thay thế, không trùng lặp.

**Escape hatch (khi nào mới cần push):** nếu retention nguồn quá ngắn để điều tra sự cố cũ, hoặc 1 nguồn không có API query → mirror *có chọn lọc* (vd chỉ `error`+`warn`) sang 1 store rẻ (ClickHouse). Khi đó nó chỉ là **thêm 1 source nữa** sau cùng abstraction — không đập đi xây lại. Để Phase 5+.

---

## Mapping pipeline ↔ sơ đồ của bạn

| Stage bạn vẽ | Thực thi trong plan này |
|---|---|
| **Ticket** (CRM/Mattermost/Slack) | `ingest/` chuẩn hoá thành object `Incident` |
| **MCP Diagnostic** | Stage 1 Triage (Haiku) + mở "case" + Memory recall + dựng hypothesis ban đầu, timeline, blast radius |
| **Collect Logs** | `logs.search`, `sentry.issues`, `sentry.events` |
| **Analyze Metrics** | `clickhouse.query`, `rabbit.queues`, `redis.info`, `swarm.services` |
| **Analyze DB** | `mongo.find/aggregate/slow_ops/coll_stats/server_status` |
| **Root Cause** | Stage 3: Opus synthesize + correlate `deploy.recent` + **adversarial verify** (cố bác bỏ giả thuyết hàng đầu trước khi chốt) |
| **Generate Fix Plan** | Stage 4: artifact markdown (đúng convention plan của team) + risk + rollback + verification |
| **Claude Code Execute** | `executor/` — gated handoff, headless trong worktree → PR |

> **Lưu ý thiết kế quan trọng:** "Collect Logs / Analyze Metrics / Analyze DB" **không** phải 3 bước tuần tự cứng. Chúng hợp thành **một agentic evidence-gathering loop** với 1 hypothesis ledger. Orchestrator điều khiển loop *một cách deterministic* (giới hạn iteration + token budget), nhưng để **Claude tự chọn** đọc tool nào tiếp theo dựa trên giả thuyết hiện tại. Đây là điểm "chuẩn" so với việc chạy mù tất cả collector.

---

## Tech Stack

| Thành phần | Lựa chọn | Lý do |
|---|---|---|
| Runtime | Node.js ≥ 20, ESM | Đồng nhất `sama-mcp`/`sama-api` |
| Reasoning | `@anthropic-ai/sdk` | Manual agentic loop (kiểm soát gate/audit/redact) |
| Model — RCA reasoning | `claude-opus-4-8` + `thinking:{type:'adaptive'}` + `output_config:{effort:'high'}` | Synthesize root cause, fix plan, long-horizon |
| Model — triage/log đọc nhanh | `claude-sonnet-4-6` | Cân bằng tốc độ/chi phí |
| Model — classify/dedup ticket | `claude-haiku-4-5` | Rẻ nhất, đủ cho phân loại |
| MCP server | Express v5 + `@modelcontextprotocol/sdk` (StreamableHTTP) | Đúng pattern `sama-mcp` |
| **Diagnostic sources** | Source driver theo *loại* (sentry/docker-logs/mongo/clickhouse/…) | Generic, không hardcode mida (idea 1) |
| **Topology registry** | `inventory.yaml` + resolver dùng `ProxyModel` | Map tenant→shard→source; "take" hệ phân mảnh (idea 2) |
| **Canonical envelope** | `CanonicalEvent` normalize-on-read | 1 format phân tích, không cần pipeline (idea 3) |
| **Ingestion** | PULL / federated query (không push pipeline) | Tái dùng Sentry+logs có sẵn, rẻ, không đụng prod (idea 3) |
| Config registry | `yaml` (`js-yaml`) | Đọc inventory.yaml |
| MCP client (orchestrator → diagnostic) | `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` | Đầy đủ kiểm soát mỗi tool call |
| DB ops (memory + audit) | MongoDB (Mongoose) | Team đã chạy sẵn |
| Executor | Claude Code CLI headless (`claude -p`) | Theo quyết định runtime |
| Structured output | `output_config:{format:{type:'json_schema',...}}` | RootCause/FixPlan để pipeline branch deterministic |
| Prompt caching | `cache_control:{type:'ephemeral'}` trên system prompt + tool defs | Giảm ~10x chi phí context lặp giữa các iteration |
| Code quality | ESLint, Prettier, Husky, lint-staged | Copy config từ `sama-mcp` |

> **Model IDs là chính xác** (knowledge tới 2026): `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`. Dùng adaptive thinking (KHÔNG dùng `budget_tokens` — đã bỏ trên Opus 4.7+). KHÔNG set `temperature`/`top_p` (400 trên Opus 4.8).

---

## Directory Structure

```
sama-orchestration/
├── package.json                 # type:module, node>=20, workspaces? (giữ đơn giản: 2 app)
├── plan.md                      # file này
├── README.md
├── eslint.config.js .prettierrc # copy từ sama-mcp
│
├── src/                         # ORCHESTRATOR (brain) — READ plane + control
│   ├── index.js                 # Express: webhook Mattermost + control API + health
│   ├── config/
│   │   ├── env.js               # validate env (giống validateEnv của sama-api)
│   │   ├── anthropic.js         # Anthropic client + MODELS registry
│   │   └── mongo.js             # ops DB (collections: rca_incidents, rca_runs, rca_cases)
│   ├── ingest/
│   │   ├── incident.schema.js   # canonical Incident (JSON schema + JSDoc typedef)
│   │   ├── adapter.interface.js # chuẩn adapter (CRM/Slack cắm sau)
│   │   └── mattermost.adapter.js
│   ├── orchestrator/
│   │   ├── pipeline.js          # 4 stage deterministic
│   │   ├── investigate.js       # AGENTIC LOOP (Anthropic + MCP client)
│   │   ├── hypothesis.js        # hypothesis ledger
│   │   ├── rootcause.js         # synthesize + adversarial verify
│   │   └── fixplan.js           # sinh artifact Fix Plan (markdown)
│   ├── mcp-client/
│   │   └── diagnostic.client.js # Client → mcp-diagnostic, convert MCP→Anthropic tool defs
│   ├── executor/
│   │   └── claude-code.runner.js# headless Claude Code trong worktree → PR (Phase 4)
│   ├── memory/
│   │   └── incident.memory.js   # lưu/tra cứu sự cố quá khứ (recurrence)
│   ├── security/
│   │   ├── redact.js            # scrub secret/PII trước khi vào model
│   │   └── audit.js             # audit log mọi tool call + action
│   └── helpers/
│       └── prompt.js            # system prompt từng stage
│
├── mcp-diagnostic/              # READ-ONLY MCP SERVER (generic sources, process & creds riêng)
│   ├── package.json
│   ├── .env.example
│   ├── inventory.yaml           # ⭐ TOPOLOGY mida là DATA (service/instance/shard→source). Hệ khác = file khác.
│   └── src/
│       ├── index.js             # MIRROR sama-mcp/src/index.js
│       ├── middleware/
│       │   └── auth.middleware.js   # ops bearer token (KHÔNG per-shop JWT)
│       ├── handler/verb.handler.js  # registry GENERIC VERBS: listTool/callTool (pattern sama-mcp)
│       ├── routers/tool.route.js
│       ├── registry/
│       │   ├── inventory.js         # load + validate inventory.yaml
│       │   └── resolver.js          # target(service/instance/tenant) + ProxyModel → [sourceCfg]
│       ├── sources/                 # SOURCE DRIVERS — theo LOẠI nguồn, TẤT CẢ read-only
│       │   ├── index.js             # đăng ký driver theo type
│       │   ├── sentry.source.js     # type: sentry        cap: errors
│       │   ├── docker-logs.source.js# type: docker-logs   cap: logs
│       │   ├── mongo.source.js      # type: mongo         cap: events, db   (read-only user)
│       │   ├── clickhouse.source.js # type: clickhouse    cap: events, metrics (read-only SQL)
│       │   ├── rabbitmq.source.js   # type: rabbitmq      cap: queue
│       │   ├── redis.source.js      # type: redis         cap: cache
│       │   ├── jenkins.source.js    # type: jenkins       cap: deploy
│       │   └── git.source.js        # type: git           cap: deploy
│       └── helpers/
│           ├── envelope.js          # ⭐ CanonicalEvent (normalize-on-read về 1 format)
│           ├── format.helper.js     # format envelope cho LLM (dense, ít token)
│           └── redis.helper.js      # copy stableStringify/hashKey từ sama-mcp
│
└── docs/
    └── plans/                   # plan chi tiết từng phase (convention team)
```

---

## Roadmap (5 phases)

| Phase | Mục tiêu | Plane | Định nghĩa "xong" |
|---|---|---|---|
| **0** | Walking skeleton: scaffold 2 app, config, health, Incident type | — | `pnpm dev` cả 2 app chạy, health 200 |
| **1** | **READ plane**: source-driver abstraction + topology registry (`inventory.yaml`) + canonical envelope + 3 driver giá trị cao nhất (Sentry/docker-logs/jenkins-git) + generic verbs + CLI `diagnose` | READ | Verb generic resolve qua registry, trả canonical envelope từ dữ liệu thật; thêm source = thêm file, không sửa core |
| **2** | **Brain**: agentic investigate loop + root cause + Fix Plan markdown từ Incident nhập tay | READ | Đưa 1 Incident tay → ra Fix Plan có evidence citations |
| **3** | **End-to-end vào**: Mattermost ingest + triage (Haiku) + memory recall | READ | Ticket Mattermost → Fix Plan post lại channel kèm nút duyệt |
| **4** | **WRITE plane**: executor handoff — duyệt → Claude Code headless → PR | WRITE | Approve → có PR trong repo đích, có rollback |
| **5** | **Hardening + coverage**: thêm source driver mới (mongo/clickhouse/rabbitmq/redis/swarm) *sau cùng các verb* — gồm `events_query` heterogeneous (Mongo shard-1 vs ClickHouse shard-2) + tenant→shard qua ProxyModel + correlation traceId + redaction + audit + observability + eval suite | cả 2 | `events_query` trả cùng envelope dù shard Mongo/CH; eval ≥10 sự cố; redaction+audit bật |

> Plan chi tiết Phase 2–5 sẽ viết trong `docs/plans/` khi tới. **Phase 0 + Phase 1 được chi tiết hoá đầy đủ bên dưới** để bắt đầu thực thi ngay.

---

## File Map — Phase 0 + Phase 1

| Action | Path | Trách nhiệm |
|---|---|---|
| Create | `package.json`, `eslint.config.js`, `.prettierrc`, `.gitignore` | Scaffold orchestrator (copy config sama-mcp) |
| Create | `src/index.js` | Express health + (placeholder webhook) |
| Create | `src/config/env.js` | Validate env |
| Create | `src/ingest/incident.schema.js` | Canonical `Incident` type |
| Create | `mcp-diagnostic/package.json` + config | Scaffold MCP server |
| Create | `mcp-diagnostic/src/index.js` | MCP StreamableHTTP server (mirror sama-mcp) |
| Create | `mcp-diagnostic/src/middleware/auth.middleware.js` | Ops bearer token |
| Create | `mcp-diagnostic/inventory.yaml` | ⭐ Topology mida = DATA (service/instance/shard→source) |
| Create | `mcp-diagnostic/src/registry/inventory.js` + `resolver.js` | Load inventory + resolve target→sources (allowlist) |
| Create | `mcp-diagnostic/src/helpers/envelope.js` | ⭐ CanonicalEvent (normalize-on-read) |
| Create | `mcp-diagnostic/src/handler/verb.handler.js` | Registry generic verbs (resolve→dispatch→format) |
| Create | `mcp-diagnostic/src/sources/index.js` | Đăng ký driver theo type + `dispatch()` |
| Create | `mcp-diagnostic/src/sources/sentry.source.js` | Driver `sentry` (cap: errors) |
| Create | `mcp-diagnostic/src/sources/docker-logs.source.js` | Driver `docker-logs` (cap: logs) |
| Create | `mcp-diagnostic/src/sources/{jenkins,git}.source.js` | Driver deploy (read-only) |
| Create | `mcp-diagnostic/src/helpers/format.helper.js` | Format envelope dense cho LLM |
| Create | `mcp-diagnostic/.env.example` | Sentry/Docker/Jenkins config |

---

## Phase 0 — Walking Skeleton

### Task 0.1: Scaffold orchestrator app

- [ ] **Step 1: `package.json` (root orchestrator)**

```json
{
  "name": "sama-orchestration",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "nodemon src/index.js",
    "start": "node src/index.js",
    "diagnose": "node src/cli/diagnose.js",
    "lint": "eslint .",
    "format": "prettier --write ."
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "@modelcontextprotocol/sdk": "^1.28.0",
    "cors": "^2.8.5",
    "dotenv": "^17.3.1",
    "express": "^5.2.1",
    "mongoose": "^8.0.0"
  },
  "devDependencies": {
    "eslint": "^9.0.0",
    "nodemon": "^3.1.0",
    "prettier": "^3.4.0"
  }
}
```

> Verify version `@anthropic-ai/sdk` mới nhất khi cài (`npm view @anthropic-ai/sdk version`). SDK này hỗ trợ `output_config`, adaptive thinking, prompt caching, native MCP connector.

- [ ] **Step 2: Copy `eslint.config.js`, `.prettierrc`, `.gitignore` từ `sama-mcp`** (giữ đồng nhất style).

- [ ] **Step 3: `src/config/env.js` — validate env**

```javascript
// src/config/env.js
import dotenv from 'dotenv';
dotenv.config();

const required = ['ANTHROPIC_API_KEY', 'MCP_DIAGNOSTIC_URL', 'MCP_OPS_TOKEN', 'OPS_MONGO_URI'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
    console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(1);
}

export const ENV = {
    port: Number(process.env.PORT ?? 7400),
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    mcpUrl: process.env.MCP_DIAGNOSTIC_URL,
    mcpToken: process.env.MCP_OPS_TOKEN,
    opsMongoUri: process.env.OPS_MONGO_URI,
    mattermostWebhookSecret: process.env.MATTERMOST_WEBHOOK_SECRET ?? '',
};
```

- [ ] **Step 4: `src/config/anthropic.js` — client + model registry**

```javascript
// src/config/anthropic.js
import Anthropic from '@anthropic-ai/sdk';
import { ENV } from './env.js';

export const anthropic = new Anthropic({ apiKey: ENV.anthropicKey });

export const MODELS = {
    REASON: 'claude-opus-4-8',   // root cause, fix plan
    TRIAGE: 'claude-sonnet-4-6', // đọc log nhanh, summarize
    CLASSIFY: 'claude-haiku-4-5',// phân loại/dedup ticket
};
```

- [ ] **Step 5: `src/ingest/incident.schema.js` — canonical Incident**

```javascript
// src/ingest/incident.schema.js
/**
 * @typedef {Object} Incident
 * @property {string} id            - id nội bộ (uuid)
 * @property {string} source        - 'mattermost' | 'crm' | 'slack' | 'manual'
 * @property {string} sourceRef     - id gốc (post id / ticket id)
 * @property {string} title
 * @property {string} description    - mô tả thô của reporter
 * @property {string[]} symptoms     - triệu chứng tách ra (Stage 1 điền)
 * @property {string|null} affectedService - service nghi ngờ (vd 'sama-api')
 * @property {{from:string|null,to:string|null}} timeWindow - ISO; window điều tra
 * @property {'low'|'medium'|'high'|'critical'} severity
 * @property {string|null} domain    - shop domain nếu có (lọc log/sentry)
 * @property {string} createdAt
 */

/** JSON schema cho structured-output ở Stage 1 (triage). */
export const INCIDENT_TRIAGE_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        symptoms: { type: 'array', items: { type: 'string' } },
        affectedService: { type: ['string', 'null'] },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        domain: { type: ['string', 'null'] },
        isDuplicate: { type: 'boolean' },
    },
    required: ['title', 'symptoms', 'severity'],
    additionalProperties: false,
};
```

- [ ] **Step 6: `src/index.js` — health + webhook placeholder**

```javascript
// src/index.js
import express from 'express';
import cors from 'cors';
import { ENV } from './config/env.js';

const app = express();
app.use(express.json());
app.use(cors());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'sama-orchestration', version: '0.1.0' }));

// Phase 3 sẽ hiện thực
app.post('/webhook/mattermost', (req, res) => {
    console.log('mattermost event', JSON.stringify(req.body).slice(0, 200));
    res.json({ status: 'accepted' });
});

app.listen(ENV.port, () => console.log(`orchestrator on :${ENV.port}`));
```

- [ ] **Step 7: Commit**

```bash
git init && git add -A
git commit -m "chore: scaffold sama-orchestration (phase 0 walking skeleton)"
```

### Task 0.2: Scaffold `mcp-diagnostic` app

- [ ] **Step 8: `mcp-diagnostic/package.json`** — copy structure từ `sama-mcp/package.json` (Express 5, `@modelcontextprotocol/sdk`, mongodb/mongoose, redis tuỳ chọn). Dependencies tối thiểu Phase 1: `express`, `cors`, `dotenv`, `@modelcontextprotocol/sdk`, `js-yaml` (đọc `inventory.yaml`).

- [ ] **Step 9: `mcp-diagnostic/.env.example`**

```env
PORT=7401
MCP_OPS_TOKEN=<shared secret với orchestrator>

# Sentry
SENTRY_API_TOKEN=<auth token read-only, scope: project:read, event:read>
SENTRY_ORG=<org slug>
SENTRY_BASE_URL=https://sentry.io/api/0

# Docker Swarm (đọc log) — chạy trên manager node hoặc qua socket
DOCKER_BIN=docker

# Jenkins
JENKINS_URL=https://<jenkins-host>
JENKINS_USER=<user>
JENKINS_TOKEN=<api token read-only>

# Git repos đích (đọc commit/diff)
REPOS_ROOT=/srv/repos   # nơi clone sẵn các sama-* repo (read-only)
```

- [ ] **Step 10: Commit** `chore: scaffold mcp-diagnostic app`.

### Verify Phase 0
- [ ] `cd sama-orchestration && pnpm i && pnpm dev` → GET `/health` trả `{ok:true}`.
- [ ] `mcp-diagnostic` cài được, chưa cần chạy.

---

## Phase 1 — READ plane: generic verbs over sources (Sentry + logs + deploy)

**Context:** Mirror pattern `sama-mcp` (`Server` + `StreamableHTTPServerTransport`, per-request server, `ToolRouter` qua `setRequestHandler`, `listTool`/`callTool`). **Khác biệt then chốt vs sama-mcp:** (a) auth bằng **ops bearer token** (không per-shop JWT); (b) tools là **generic verbs** nhận `target` rồi **resolve qua registry**, KHÔNG enum hardcode tên mida; (c) mỗi nguồn là 1 **source driver** normalize về **canonical envelope**. Phase 1 cài 3 driver giá trị cao nhất (sentry/docker-logs/jenkins+git) + 1 registry tối thiểu cho mida.

### Task 1.0: Foundation — envelope + inventory + resolver + source registry

- [ ] **Step F1: `mcp-diagnostic/src/helpers/envelope.js`** — `CanonicalEvent` + `toEvent()` (schema ở section "Ingestion strategy" phía trên). Mọi driver phải trả về dạng này.

- [ ] **Step F2: `mcp-diagnostic/inventory.yaml`** — topology mida (xem mẫu ở section "Diagnostic Sources + Topology Registry"). Bắt đầu tối thiểu: 1 service `api` với 1–2 instance + sources `sentry`/`docker-logs`/`jenkins`/`git`. Mở rộng dần.

- [ ] **Step F3: `mcp-diagnostic/src/registry/inventory.js`** — load + validate `inventory.yaml` (dùng `js-yaml`); expose `getInstances(service)`, `getSource(id)`, `listServices()`.

- [ ] **Step F4: `mcp-diagnostic/src/registry/resolver.js`** — resolve `target` → danh sách `sourceCfg`:

```javascript
// mcp-diagnostic/src/registry/resolver.js
import { getInstances, getSource } from './inventory.js';
// import ProxyModel-like lookup nếu cần tenant→shard (Phase 3+)

// target: { service, instance?, tenant?, capability }
// trả [{ instanceId, shard, sourceCfg }] — đã là ALLOWLIST (chỉ thứ có trong inventory mới chạy được)
export function resolve({ service, instance, tenant, capability }) {
    let instances = getInstances(service);
    if (instance) instances = instances.filter((i) => i.id === instance);
    // tenant→shard: Phase 1 bỏ qua; Phase 3 hỏi ProxyModel(domain)->proxy rồi filter theo shard
    const out = [];
    for (const inst of instances) {
        const srcId = inst.sources[capability];
        if (!srcId) continue;               // instance này không phục vụ capability → skip
        out.push({ instanceId: inst.id, shard: inst.shard, sourceCfg: getSource(srcId) });
    }
    return out; // rỗng = "no source" (verb báo rõ, không giả vờ phủ hết)
}
```

> **Đây chính là chỗ thay thế mọi `ALLOWED_SERVICES`/`ALLOWED_REPOS` hardcode:** allowlist = nội dung `inventory.yaml`. Không có gì về mida nằm trong code driver/verb.

- [ ] **Step F5: `mcp-diagnostic/src/sources/index.js`** — đăng ký driver theo `type`:

```javascript
import sentry from './sentry.source.js';
import dockerLogs from './docker-logs.source.js';
import jenkins from './jenkins.source.js';
import git from './git.source.js';
export const DRIVERS = Object.fromEntries([sentry, dockerLogs, jenkins, git].map((d) => [d.type, d]));
export const dispatch = (sourceCfg, verb, params) => DRIVERS[sourceCfg.type].query(verb, params, sourceCfg);
```

### Task 1.1: MCP server entry + auth

- [ ] **Step 11: `mcp-diagnostic/src/middleware/auth.middleware.js`**

```javascript
// mcp-diagnostic/src/middleware/auth.middleware.js
import dotenv from 'dotenv';
dotenv.config();

const { MCP_OPS_TOKEN } = process.env;

const AuthMiddleware = (req, res, next) => {
    const token = req.headers?.authorization?.replace(/Bearer /g, '');
    if (!token || token !== MCP_OPS_TOKEN) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    next();
};

export default AuthMiddleware;
```

- [ ] **Step 12: `mcp-diagnostic/src/index.js`** (mirror `sama-mcp/src/index.js`)

```javascript
// mcp-diagnostic/src/index.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import AuthMiddleware from './middleware/auth.middleware.js';
import ToolRouter from './routers/tool.route.js';
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const createMcpServer = () => {
    const server = new Server(
        { name: 'mida-diagnostic-mcp', version: '0.1.0' },
        { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } } }
    );
    ToolRouter(server);
    return server;
};

app.get('/', (_req, res) => res.json({ name: 'mida-diagnostic-mcp', endpoints: ['/mcp'] }));

app.post('/mcp', AuthMiddleware, async (req, res) => {
    console.log(req.body.method, JSON.stringify(req.body.params));
    try {
        const transport = new StreamableHTTPServerTransport();
        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => { transport.close(); server.close(); });
    } catch (error) {
        console.error(error);
    }
});

const PORT = process.env.PORT || 7401;
app.listen(PORT, () => console.log(`diagnostic MCP on :${PORT}`));
```

- [ ] **Step 13: `mcp-diagnostic/src/routers/tool.route.js`** (giống `sama-mcp`)

```javascript
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import ToolHandler from '../handler/tool.handler.js';

const ToolRouter = (server) => {
    server.setRequestHandler(ListToolsRequestSchema, ToolHandler.listTool);
    server.setRequestHandler(CallToolRequestSchema, async (request) => await ToolHandler.callTool(request));
};

export default ToolRouter;
```

### Task 1.2: Source drivers (read-only, normalize về CanonicalEvent)

> 3 driver dưới giữ nguyên phần lõi gọi nguồn, nhưng theo interface `{ type, capabilities, async query(verb, params, sourceCfg) }`: **tên project/service/repo KHÔNG hardcode trong driver — đến từ `sourceCfg` (inventory) qua resolver (Task 1.0)**. `ALLOWED_SERVICES`/`ALLOWED_REPOS` dưới đây CHỈ là fallback dev; production allowlist = nội dung `inventory.yaml`. Output cuối map qua `toEvent()`.

- [ ] **Step 14: `mcp-diagnostic/src/sources/sentry.source.js`** (`type: sentry`, cap: `errors`)

```javascript
// mcp-diagnostic/src/services/sentry.service.js
import dotenv from 'dotenv';
dotenv.config();

const { SENTRY_API_TOKEN, SENTRY_ORG, SENTRY_BASE_URL } = process.env;

const headers = { Authorization: `Bearer ${SENTRY_API_TOKEN}` };

const SentryService = {
    // List issues của 1 project, lọc theo query/level/time, sort theo tần suất
    listIssues: async ({ project, query = '', statsPeriod = '24h', limit = 25 }) => {
        const url = new URL(`${SENTRY_BASE_URL}/projects/${SENTRY_ORG}/${project}/issues/`);
        url.searchParams.set('query', `is:unresolved ${query}`.trim());
        url.searchParams.set('statsPeriod', statsPeriod);
        url.searchParams.set('limit', String(Math.min(limit, 100)));
        url.searchParams.set('sort', 'freq');
        const r = await fetch(url, { headers });
        if (!r.ok) throw new Error(`sentry ${r.status}`);
        return r.json();
    },

    // Chi tiết 1 issue: culprit, metadata, count, firstSeen/lastSeen, release
    getIssue: async ({ issueId }) => {
        const r = await fetch(`${SENTRY_BASE_URL}/issues/${issueId}/`, { headers });
        if (!r.ok) throw new Error(`sentry ${r.status}`);
        return r.json();
    },

    // Event mới nhất của issue: stacktrace + breadcrumbs + tags
    latestEvent: async ({ issueId }) => {
        const r = await fetch(`${SENTRY_BASE_URL}/issues/${issueId}/events/latest/`, { headers });
        if (!r.ok) throw new Error(`sentry ${r.status}`);
        return r.json();
    },
};

export default SentryService;
```

- [ ] **Step 15: `mcp-diagnostic/src/sources/docker-logs.source.js`** (`type: docker-logs`, cap: `logs` — Docker Swarm, read-only). *Driver nhận `sourceCfg` (service/node từ inventory); code dưới giữ logic, bỏ `ALLOWED_SERVICES` khi đã có resolver.*

```javascript
// mcp-diagnostic/src/services/logs.service.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const DOCKER = process.env.DOCKER_BIN || 'docker';

// allowlist service để tránh truyền tham số tuỳ tiện vào docker
const ALLOWED_SERVICES = new Set([
    'sama-api', 'sama-recorder', 'sama-hm', 'sama-search', 'sama-mcp',
]);

const LogsService = {
    listServices: async () => {
        const { stdout } = await exec(DOCKER, ['service', 'ls', '--format', '{{.Name}}|{{.Replicas}}|{{.Image}}']);
        return stdout.trim().split('\n').filter(Boolean).map((l) => {
            const [name, replicas, image] = l.split('|');
            return { name, replicas, image };
        });
    },

    // Đọc log theo service + since + tail. Parse JSON line {filename,caller,level,domain,message,time}
    search: async ({ service, since = '1h', tail = 500, level = null, grep = null, domain = null }) => {
        if (!ALLOWED_SERVICES.has(service)) throw new Error(`service not allowed: ${service}`);
        const { stdout } = await exec(
            DOCKER,
            ['service', 'logs', '--no-task-ids', '--since', since, '--tail', String(Math.min(tail, 5000)), service],
            { maxBuffer: 32 * 1024 * 1024 }
        );
        const lines = stdout.split('\n').filter(Boolean);
        const out = [];
        for (const raw of lines) {
            // docker prefix: "service.1.xxxx@node    | {json}"
            const jsonStart = raw.indexOf('{');
            let log;
            try { log = JSON.parse(raw.slice(jsonStart)); } catch { log = { level: 'raw', message: raw }; }
            if (level && log.level !== level) continue;
            if (domain && log.domain !== domain) continue;
            if (grep && !(log.message || '').toLowerCase().includes(grep.toLowerCase())) continue;
            out.push(log);
        }
        return out.slice(-tail);
    },
};

export default LogsService;
```

- [ ] **Step 16: `mcp-diagnostic/src/sources/{jenkins,git}.source.js`** (cap: `deploy` — read-only). *2 driver: `jenkins` (recentBuilds) + `git` (recentCommits); code dưới gộp cho gọn, tách 2 file theo `type`. Service/repo/job từ inventory, bỏ `ALLOWED_REPOS`.*

```javascript
// mcp-diagnostic/src/services/deploy.service.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config();
const exec = promisify(execFile);

const { JENKINS_URL, JENKINS_USER, JENKINS_TOKEN, REPOS_ROOT } = process.env;
const ALLOWED_REPOS = new Set(['sama-api', 'sama-recorder', 'sama-hm', 'sama-search', 'sama-mcp', 'sama-cms']);

const DeployService = {
    // Build gần đây của 1 job Jenkins (correlate sự cố ↔ deploy)
    recentBuilds: async ({ job, limit = 10 }) => {
        const url = `${JENKINS_URL}/job/${encodeURIComponent(job)}/api/json?tree=builds[number,result,timestamp,duration]{0,${limit}}`;
        const auth = 'Basic ' + Buffer.from(`${JENKINS_USER}:${JENKINS_TOKEN}`).toString('base64');
        const r = await fetch(url, { headers: { Authorization: auth } });
        if (!r.ok) throw new Error(`jenkins ${r.status}`);
        return r.json();
    },

    // Commit gần đây của 1 repo trong window (read-only git log)
    recentCommits: async ({ repo, since = '2 days ago', limit = 20 }) => {
        if (!ALLOWED_REPOS.has(repo)) throw new Error(`repo not allowed: ${repo}`);
        const cwd = path.join(REPOS_ROOT, repo);
        const { stdout } = await exec(
            'git',
            ['log', `--since=${since}`, `-n${limit}`, '--pretty=format:%h|%an|%ad|%s', '--date=iso'],
            { cwd }
        );
        return stdout.trim().split('\n').filter(Boolean).map((l) => {
            const [hash, author, date, ...rest] = l.split('|');
            return { hash, author, date, subject: rest.join('|') };
        });
    },
};

export default DeployService;
```

> **An toàn:** dùng `execFile` (không shell); **service/repo đến từ `sourceCfg` (inventory) qua resolver, KHÔNG từ raw LLM args** → tránh injection + giữ allowlist tập trung 1 chỗ. `REPOS_ROOT` là bản clone read-only chỉ để đọc lịch sử.

- [ ] **Step 17: `mcp-diagnostic/src/helpers/format.helper.js`** — format kết quả dày/ít token cho LLM (giống tinh thần `sama-mcp`): mỗi formatter trả 1 string nhiều dòng `KEY:value`. Ví dụ `formatSentryIssues(issues)` → liệt kê `rank | shortId | title | count | lastSeen | culprit | release`.

### Task 1.3: Tool handler (4 tool)

- [ ] **Step 18: `mcp-diagnostic/src/handler/verb.handler.js`** — registry pattern y hệt `sama-mcp` (`listTool`/`callTool`, mảng `verbs`, mỗi verb `{name, description, inputSchema, execute}`). **Mỗi `execute` theo pattern chung:** `resolve(target)` (Task 1.0) → `dispatch(sourceCfg, verb, params)` cho từng source → merge envelopes → `format`. Driver internal (Sentry/docker/git) là phần lõi đã viết ở Task 1.2; verb chỉ orchestrate + format. Tên verb Phase 1 (`sentry_issues`…) là cụ thể-nguồn; tổng quát hoá thành `errors_*` khi thêm nguồn lỗi thứ 2.

```javascript
// mcp-diagnostic/src/handler/verb.handler.js
import { resolve } from '../registry/resolver.js';
import { dispatch } from '../sources/index.js';
import { formatSentryIssues, formatSentryIssue, formatLogs, formatDeploy } from '../helpers/format.helper.js';
// vd: const sources = resolve({ service: args.service, instance: args.instance, capability: 'logs' });
//     const events = (await Promise.all(sources.map(s => dispatch(s.sourceCfg, 'logs.search', args)))).flat();

const toolSentryIssues = {
    name: 'sentry_issues',
    description:
        'List unresolved Sentry error issues for a service, sorted by frequency. START HERE for any error/exception incident. Returns issue shortId (use with sentry_issue_detail), title, event count, last seen, culprit, and the release that introduced it.',
    inputSchema: {
        type: 'object',
        properties: {
            project: { type: 'string', description: 'Sentry project slug, e.g. sama-api.' },
            query: { type: 'string', description: 'Optional Sentry search, e.g. "level:error transaction:/api/..."' },
            statsPeriod: { type: 'string', enum: ['1h', '6h', '24h', '7d', '14d'], default: '24h' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
        required: ['project'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        try {
            const issues = await SentryService.listIssues(args);
            return { content: [{ type: 'text', text: formatSentryIssues(issues, args) }] };
        } catch (e) {
            console.error(e);
            return { content: [{ type: 'text', text: `error: ${e.message}` }] };
        }
    },
};

const toolSentryIssueDetail = {
    name: 'sentry_issue_detail',
    description:
        'Full detail of one Sentry issue: stacktrace, breadcrumbs, tags, frequency over time, first/last seen, and affected release. Call after sentry_issues to drill into the most relevant error.',
    inputSchema: {
        type: 'object',
        properties: { issueId: { type: 'string', description: 'Issue id/shortId from sentry_issues.' } },
        required: ['issueId'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        try {
            const [issue, event] = await Promise.all([
                SentryService.getIssue(args),
                SentryService.latestEvent(args),
            ]);
            return { content: [{ type: 'text', text: formatSentryIssue(issue, event) }] };
        } catch (e) {
            console.error(e);
            return { content: [{ type: 'text', text: `error: ${e.message}` }] };
        }
    },
};

const toolLogsSearch = {
    name: 'logs_search',
    description:
        'Search structured JSON logs of a service from Docker Swarm. Filter by level (error/warn/info), text grep, shop domain, and time window. Use to confirm a hypothesis from Sentry or find errors not captured by Sentry.',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name — validated & resolved qua inventory registry (KHÔNG enum mida hardcode).' },
            instance: { type: 'string', description: 'Optional: chỉ định 1 instance (vd api-2); bỏ trống = fan-out mọi instance của service.' },
            tenant: { type: 'string', description: 'Optional: shop domain → resolve shard (Phase 3+).' },
            since: { type: 'string', description: 'Docker --since, e.g. "30m", "2h", "2026-06-18T08:00:00".', default: '1h' },
            tail: { type: 'integer', minimum: 10, maximum: 5000, default: 500 },
            level: { type: 'string', enum: ['error', 'warn', 'info', 'debug', 'success'] },
            grep: { type: 'string', description: 'Case-insensitive substring on message.' },
            domain: { type: 'string', description: 'Shop domain filter.' },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        try {
            const logs = await LogsService.search(args);
            return { content: [{ type: 'text', text: formatLogs(logs, args) }] };
        } catch (e) {
            console.error(e);
            return { content: [{ type: 'text', text: `error: ${e.message}` }] };
        }
    },
};

const toolDeployRecent = {
    name: 'deploy_recent',
    description:
        'Correlate the incident with recent changes. Returns recent Jenkins builds and git commits for a service near the incident time. THE key RCA question is "what changed?" — call this early.',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name — resolve qua inventory registry tới jenkins/git source (KHÔNG enum hardcode).' },
            job: { type: 'string', description: 'Jenkins job name (optional; mặc định lấy từ inventory).' },
            since: { type: 'string', description: 'git --since, e.g. "2 days ago".', default: '2 days ago' },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        try {
            const [commits, builds] = await Promise.all([
                DeployService.recentCommits(args),
                args.job ? DeployService.recentBuilds(args).catch(() => null) : Promise.resolve(null),
            ]);
            return { content: [{ type: 'text', text: formatDeploy({ commits, builds }, args) }] };
        } catch (e) {
            console.error(e);
            return { content: [{ type: 'text', text: `error: ${e.message}` }] };
        }
    },
};

const tools = [toolSentryIssues, toolSentryIssueDetail, toolLogsSearch, toolDeployRecent];

const listTool = () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
});

const callTool = async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (tool) return await tool.execute({ args: request.params.arguments });
    return { content: [{ type: 'text', text: 'tool name not found.' }] };
};

const ToolHandler = { listTool, callTool };
export default ToolHandler;
```

- [ ] **Step 19: Commit** `feat: diagnostic MCP server with sentry/logs/deploy tools (phase 1)`.

### Task 1.4: CLI `diagnose` (chứng minh READ plane)

- [ ] **Step 20: `src/mcp-client/diagnostic.client.js`** — MCP Client kết nối tới diagnostic server, convert MCP tool defs → Anthropic tool defs.

```javascript
// src/mcp-client/diagnostic.client.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ENV } from '../config/env.js';

export async function connectDiagnostic() {
    const transport = new StreamableHTTPClientTransport(new URL(ENV.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${ENV.mcpToken}` } },
    });
    const client = new Client({ name: 'sama-orchestration', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    return client;
}

// MCP tool def -> Anthropic tool def (inputSchema -> input_schema)
export function toAnthropicTools(mcpTools) {
    return mcpTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}
```

- [ ] **Step 21: `src/cli/diagnose.js`** — gọi 1 tool trực tiếp để smoke test (chưa cần LLM).

```javascript
// src/cli/diagnose.js
import { connectDiagnostic } from '../mcp-client/diagnostic.client.js';

const [, , toolName, jsonArgs] = process.argv;
const client = await connectDiagnostic();
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

if (toolName) {
    const res = await client.callTool({ name: toolName, arguments: JSON.parse(jsonArgs || '{}') });
    console.log(res.content?.[0]?.text);
}
process.exit(0);
```

- [ ] **Step 22: Commit** `feat: MCP client + diagnose CLI`.

### Verify Phase 1
- [ ] `inventory.yaml` load + validate OK (resolver trả đúng source cho `service: api`).
- [ ] Chạy `mcp-diagnostic`: `cd mcp-diagnostic && pnpm dev` → `:7401`.
- [ ] `curl -s -X POST http://localhost:7401/mcp -H "Authorization: Bearer $MCP_OPS_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '[.result.tools[].name]'` → có `sentry_issues, sentry_issue_detail, logs_search, deploy_recent`.
- [ ] `pnpm diagnose sentry_issues '{"service":"api","statsPeriod":"24h"}'` → resolve qua inventory → ra issue thật (canonical envelope).
- [ ] `pnpm diagnose logs_search '{"service":"api","instance":"api-2","level":"error","since":"1h"}'` → log của đúng instance.
- [ ] `pnpm diagnose deploy_recent '{"service":"api"}'` → commit gần đây (resolve service→git/jenkins source).

---

## Phase 2 — Brain: Agentic investigate loop + Root Cause + Fix Plan

**Mục tiêu:** Đưa 1 `Incident` (nhập tay) → ra Fix Plan markdown có evidence citations.

**Thiết kế loop (cốt lõi của cả platform):** manual agentic loop với Anthropic SDK + diagnostic MCP tools.

```javascript
// src/orchestrator/investigate.js (skeleton)
import { anthropic, MODELS } from '../config/anthropic.js';
import { connectDiagnostic, toAnthropicTools } from '../mcp-client/diagnostic.client.js';
import { RCA_SYSTEM_PROMPT } from '../helpers/prompt.js';
import { redact } from '../security/redact.js';
import { auditToolCall } from '../security/audit.js';

const MAX_ITERS = 12;        // chặn loop vô hạn
const MAX_TOKENS_BUDGET = 400_000; // ngân sách input tokens cho 1 case

export async function investigate(incident, caseId) {
    const mcp = await connectDiagnostic();
    const { tools: mcpTools } = await mcp.listTools();
    const tools = toAnthropicTools(mcpTools);

    const messages = [{ role: 'user', content: buildOpeningPrompt(incident) }];
    let spent = 0;

    for (let i = 0; i < MAX_ITERS; i++) {
        const resp = await anthropic.messages.create({
            model: MODELS.REASON,                 // claude-opus-4-8
            max_tokens: 16000,
            thinking: { type: 'adaptive' },        // KHÔNG dùng budget_tokens
            output_config: { effort: 'high' },
            system: [{ type: 'text', text: RCA_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            tools,
            messages,
        });
        spent += resp.usage.input_tokens + (resp.usage.cache_read_input_tokens ?? 0);

        if (resp.stop_reason === 'end_turn') return collectFindings(resp, messages);
        if (resp.stop_reason !== 'tool_use') break;
        if (spent > MAX_TOKENS_BUDGET) { messages.push(budgetWarning()); continue; }

        messages.push({ role: 'assistant', content: resp.content });

        const toolResults = [];
        for (const block of resp.content) {
            if (block.type !== 'tool_use') continue;
            await auditToolCall(caseId, block.name, block.input);              // audit MỌI tool call
            const out = await mcp.callTool({ name: block.name, arguments: block.input });
            const text = redact(out.content?.[0]?.text ?? '');                 // scrub secret/PII
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: text });
        }
        messages.push({ role: 'user', content: toolResults });
    }
    return collectFindings(null, messages);
}
```

**Tasks Phase 2:**
- [ ] `helpers/prompt.js` — `RCA_SYSTEM_PROMPT` mã hoá methodology SRE: **symptom → timeline → hypotheses (ranked) → evidence → root cause (5 whys: phân biệt proximate vs root) → fix**. Yêu cầu: gọi `deploy_recent` sớm; tool use **parsimonious + hypothesis-driven** (không dump mù); mọi claim phải **falsifiable + cite evidence** (tool nào, dòng nào).
- [ ] `orchestrator/hypothesis.js` — hypothesis ledger (list giả thuyết + trạng thái confirmed/refuted/open + evidence refs).
- [ ] `orchestrator/rootcause.js` — Stage 3: structured output (`output_config.format`) ra object `RootCause{ statement, proximateCause, rootCause, evidence[], confidence, affectedFiles[] }`; rồi **adversarial verify**: 1 call Opus riêng với prompt "cố BÁC BỎ root cause này — nêu giả thuyết thay thế + bằng chứng phản bác"; nếu confidence tụt → quay lại investigate.
- [ ] `orchestrator/fixplan.js` — sinh Fix Plan markdown **đúng convention plan của team** (Goal / Architecture / File Map / Tasks-Steps-checkbox / Verify) + thêm: Risk level, Rollback steps, Verification (cách xác nhận đã fix), Affected files.
- [ ] `orchestrator/pipeline.js` — nối 4 stage; ghi `rca_runs` (trace).
- [ ] CLI `diagnose --incident <file.json>` → in Fix Plan ra `docs/fix-plans/<caseId>.md`.

**Verify Phase 2:** đưa 1 incident mẫu (vd "checkout API 500 sau 14:00") → Fix Plan có root cause + evidence cite được + rollback.

---

## Phase 3 — End-to-end: Mattermost ingest + Triage + Memory

- [ ] `ingest/adapter.interface.js` — `{ parse(payload) -> Incident, postReply(ref, markdown), onApproval(cb) }`.
- [ ] `ingest/mattermost.adapter.js` — verify webhook secret; parse post/thread → `Incident`; post Fix Plan trả channel; đọc reaction 👍/👎 (hoặc slash command `/rca-approve <caseId>`) làm approval signal.
- [ ] Stage 1 Triage (`MODELS.CLASSIFY` = Haiku): điền `symptoms/severity/affectedService/domain`, structured output `INCIDENT_TRIAGE_SCHEMA`.
- [ ] `memory/incident.memory.js`:
  - `recall(incident)` — tra `rca_incidents` (Mongo) theo keyword/tag/affectedService (Phase 5 nâng lên embeddings) → trả sự cố tương tự + fix cũ.
  - `remember(case)` — lưu `{ symptoms, signals, rootCause, fix, prUrl, outcome, resolvedAt }`.
  - Nếu recall thấy **recurrence** → short-circuit: đề xuất luôn fix cũ, giảm investigate.
- [ ] `src/index.js` `/webhook/mattermost` → chạy pipeline → post Fix Plan.

**Verify Phase 3:** post 1 ticket vào channel test → nhận lại Fix Plan kèm hướng dẫn duyệt.

---

## Phase 4 — WRITE plane: Executor handoff (gated)

- [ ] `executor/claude-code.runner.js`:
  1. **Chỉ chạy khi có approval** (event 👍/slash command) — gate cứng.
  2. `git worktree add` 1 branch mới `rca/<caseId>` trên repo đích (KHÔNG đụng main).
  3. Gọi **Claude Code headless**: truyền Fix Plan làm prompt, giới hạn tool/permission, chạy trong worktree.
     ```bash
     claude -p "$(cat docs/fix-plans/<caseId>.md)" \
       --add-dir <worktree> \
       --permission-mode acceptEdits \
       --output-format json
     ```
     > ⚠️ Xác nhận flag chính xác bằng `claude --help` (hoặc hỏi agent `claude-code-guide`) — tên flag có thể khác giữa version. Ý đồ: print/headless mode + giới hạn dir + chế độ permission an toàn.
  4. Chạy lint + test trong worktree; nếu fail → đính kèm output, KHÔNG mở PR, báo lại Mattermost.
  5. `git push` branch → mở PR (Bitbucket API) với mô tả = Fix Plan + link case. **Không auto-merge.**
  6. `memory.remember()` ghi lại outcome + prUrl.
- [ ] Audit: ghi mọi action write (branch, commit, push, PR) vào `audit`.

**Verify Phase 4:** duyệt 1 case low-risk → có branch + PR trong repo đích, test pass, không động main.

---

## Phase 5 — Hardening

- [ ] **Thêm source driver mới (sau cùng các generic verb, không sửa core)**: `mongo` (cap: events/db — read-only user), `clickhouse` (cap: events/metrics — SQL read-only, chặn DDL/`INSERT`), `rabbitmq` (cap: queue — management API: depth/DLQ/consumers), `redis` (cap: cache — INFO/SLOWLOG), `swarm` (cap: infra — ps/stats). Verb tương ứng: `events_query`, `db_query`, `metrics_query`, `queue_status`, `cache_status`, `infra_health`.
- [ ] **`events_query` heterogeneous (điểm khó nhất — idea 2)**: cùng verb, shard-1 → driver `mongo`, shard-2 → driver `clickhouse`; cả hai normalize về cùng envelope. Test: gọi `events_query{tenant:<domain>}` ra kết quả thống nhất dù shard nào.
- [ ] **Tenant→shard resolver**: nối `ProxyModel(domain)→proxy` vào `resolver.js` để verb tự route đúng shard theo `tenant` của Incident.
- [ ] **Correlation traceId**: thêm middleware propagate request/trace ID xuyên `sama-api`/recorder/... (tận dụng Sentry trace id), đẩy vào dòng log → verb merge evidence theo `traceId`.
- [ ] **Redaction** (`security/redact.js`): scrub token/JWT/email/card/connection-string khỏi mọi tool result trước khi vào model.
- [ ] **Audit** (`security/audit.js`): mọi tool call + action + token usage → `rca_runs`/`audit` collection.
- [ ] **Observability**: dashboard mỗi RCA run (tools gọi, hypotheses, verdict, tokens, cost, thời gian). Trace để cải thiện prompt.
- [ ] **Eval suite**: ≥10 sự cố quá khứ (biết root cause) → đo tỉ lệ agent tìm đúng root cause; chạy lại khi đổi prompt/model.
- [ ] **Caching**: Redis `getOrSetJson` (copy từ `sama-mcp`) cho tool result trong 1 case (vd Sentry issue list) để tiết kiệm.

---

## Security model (xuyên suốt)

| Lớp | Biện pháp |
|---|---|
| **Read/write separation** | Diagnostic MCP = process riêng, **DB user read-only**, không có write tool. Orchestrator không bao giờ ghi prod. |
| **Approval gate** | Claude Code **chỉ** chạy sau duyệt; chạy trong worktree/branch; ra PR, không auto-merge, không đụng main. |
| **Least privilege** | Sentry token read-only; Jenkins token read-only; Mongo read-only user; git repos clone read-only. |
| **Injection** | `execFile` (không shell) + allowlist service/repo cho mọi lệnh docker/git. |
| **Redaction** | Scrub secret/PII khỏi tool result trước khi vào LLM. |
| **Audit** | Log mọi tool call + mọi write action (ai/khi nào/cái gì). |
| **Auth** | MCP server sau ops bearer token; webhook Mattermost verify secret. |

---

## Memory model

- **Store:** Mongo `rca_incidents` (DB ops riêng). 1 doc / sự cố: `{ symptoms[], tags[], affectedService, rootCause, fix, prUrl, outcome, resolvedAt }`.
- **Recall:** keyword/tag/affectedService match (Phase 3) → embeddings similarity (Phase 5).
- **Compounding:** recurrence detection short-circuit chẩn đoán; thư viện root cause + fix lớn dần theo thời gian.
- (Đây là bản "production-incident" của ý tưởng file-based memory — mỗi sự cố là một bài học tái dùng.)

---

## Cost model (ước lượng, pricing 2026)

| Model | Input $/1M | Output $/1M | Dùng cho |
|---|---|---|---|
| `claude-opus-4-8` | $5 | $25 | Investigate loop, root cause, fix plan |
| `claude-sonnet-4-6` | $3 | $15 | Summarize log dài |
| `claude-haiku-4-5` | $1 | $5 | Triage/classify ticket |

Ước lượng **1 RCA run** (HITL, depth trung bình): triage (Haiku, nhỏ) + investigate (Opus, ~5–10 iteration; tool results lớn nhưng **prompt caching cắt ~10x** chi phí context lặp) + root cause + fix plan → khoảng **$0.5–$2 / sự cố**. So với hàng giờ công dev: ROI cao. Dùng `output_config:{effort}` để chỉnh thoroughness↔cost; bật `cache_control` trên system prompt + tool defs.

---

## Quyết định mở (cần xác nhận khi tới phase tương ứng)

1. **Authoring `inventory.yaml`**: liệt kê đầy đủ service → instance → shard → source (Sentry project slug, swarm service name + node, Mongo/CH conn theo shard nào). Đây là "bản đồ topology" — cần người rõ hệ thống điền (Phase 1, mở rộng dần).
2. **Nơi chạy `mcp-diagnostic`**: trên Swarm manager node (để `docker service logs` chạy được) hay qua Docker socket/SSH? (Phase 1 deploy).
3. **Approval UX trên Mattermost**: reaction 👍 hay slash command `/rca-approve`? (Phase 3).
4. **Bitbucket PR**: dùng API token nào, target branch nào (develop/main)? (Phase 4).
5. **Repos đích Claude Code được phép sửa**: v1 giới hạn `sama-api`? hay mở rộng? (Phase 4).
6. **Claude Code headless flags chính xác**: xác nhận `claude --help` / `claude-code-guide` (Phase 4).
7. **Correlation traceId**: có sẵn shared request/trace ID xuyên service chưa? Nếu chưa, thêm middleware nhẹ (tận dụng Sentry trace id) — quyết định ở Phase 5 (idea 3).
8. **Push escape hatch**: retention Sentry/log/CH hiện bao lâu? Nếu quá ngắn để điều tra sự cố cũ → cân nhắc mirror `error`+`warn` sang 1 ClickHouse rẻ (thêm 1 source, không phải pipeline). Ngưỡng cần xác nhận (Phase 5).

---

## Khởi động ngay

```bash
cd sama-orchestration
# Phase 0
pnpm init && pnpm add @anthropic-ai/sdk @modelcontextprotocol/sdk express cors dotenv mongoose
# ... thực thi Task 0.1 → 0.2 → Verify Phase 0 → Phase 1
```

Bắt đầu từ **Task 0.1**. Mỗi task commit riêng; chạy Verify cuối mỗi phase trước khi sang phase sau.
