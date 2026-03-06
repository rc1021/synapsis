# Scheduler

Node.js cron daemon，讀 `jobs.json` 執行排程任務（shell / claude 兩種類型）。

## 安裝

```bash
cd scheduler
npm install
cp .env.example .env  # 視需要修改路徑
```

## 手動執行

```bash
node src/index.js
```

應看到：
```
Scheduled: heartbeat [*/30 * * * *]
Scheduled: git-sync [0 9-23 * * *]
Scheduler running with 2 job(s)
```

## 安裝為 launchd 服務

```bash
cp com.synapsis-scheduler.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.synapsis-scheduler.plist
```

驗證：
```bash
launchctl list | grep scheduler
```

停止 / 移除：
```bash
launchctl unload ~/Library/LaunchAgents/com.synapsis-scheduler.plist
```

## 檔案結構

| 檔案 | 用途 |
|------|------|
| `jobs.json` | 排程任務定義 |
| `src/index.js` | 入口：載入 jobs、cron 排程、signal handling、hot reload |
| `src/job-runner.js` | 執行引擎（shell / claude）、concurrency lock、quiet hours |
| `src/notifier.js` | Discord 通知（呼叫 `channels/{via}.sh`） |
| `src/logger.js` | 帶 rotation 的 log（上限 3000 行） |
| `.env.example` | 環境變數範本 |

## jobs.json 格式

```jsonc
{
  "id": "my-job",         // 唯一 ID
  "name": "描述",
  "type": "shell|claude",
  "schedule": "*/30 * * * *",  // cron 5-field
  "enabled": true,
  "once": false,           // true = 執行一次後自動停用
  "quietHours": { "start": 23, "end": 8 },  // 可選，跳過時段
  "timeout": 60000,       // ms，預設 shell=60s / claude=120s
  "maxRetries": 0,        // 失敗重試次數

  // type=shell
  "shell": { "command": "echo hello" },

  // type=claude
  "claude": {
    "model": "haiku",
    "prompt": "...",
    "maxBudgetUsd": 1.0
  },

  // 通知規則（可選）
  "notify": {
    "when": "always|error|not_match",
    "match": "HEARTBEAT_OK",  // when=not_match 時比對
    "via": "discord"
  }
}
```

## Hot Reload

修改 `jobs.json` 後會自動偵測並重新載入，不需重啟。

## 一次性任務

設 `"once": true` 的 job 執行完後會自動將 `enabled` 設為 `false`，適合一次性提醒或單次任務。Job 定義會保留在 `jobs.json` 中作為記錄。

範例：
```jsonc
{
  "id": "remind-dentist",
  "name": "提醒看牙醫",
  "type": "claude",
  "schedule": "0 9 5 3 *",  // 3月5日 09:00
  "once": true,
  "claude": {
    "model": "haiku",
    "prompt": "發送提醒：今天下午 3 點要去看牙醫"
  },
  "notify": { "when": "always", "via": "discord" }
}
```

## Log

- 位置：`scheduler/logs/scheduler.log`
- 自動 rotation，超過 3000 行時裁剪
