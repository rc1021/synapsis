# Pipeline Spec — Multi-Step Workflow Orchestration

> Status: **Draft**
> Author: claude-api tool loop 完成後的下一步

## Overview

Pipeline 是排程 AI job 的進階版：把多個步驟串在一起，前一步的輸出自動餵給下一步。適用於需要「搜集 → 分析 → 格式化 → 通知」這類多階段工作流。

## 設計原則

1. **建立在現有基礎上** — 複用 scheduler、job-runner、user-job-scheduler、notifier
2. **使用者在 workspace `jobs.json` 定義** — 跟 job 共用同一個檔案，hot reload 自動生效
3. **步驟間資料傳遞用 `{{prev}}`** — 簡單直覺，大量資料改用檔案（AI 用 Read/Write 工具）
4. **不影響現有 job 功能** — pipeline 是新增，不是取代

## JSON 格式

```json
{
  "jobs": [ /* 現有 job，不變 */ ],
  "pipelines": [
    {
      "id": "daily-digest",
      "name": "每日早報",
      "schedule": "0 8 * * *",
      "enabled": true,
      "tier": "quick",
      "notify": { "when": "always" },
      "quietHours": { "start": 23, "end": 7 },
      "vars": {
        "TOPICS": "AI, TypeScript, 台灣科技"
      },
      "steps": [
        {
          "id": "research",
          "type": "ai",
          "tier": "standard",
          "prompt": "搜尋今日關於 {{TOPICS}} 的重要新聞，找 5-8 則，每則附上摘要。"
        },
        {
          "id": "format",
          "type": "ai",
          "prompt": "將以下新聞整理成早報格式（分類、emoji 標頭、每則 1-2 句）：\n\n{{prev}}"
        }
      ]
    }
  ]
}
```

### Pipeline 欄位

| 欄位 | 必填 | 說明 |
|------|------|------|
| `id` | Yes | 唯一識別碼 |
| `name` | Yes | 顯示名稱 |
| `schedule` | Yes | Cron 表達式 |
| `steps` | Yes | 步驟陣列（至少 1 個） |
| `enabled` | No | 預設 `true` |
| `tier` | No | 預設 tier（`quick`/`standard`/`deep`），步驟可覆蓋 |
| `notify` | No | 通知設定，同 job 格式 |
| `quietHours` | No | 靜音時段，同 job 格式 |
| `vars` | No | 自訂變數，可在 prompt 中用 `{{KEY}}` 引用 |

### Step 欄位

| 欄位 | 必填 | 說明 |
|------|------|------|
| `id` | Yes | 步驟 ID（pipeline 內唯一） |
| `type` | No | `ai`（預設） |
| `prompt` | Yes | AI prompt，支援 `{{prev}}`、`{{TIMESTAMP}}`、`vars` 中的變數 |
| `tier` | No | 覆蓋 pipeline 預設 tier |

## 模板變數

| 變數 | 說明 |
|------|------|
| `{{prev}}` | 上一步的文字輸出（第一步為空字串） |
| `{{TIMESTAMP}}` | 當前 ISO 時間戳 |
| `{{SPEC}}` | workspace SPEC 內容（如有） |
| `{{TALK_HISTORY}}` | 近期對話記錄（如有） |
| `{{KEY}}` | `vars` 中自訂的任何 key |

## 執行流程

```
Pipeline 觸發（cron）
  │
  ├─ 靜音時段檢查 → 跳過
  ├─ 併發鎖 → 同 pipeline 不重疊
  │
  ├─ Step 1: template replace → AI 執行 → 擷取 output
  │     ↓ output 存為 {{prev}}
  ├─ Step 2: template replace → AI 執行 → 擷取 output
  │     ↓
  ├─ Step N: ...
  │
  ├─ 收集 outbox/ 檔案（僅最後才收）
  ├─ 通知（最後一步的 output）
  └─ 清理 pipeline-data/
```

### 關鍵行為

