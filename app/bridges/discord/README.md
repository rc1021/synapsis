# Discord Bridge

Discord bot 橋接本機 Claude CLI，讓 Discord 訊息透過 `claude -p` 取得回覆。

## 前置需求

- Node.js v22+
- Claude CLI (`claude`) 已安裝（預設路徑 `/Users/rc1021/.local/bin/claude`）
- Discord Bot Token（從 [Discord Developer Portal](https://discord.com/developers/applications) 取得）

## 安裝

```bash
cd discord-bridge
npm install
cp .env.example .env
# 編輯 .env，填入 DISCORD_TOKEN
```

## 設定 (.env)

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `DISCORD_TOKEN` | Discord Bot Token（必填） | — |
| `ALLOW_FROM` | 白名單，逗號分隔 user ID 或 guild ID | — |
| `CLAUDE_PATH` | Claude CLI 路徑 | `/Users/rc1021/.local/bin/claude` |
| `CLAUDE_CWD` | Claude 工作目錄 | `/Users/rc1021/projects/synapsis` |
| `SESSION_TTL_MINUTES` | Session 過期時間（分鐘） | `60` |
| `MAX_CONCURRENCY` | 最大同時 Claude 行程數 | `1` |
| `CLAUDE_TIMEOUT` | Claude 超時（毫秒） | `300000` (5 min) |

## 執行

### 手動啟動

```bash
npm start
```

### 以 launchd 背景服務運行（macOS）

```bash
# 複製 plist 到 LaunchAgents
cp com.synapsis-discord-bridge.plist ~/Library/LaunchAgents/

# 載入服務（開機自動啟動）
launchctl load ~/Library/LaunchAgents/com.synapsis-discord-bridge.plist

# 停止服務
launchctl unload ~/Library/LaunchAgents/com.synapsis-discord-bridge.plist

# 查看狀態
launchctl list | grep discord-bridge
```

Log 位置：`logs/discord-bridge.log`

## 功能

- DM 或 @mention 觸發 Claude 回覆
- `/new`、`/reset` — 重設對話 session
- `!reset` — 舊版文字指令（仍可用）
- 同一 DM/thread/channel 自動延續對話（session resume）
- 過期 session 自動清除並重建
- 每則回覆尾巴顯示 session ID 前 8 碼
- Code fence 跨頁自動閉合/重開（Discord 2000 字限制）

## 檔案結構

```
discord-bridge/
├── src/
│   ├── index.js            # Discord client、訊息處理、slash commands
│   ├── claude-runner.js    # spawn claude -p、queue 機制
│   ├── session-store.js    # session 管理、TTL、持久化
│   ├── message-splitter.js # 訊息分頁、code fence 處理
│   └── logger.js           # logging
├── .env.example            # 環境變數範本
├── .env                    # 實際設定（git ignored）
├── com.synapsis-discord-bridge.plist  # macOS launchd 設定
└── package.json
```
