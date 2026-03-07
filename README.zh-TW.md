# Synapsis

[English](README.md) | [繁體中文](#) | [日本語](README.ja.md) | [한국어](README.ko.md)

> **實驗性專案 — 非用於生產或商業用途。**
>
> 本軟體僅供學習和個人實驗之用，按原樣提供。作者不對因使用、修改或部署本專案而產生的任何損害、費用或問題承擔任何責任。使用 Synapsis 即表示您同意完全自行承擔風險。您有責任遵守所有第三方 API 和平台的服務條款（包括但不限於 Anthropic、Discord、Google 和 OpenAI）。
>
> 完整條款請參閱 [LICENSE](LICENSE)。

一個與你一起成長的 AI 夥伴。

每一次對話都是一次突觸放電 —— 我們聊得越多，彼此就越聰明。

## 它做什麼

Synapsis 讓你的 AI 擁有持久的身份、記憶，以及主動聯繫你的能力。它不是聊天機器人 —— 而是一個在各種通訊平台上陪伴你的夥伴。

- **記住你** —— 每位使用者擁有獨立的工作空間，包含記憶、筆記和知識種子，跨對話持久保存
- **和你一起成長** —— 自動探索你關心的話題，澆灌知識種子，分享新發現
- **主動聯繫** —— 主動問候、閒置提醒和自然的引導對話，像朋友一樣而非通知
- **多頻道** —— 目前支援 Discord，Telegram 和 WhatsApp 開發中
- **AI 供應商無關** —— 一個環境變數切換 AI 後端：Claude API（預設），可擴展至 Gemini API、OpenAI API 等
- **多用戶** —— 每個人都有自己沙箱隔離的工作空間，獨立的記憶、種子和身份

## 運作方式

```
你 ←→ Discord（橋接）←→ 共用 Runner ←→ AI 供應商（API）
                              ↕
                        你的工作空間
                   ┌─────────────────────┐
                   │ CLAUDE.md  USER.md   │
                   │ SEEDS.md   MEMORY.md │
                   │ IDENTITY.md SOUL.md  │
                   │ memory/    jobs.json  │
                   └─────────────────────┘
```

當你傳送訊息給 bot 時，橋接層會將訊息透過共用 Runner 路由至 AI 供應商。AI 讀取你的工作空間檔案作為上下文，回應後更新你的記憶。排程任務（互動系統）在背景執行，隨時間深化關係。

## 開始使用

前置需求：**Node.js v22+**（[nodejs.org](https://nodejs.org)）

開始之前，請先準備：
1. **Anthropic API 金鑰** — 從 [console.anthropic.com](https://console.anthropic.com/) 取得
2. **Discord bot token** — 在 [Discord 開發者入口](https://discord.com/developers/applications) 建立（在 Bot → Privileged Gateway Intents 下啟用 **Message Content Intent**）

然後執行：

```bash
curl -fsSL https://raw.githubusercontent.com/rc1021/synapsis/refs/heads/main/install.sh | bash
```

安裝程式會下載最新版本、安裝依賴、詢問 API 金鑰和 Discord token，並自動啟動服務。

安裝程式會將 `synapsis` 指令加入 PATH。重啟 shell 或執行 `source ~/.zshrc` 即可使用。

服務啟動後，傳送私訊給你的 bot — 如果有回覆，就大功告成了！

### 服務管理

```bash
synapsis status    # 檢查執行狀態
synapsis logs      # 即時查看 log
synapsis restart   # 重啟服務
synapsis stop      # 停止服務
synapsis update    # 更新至最新版本
synapsis version   # 顯示目前版本
synapsis setup     # 重新設定 API 金鑰 / token
synapsis uninstall # 完整移除 synapsis
```

### 使用指南

#### Discord

**Bot 擁有者（首次設定）：**

1. 建立一個 Discord server（或使用現有的）
2. 透過 [Discord 開發者入口](https://discord.com/developers/applications) 的 OAuth2 連結邀請 bot 加入 server
3. 擁有者的工作空間會在第一次傳訊時自動建立（透過 `.env` 的 `SEED_USER` 設定）
4. 透過 DM 開始跟 bot 聊天 — 它會自我介紹並認識你

**邀請朋友：**

1. 在 Discord 執行 `/share-code` — 會同時取得：
   - **Synapsis 邀請碼**（24 小時，一次性使用）
   - **Server 邀請連結**（24 小時，一次性使用）
2. 把兩樣東西傳給朋友
3. 朋友點擊 server 邀請連結加入 server
4. Bot 會自動傳送歡迎 DM 給他們
5. 他們執行 `/connection <邀請碼>` 註冊並取得自己的工作空間
6. 完成！可以透過 DM 跟 bot 聊天了

**跨平台帳號綁定：**

如果使用者想在另一個平台（例如未來的 Telegram bridge）使用同一個工作空間：

1. 在已註冊帳號執行 `/bind-token` — 取得 5 分鐘一次性 token
2. 在另一個平台執行 `/bind <token>`
3. 兩個帳號現在共享同一個工作空間、記憶和身份

**指令列表：**

| 指令 | 說明 |
|------|------|
| `/help` | 顯示可用指令 |
| `/new` 或 `/reset` | 開始新對話（清除目前 session） |
| `/connection <code>` | 用邀請碼註冊 |
| `/share-code` | 產生邀請碼 + server 邀請連結 |
| `/bind-token` | 產生跨平台綁定 token |
| `/bind <token>` | 將此帳號綁定到已有的工作空間 |

> 所有指令說明皆已本地化 — 會依你的 Discord 語系自動顯示（English、繁體中文、简体中文、日本語、한국어）。

#### Telegram（規劃中）

尚未開放。將支援類似 Discord 的 `/command` 斜線指令。

#### WhatsApp（規劃中）

尚未開放。WhatsApp 沒有斜線指令系統，將使用自然語言或關鍵字觸發（例如傳送 `HELP` 查看可用功能）。

## 設定

所有設定在 `app/.env`：

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `DISCORD_TOKEN` | Discord bot token（必填）| — |
| `AI_PROVIDER` | AI 後端（參見下方供應商列表）| `claude-api` |
| `ANTHROPIC_API_KEY` | Anthropic API 金鑰（`claude-api` 必填）| — |
| `MAX_CONCURRENCY` | 最大並行 AI 行程數 | `3` |
| `CLAUDE_TIMEOUT` | 每次請求硬超時（毫秒）| `300000`（5 分鐘）|
| `SESSION_TTL_MINUTES` | Session 過期時間 | `60` |
| `COMPACT_THRESHOLD` | Session 輪換的 token 門檻 | `80000` |
| `SECURITY_ADMIN_ID` | 接收安全警報的 Discord 使用者 ID | — |

## 架構

```
app/
├── bridges/
│   ├── shared/
│   │   ├── providers/        # AI 供應商抽象層
│   │   │   ├── base.js       # BaseProvider + StreamHandle（EventEmitter）
│   │   │   ├── registry.js   # 供應商註冊（延遲初始化工廠）
│   │   │   └── claude-api.js # Claude API 供應商（@anthropic-ai/sdk）
│   │   ├── runner.js         # 共用 Runner（每 workspace 佇列、逾時、安全）
│   │   ├── workspace-manager.js  # 多 workspace CRUD、綁定、索引
│   │   └── security-monitor.js   # 工具呼叫違規偵測器
│   └── discord/              # Discord 橋接
├── scheduler/
│   ├── common-jobs.json      # 互動任務定義
│   ├── jobs.json             # 系統維護任務
│   └── src/
│       ├── job-runner.js     # Shell + AI 任務執行器
│       └── user-job-scheduler.js  # 每用戶事件驅動排程器
├── workspace-template/       # 新使用者工作空間範本
└── workspaces/data/          # 每用戶沙箱工作空間
```

### 新增供應商

供應商層支援任何提供 API 的 AI 後端。建立 `providers/xxx.js`，繼承 `BaseProvider`，實作 `run()` + `runStream()`，在 `registry.js` 註冊。

目前支援：

| 供應商 | `AI_PROVIDER` | 需要的環境變數 | 狀態 |
|--------|---------------|---------------|------|
| Anthropic（Claude）| `claude-api` | `ANTHROPIC_API_KEY` | 預設 |
| Gemini | `gemini-api` | `GOOGLE_API_KEY` | 規劃中 |
| OpenAI | `openai-api` | `OPENAI_API_KEY` | 規劃中 |

> **關於 CLI 類供應商：**
> 部分 AI 服務也提供 CLI 工具（如 Claude CLI、Gemini CLI、Codex CLI）。Synapsis 包含 CLI 類供應商的實驗性支援，適用於個人開發和測試。CLI 供應商受各廠商服務條款約束 — 大多數 CLI 工具僅授權個人使用，可能不適合多用戶部署。如需使用 CLI 供應商，請將 `AI_PROVIDER` 設為對應的 CLI 供應商名稱（如 `claude-cli`），並確保該 CLI 工具已安裝並完成認證。

### 互動系統

基於使用者活動觸發的事件驅動任務 — 而非 cron 計時器：

| 任務 | 觸發條件 | 做什麼 |
|------|----------|--------|
| 引導對話 | USER.md 有空白欄位 | 透過自然對話認識新使用者 |
| 種子澆灌 | 累積 30+ 行對話 | 深入探討對話中的話題，建立知識筆記 |
| 主動問候 | 每日，若最近 7 天有活動 | 引用近期脈絡的隨意訊息 |
| 閒置問候 | 3 天未互動 | 溫和的提醒，不帶罪惡感 |
| 探索分享 | 每 5 天 | 搜尋符合使用者興趣的新聞和文章 |

### 工作空間結構

每位使用者擁有獨立的沙箱工作空間：

```
workspaces/data/<user-id>/
├── CLAUDE.md      # Agent 指令（行為、安全規則）
├── USER.md        # 關於使用者（名稱、語言、興趣、時區）
├── SOUL.md        # Agent 的性格和價值觀
├── IDENTITY.md    # Agent 的名字、表情符號、風格
├── SEEDS.md       # 知識種子 — 待探索的話題
├── MEMORY.md      # 長期精選記憶
├── memory/        # 每日筆記（YYYY-MM-DD.md）
└── jobs.json      # 使用者自訂任務
```

### 安全

多用戶沙箱工作空間的 6 層防禦：

1. **作業系統層沙箱** — macOS `sandbox-exec` / Linux `firejail` 限制檔案系統和網路
2. **權限旗標** — 限制性權限僅在沙箱內使用
3. **工具白名單** — 每個工作空間限定允許的工具集
4. **系統提示詞規則** — `BASE_RULES` 跨所有頻道強制執行
5. **同步提示詞注入防護** — `SYNC_PROMPT.md` 防止工作空間逃逸
6. **執行時安全監控** — 偵測工具呼叫違規並發送警報

完整威脅模型和架構請參閱 [SECURITY.md](SECURITY.md)。

## 授權

MIT — 參閱 [LICENSE](LICENSE)