1. **Outbox 只在最後收集** — 中間步驟可能寫檔給下一步讀，不能提早清掉
2. **中間資料用 `pipeline-data/<pipeline-id>/`** — 步驟間傳大量結構化資料時用
3. **併發鎖 key: `${wsId}:pipeline:${pipelineId}`** — 整條 pipeline 一個鎖
4. **失敗即停** — 任何步驟失敗，整條 pipeline 中止並通知錯誤摘要

### 錯誤通知格式

```
Pipeline "每日早報" failed at step 2/3 (format):
Error: Provider timeout after 60000ms

Completed steps:
  1. research (12.3s) — OK
  2. format — FAILED
```

## 安全限制

- `MAX_PIPELINE_STEPS = 10` — 單一 pipeline 最多 10 步
- Pipeline 總 timeout = 30 分鐘（不論步驟數）
- 每步的 AI 執行受 tier 對應的 timeout 限制
- 工具白名單與 user job 相同（Read, Write, Edit, Glob, Grep, Agent, WebSearch, WebFetch, TodoWrite）
- Bash 禁用

## 實作計畫

### Phase 1 — MVP

| 檔案 | 動作 | 說明 |
|------|------|------|
| `scheduler/src/pipeline-runner.js` | 新增 | 步驟迴圈、`{{prev}}` 注入、token 累計、錯誤摘要 |
| `scheduler/src/job-runner.js` | 修改 | 抽出 `_executeAIStep()`，新增 `runUserPipeline()` |
| `scheduler/src/user-job-scheduler.js` | 修改 | `_loadUserJobs` 也載入 pipelines，`_processEntry` 路由到 pipeline runner |
| `SYNC_PROMPT.md` | 修改 | 加入 pipeline 格式文件 |

### Phase 2 — 條件執行與錯誤策略

- `if` 條件：`"if": "{{prev}} != NO_NEWS"` — 跳過不需要的步驟
- `onError`: `"stop"` | `"skip"` | `"retry"`
- `maxRetries`: 每步重試次數
- 執行 log 寫到 `pipeline-data/<id>/last-run.json`

### Phase 3 — 進階

- `fetch` step type：不走 AI 的輕量 HTTP 抓取
- 成本追蹤：累計每步 token，記錄 pipeline 總花費
- `maxBudgetUsd`：pipeline 預算上限
- 手動觸發：Discord `/run-pipeline <id>`

### Phase 4 — 未來

- 平行步驟群組：`parallel: [step1, step2]`
- 失敗續跑：從上次失敗的步驟繼續
- 執行歷史：`pipeline-data/<id>/history.jsonl`
- 具名步驟參照：`{{steps.research.output}}` 取代 `{{prev}}`

## 範例 Pipelines

### 每日早報

```json
{
  "id": "daily-digest",
  "name": "每日早報",
  "schedule": "0 8 * * *",
  "tier": "quick",
  "notify": { "when": "always" },
  "vars": { "TOPICS": "AI, LLM, TypeScript, 台灣科技產業" },
  "steps": [
    {
      "id": "research",
      "tier": "standard",
      "prompt": "Current time: {{TIMESTAMP}}\n\n搜尋今日關於 {{TOPICS}} 最重要的新聞。找 5-8 則，每則附標題、來源、摘要。讀 USER.md 了解用戶興趣。"
    },
    {
      "id": "format",
      "prompt": "將以下新聞整理成早報：\n\n{{prev}}\n\n讀 USER.md 確認語言偏好。分類呈現、加 emoji 標頭、每則 1-2 句。結尾附一個思考問題。"
    }
  ]
}
```

### 競爭對手情報週報

