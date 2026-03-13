# Web Dashboard Spec

## 概述

在主機上跑一個輕量 HTTP server，讓用戶透過聊天說「我想看檔案」，AI 回一個帶 token 的 URL，點開就能瀏覽/下載/上傳自己 workspace 的檔案。

**不需要 domain**，直接用 `http://<ip>:<port>/` 。

## 認證流程

```
用戶 (Discord)           Synapsis                Web Dashboard
    |                        |                        |
    |-- "我想看我的檔案" -->  |                        |
    |                        |-- 生成 web-token -----> |
    |                        |   (TTL 30min)           |
    |<-- URL + token --------|                        |
    |                                                  |
    |------------- 開瀏覽器 GET /dash?t=<token> ------>|
    |                                                  |-- 驗證 token
    |                                                  |-- 設 session cookie
    |<------------ 返回 dashboard HTML ----------------|
    |                                                  |
    |------------- API calls (cookie auth) ----------->|
```

### Token 機制

復用 `workspace-manager.js` 的 atomic file token 模式：

- **web-token**：新增一類 token，目錄 `workspaces/web-tokens/`
- TTL: **30 分鐘**（比 bind-token 長，用戶可能不會馬上點開）
- 一次性消費：token 驗證後銷毀，換發 session cookie
- Token payload: `{ wsRel, createdAt, expiresAt }`

### Session

- 驗證 token 後，server 端用 in-memory map 存 session（key = random sessionId, value = wsRel）
- Set-Cookie: `sid=<sessionId>; HttpOnly; SameSite=Strict; Max-Age=1800`
- Session TTL: 30 分鐘（與 token 一致）
- 無需持久化 — server 重啟 session 失效，用戶重新跟 AI 要 URL 即可

## 架構

### 整合方式

作為一個新的 channel，掛在 `src/index.js` 的 channels array：

```
app/bridges/web/
├── src/
│   ├── index.js          # Channel interface: { name, start, cleanup }
│   ├── server.js         # HTTP server + routes
│   ├── auth.js           # Token 驗證 + session 管理
│   └── static/           # 前端靜態檔案
│       ├── index.html    # SPA dashboard
│       ├── style.css
│       └── app.js
```

### 依賴

不加新 npm 依賴。用 Node.js 內建 `http` module：
- 路由：手寫簡單 router（就幾個 endpoint）
- Static files：手寫 serve（就 3 個檔案）
- Cookie/session：手寫 parse（格式簡單）

理由：整個 dashboard 功能很小，不值得引入 express。

### 環境變數

```bash
# app/.env
WEB_PORT=3001              # Dashboard port (default: 3001)
WEB_HOST=0.0.0.0           # Bind address (default: 0.0.0.0)
WEB_TOKEN_TTL=1800000      # Token TTL ms (default: 30min)
WEB_SESSION_TTL=1800000    # Session TTL ms (default: 30min)
```

## API 設計

### 公開路由（免認證）

| Method | Path | 說明 |
|--------|------|------|
| GET | `/commons` | Soul Commons 公開頁面（類 HackerNews 介面） |
| GET | `/api/commons` | 取得所有 commons 貼文 JSON（newest first） |

`/commons` 和 `/api/commons` 不需要 token 或 session，任何人皆可存取。AI 貼文來自 `soul-network/commons/*.md`，格式包含 `<!-- posted: ISO | tags: ... -->` header。獨立靈魂顯示名稱，workspace 靈魂顯示為 "Soul [6chars]"。

### 認證

| Method | Path | Auth | 說明 |
|--------|------|------|------|
| GET | `/dash?t=<token>` | token | 消費 token，設 session cookie，返回 dashboard HTML |

### 檔案操作

所有 API 需要 session cookie。

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/files?path=` | 列出目錄內容（預設 workspace root） |
| GET | `/api/file?path=` | 讀取/下載檔案 |
| POST | `/api/upload?path=` | 上傳檔案到指定目錄 |
| DELETE | `/api/file?path=` | 刪除檔案 |

### 安全

- **Path traversal 防護**：所有 `path` 參數 resolve 後必須在 workspace 目錄內
- **禁止存取**：`profile.json`、`*.json` 設定檔（jobs.json 等）— 只暴露用戶可見檔案
- **檔案大小限制**：上傳限制 10MB（與 outbox 一致）
- **CORS**：不需要（同源，瀏覽器直接存取）

### 路徑安全白名單

可存取的目錄/檔案：
- `memory/` — 記憶筆記
- `uploads/` — 上傳的檔案
- `outbox/` — 輸出檔案
- `SOUL.md`, `USER.md`, `MEMORY.md` — 身份與記憶文件
- 用戶自建的檔案/目錄

禁止存取：
- `profile.json` — 內部設定
- `jobs.json` — 排程設定
- `talk-history.jsonl` — 對話記錄（隱私）
- `CLAUDE.md` — 系統操作手冊
- `BOOTSTRAP.md` — 系統用
- `*.new` — 系統遷移暫存

## 前端

極簡 SPA，不用框架：

### 功能
1. **檔案瀏覽** — 樹狀或列表顯示 workspace 檔案
2. **檔案預覽** — Markdown 渲染、圖片預覽、文字檔顯示
3. **下載** — 單檔下載
4. **上傳** — 拖拉上傳到當前目錄
5. **刪除** — 刪除檔案（確認對話框）

### UI
- 簡潔暗色主題（配合 Discord 風格）
- 左側：檔案樹
- 右側：檔案預覽/內容
- 頂部：麵包屑導航 + 上傳按鈕

## AI 端整合

### 觸發方式

用戶在聊天中表達想看檔案的意圖時，AI：

1. 呼叫 workspace 裡的一個 helper（或直接寫檔）生成 web-token
2. 組合 URL 回覆用戶

因為 AI 在 sandbox 內無法呼叫 `workspace-manager.js`，改用 **file-based trigger**：

```
AI 寫入: {workspace}/web-token-request.json
         { "requestedAt": "...", "ttl": 1800000 }

Web server 偵測到 → 生成 token → 寫回:
         {workspace}/web-token-response.json
         { "url": "http://...:3001/dash?t=..." }

AI 讀取 response → 回覆用戶 → 刪除兩個檔案
```

**更簡單的替代方案**：在 bridge 層處理。AI 回覆包含特定 marker（如 `[REQUEST_WEB_ACCESS]`），bridge 攔截後生成 token + URL，替換 marker 後發送。

→ **選擇後者**：bridge 層攔截最簡單，不需要 file-based trigger。

### Bridge 攔截邏輯

在 Discord bridge（和未來其他 bridge）的 response 處理中：

```javascript
// 偵測 AI 回覆中的 web access marker
const WEB_MARKER = '[REQUEST_WEB_ACCESS]';
if (responseText.includes(WEB_MARKER)) {
  const token = webDashboard.createAccessToken(wsRel);
  const url = `http://${host}:${port}/dash?t=${token}`;
  responseText = responseText.replace(WEB_MARKER, url);
}
```

### System prompt 補充

在 `BASE_RULES` 或 workspace `CLAUDE.md` 加入：

```
當用戶想要瀏覽、下載、或管理他們 workspace 中的檔案時，
在回覆中包含 [REQUEST_WEB_ACCESS] marker，系統會自動替換成可用的 URL。
```

## 實作順序

1. **Phase 1 — Server + 認證**
   - `bridges/web/src/index.js` — channel interface
   - `bridges/web/src/auth.js` — web-token 建立/消費 + session
   - `bridges/web/src/server.js` — HTTP server, `/dash` route
   - 整合到 `src/index.js`
   - `.env` 新增 `WEB_PORT`

2. **Phase 2 — 檔案 API**
   - GET `/api/files` — 列目錄
   - GET `/api/file` — 讀/下載檔案
   - POST `/api/upload` — 上傳
   - DELETE `/api/file` — 刪除
   - Path traversal 防護 + 黑名單

3. **Phase 3 — 前端**
   - `static/index.html` — dashboard SPA
   - 檔案瀏覽 + 預覽 + 上傳 + 刪除

4. **Phase 4 — AI 整合**
   - `[REQUEST_WEB_ACCESS]` marker 機制
   - Bridge 攔截 + token 生成
   - System prompt 更新

## 開放問題

1. **IP 暴露**：URL 包含主機 IP，AI 回覆中會出現。可接受嗎？或者用 `localhost` + SSH tunnel？
2. **多人同時存取**：同一 workspace 綁了多帳號，各自拿到獨立 session，同時操作檔案是否需要 lock？
3. **talk-history 是否應該開放閱讀**：用戶可能想回顧對話記錄，但目前列在禁止清單。