```json
{
  "id": "competitor-intel",
  "name": "競爭對手情報週報",
  "schedule": "0 9 * * 1",
  "tier": "standard",
  "notify": { "when": "always" },
  "vars": { "COMPETITORS": "Cursor, GitHub Copilot, Windsurf" },
  "steps": [
    {
      "id": "gather",
      "prompt": "Current time: {{TIMESTAMP}}\n\n搜尋過去 7 天 {{COMPETITORS}} 的動態：產品更新、定價變化、公告、用戶評價。將原始發現寫到 outbox/competitor-raw.md。"
    },
    {
      "id": "analyze",
      "tier": "deep",
      "prompt": "讀 outbox/competitor-raw.md。分析：\n1. 各競品最重要的動作\n2. 跨競品趨勢\n3. 對用戶工作的影響（讀 USER.md）\n4. 每項發現標注急迫度（🔴高 🟡中 🟢低）\n\n輸出精簡的情報簡報。"
    }
  ]
}
```

### 股市新聞監控

```json
{
  "id": "stock-monitor",
  "name": "股市新聞監控",
  "schedule": "0 9,13,17 * * 1-5",
  "tier": "quick",
  "notify": { "when": "not_match", "match": "NO_ALERT" },
  "vars": { "WATCHLIST": "TSMC, NVIDIA, Apple, 台積電, 鴻海" },
  "steps": [
    {
      "id": "scan",
      "prompt": "Current time: {{TIMESTAMP}}\n\n搜尋過去 4 小時 {{WATCHLIST}} 的突發新聞。每則評分 1-10（市場影響、相關性、新穎性）。沒有值得注意的就輸出：NO_NEWS"
    },
    {
      "id": "alert",
      "prompt": "以下是評分後的新聞：\n\n{{prev}}\n\n若為 NO_NEWS 或沒有 7 分以上的項目，輸出：NO_ALERT\n\n否則只保留 7+ 分的項目，格式化為簡短警報：\n🔴 9-10 分\n🟡 7-8 分\n附上來源連結和影響分析。"
    }
  ]
}
```

### 內容創作流水線

```json
{
  "id": "weekly-content",
  "name": "週報內容產出",
  "schedule": "0 10 * * 5",
  "tier": "standard",
  "notify": { "when": "always" },
  "steps": [
    {
      "id": "research",
      "prompt": "讀 SEEDS.md 和近期 memory/*.md。找出 2-3 個用戶近期在思考的主題。對每個主題做網路搜尋找到最新背景資料。寫研究筆記到 outbox/content-research.md。"
    },
    {
      "id": "draft",
      "tier": "deep",
      "prompt": "讀 outbox/content-research.md 和 USER.md。選最強的主題寫一篇草稿（500-800 字）。參考 MEMORY.md 模仿用戶的寫作風格。包含研究數據。寫到 outbox/draft.md。"
    },
    {
      "id": "review",
      "tier": "quick",
      "prompt": "讀 outbox/draft.md。審查：事實準確度、語調一致性、可讀性、文法。輸出審查摘要與建議。"
    }
  ]
}
```

## 風險與對策

| 風險 | 對策 |
|------|------|
| AI 不遵守指示（沒寫檔、寫錯位置） | 用 `{{prev}}` 處理簡單情況；複雜情況靠 prompt 工程 |
| 成本爆炸（多步 × 高頻） | MAX_PIPELINE_STEPS=10、最小排程間隔建議 30 分 |
| Timeout 連鎖（5 步 deep = 50 分鐘） | Pipeline 總 timeout 30 分鐘上限 |
| Outbox 衝突（pipeline 和 job 同時跑） | Pipeline 中間資料用 `pipeline-data/`，outbox 只在最後才收 |

## 與現有系統的關係

```
scheduler/
├── src/
│   ├── index.js              # 不動 — 入口
│   ├── job-runner.js         # 修改 — 抽出 _executeAIStep, 加 runUserPipeline
│   ├── user-job-scheduler.js # 修改 — 載入/路由 pipelines
│   ├── pipeline-runner.js    # 新增 — 核心步驟迴圈
│   ├── notifier.js           # 不動 — 複用 notifyAllBindings
│   ├── state-manager.js      # 不動
│   └── logger.js             # 不動
├── jobs.json                 # 不動 — 系統 job
└── common-jobs.json          # 不動 — 事件觸發 job
```
