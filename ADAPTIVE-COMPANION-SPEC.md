# Adaptive Companion Spec — Synapsis 2.0

> Status: **Draft**
> 目標：讓 AI 夥伴從「定時腳本」進化成「因人而異、自我調整的成長夥伴」

---

## 設計哲學

每一次對話都是一次突觸放電 — 我們聊得越多，彼此就越聰明。

系統圍繞三條主線設計，所有 job 都必須服務至少一條：

| 主線 | 目標 | 衡量方式 |
|------|------|----------|
| **關係** | 連續感、被理解、情感連結 | 用戶主動開話題的頻率、回應速度 |
| **能力** | AI 累積對用戶的理解，越來越精準 | style-calibration 準確度、callback 命中率 |
| **成長** | 用戶專業更深、能力邊界更大 | seed 深度進展、用戶對 challenge 的 engagement |

---

## 第一層：基礎設施

在新增任何 job 之前，先建立讓所有 job 「自適應」的底座。

### 1.1 Conversation Policy（共用對話策略）

**問題：** 現在每個 job prompt 各自定義語氣、風格、規則，重複且不一致。

**方案：** 抽出 `conversation-policy.md`，所有 event job prompt 透過 `{{CONVERSATION_POLICY}}` 注入。

```markdown
# Conversation Policy

## 核心原則
- 先反映，再追問：用自己的話 summarize 用戶說的，讓他感覺被聽懂，再問開放式問題
- 建立故事線：事件 → 感受 → 意義 → 下一步，不要每次都是獨立問題
- 把成長顯性化：偶爾指出用戶的變化（「跟上個月比，你處理這類事冷靜很多」）
- 匹配用戶風格：長度、正式度、emoji 習慣都參考 USER.md 的 communication style

## 互動原則
- 短小精悍：主動訊息 1-3 句，有興趣再展開
- 不要像機器人：不要 "I noticed..."、不要提到排程/自動化
- 一次一個問題：不要連問三個
- Context-aware：深夜輕鬆、工作時間專業、週末隨意
```

**實作：**
- 檔案位置：`app/scheduler/specs/conversation-policy.md`
- `_runEventJob()` 讀取後注入 `job._conversationPolicy`
- `templateReplace()` 支援 `{{CONVERSATION_POLICY}}`
- 每個 event job prompt 尾部加 `{{CONVERSATION_POLICY}}`

**改動範圍：**
- `user-job-scheduler.js` — `_runEventJob()` 讀 conversation-policy.md
- `job-runner.js` — `templateReplace()` 加 `CONVERSATION_POLICY`

---

### 1.2 preferences.json（per-workspace 參數覆蓋）

**問題：** `common-jobs.json` 的參數（minLines、intervalDays）對所有用戶一樣。

**方案：** 每個 workspace 可以有 `preferences.json`，AI 自己寫入，scheduler 讀取時合併覆蓋。

```json
{
  "seedWatering": {
    "minLines": 45,
    "reason": "用戶聊天頻繁但多為日常問候，提高門檻避免空轉"
  },
  "proactive": {
    "intervalDays": 2,
    "preferredHours": [9, 13, 19],
    "reason": "用戶偏好早上和晚上回覆，中午常忙"
  },
  "discovery": {
    "intervalDays": 3,
    "reason": "用戶對 discovery 回覆率高，縮短間隔"
  },
  "communicationStyle": {
    "messageLength": "short",
    "formality": "casual",
    "emojiUsage": "moderate",
    "updatedAt": "2026-03-09T10:00:00Z"
  }
}
```

**實作：**
- `_checkTrigger()` 讀 workspace 的 `preferences.json`，有覆蓋值就用，沒有就 fallback common-jobs 預設
- AI 在 seed-watering 和 self-tune job 中可寫入此檔
- 加 guardrails：`preferences-bounds.json` 定義每個參數的 min/max

```json
{
  "seedWatering.minLines": { "min": 10, "max": 200 },
  "proactive.intervalDays": { "min": 1, "max": 14 },
  "discovery.intervalDays": { "min": 2, "max": 30 },
  "idleCheckin.idleDays": { "min": 2, "max": 14 }
}
```

**改動範圍：**
- `user-job-scheduler.js` — `_checkTrigger()` 讀 `preferences.json` 並合併
- 新增 `app/scheduler/preferences-bounds.json`

---

### 1.3 Engagement Tracking（互動效果追蹤）

**問題：** 目前不知道 job 發出的訊息用戶有沒有回、回了什麼品質。

**方案：** 在 Discord bridge 追蹤 job 發出訊息後的用戶回應。

每次 job 透過 notifier 發訊息時，記錄一個 pending engagement entry。當用戶在該 channel 回覆時，更新 entry。

```jsonl
{"jobId":"proactive","ts":"2026-03-09T09:00:00Z","responded":true,"responseDelayMs":3600000,"responseLength":45,"engagement":"medium"}
{"jobId":"discovery","ts":"2026-03-08T14:00:00Z","responded":false,"engagement":"none"}
{"jobId":"challenge","ts":"2026-03-07T10:00:00Z","responded":true,"responseDelayMs":900000,"responseLength":200,"engagement":"high"}
```

Engagement 分級：
- `high` — 回覆 > 50 字 或 問了後續問題
- `medium` — 回覆 10-50 字
- `low` — 回覆 < 10 字（「好」「收到」「ok」）
- `none` — 24 小時內未回覆

**檔案：** `{workspace}/engagement.jsonl`

**實作：**
- `notifier.js` — 發訊息後寫 pending entry（jobId、timestamp、messageId）
- Discord bridge `index.js` — 收到用戶訊息時，檢查是否 match 最近的 pending entry，更新 engagement
- Engagement 分級邏輯放在 bridge 層（不同 bridge 可能有不同判斷方式）

**改動範圍：**
- `notifier.js` — 寫 pending entry
- `bridges/discord/src/index.js` — 回覆匹配 + engagement 更新
- 新增 `bridges/shared/engagement.js` — 共用讀寫邏輯

---

## 第二層：新 Jobs

基礎設施到位後，按主線和優先級新增。所有新 job 放進 `common-jobs.json` 的 `eventJobs` 陣列。

### Phase 1 — 高優先（基礎設施完成後立即可做）

#### 2.1 `self-tune`（自我調整）

> 主線：**能力**

meta-job：每週讀 engagement 數據，分析效果，調整 preferences.json。

```json
{
  "id": "self-tune",
  "name": "Self-tuning review",
  "tier": "standard",
  "trigger": {
    "type": "proactive",
    "intervalDays": 7,
    "activeDays": 30
  },
  "prompt": "..."
}
```

**Prompt 要點：**
1. 讀 `engagement.jsonl`，計算每種 job 的回應率
2. 讀 `preferences.json`（如果存在）
3. 分析模式：
   - 哪些 job 用戶愛回？（加頻）
   - 哪些被忽略？（降頻或換風格）
   - 用戶通常幾點回覆？（調 preferredHours）
   - 用戶回覆長度/風格？（更新 communicationStyle）
4. 寫出更新後的 `preferences.json`，每個改動附 reason
5. 輸出一段簡短的自我反思（不發給用戶，只是 log）

**不發訊息給用戶。** `notify: { "when": "error" }`

---

#### 2.2 `weekly-synthesis`（每週回顧）

> 主線：**關係 + 成長**

每週連結不同天的對話，發現跨時間的模式。

```json
{
  "id": "weekly-synthesis",
  "name": "Weekly synthesis",
  "tier": "deep",
  "trigger": {
    "type": "proactive",
    "intervalDays": 7,
    "activeDays": 14
  },
  "requires": "SEEDS.md",
  "prompt": "..."
}
```

**Prompt 要點：**
1. 讀最近 7 天的 `memory/YYYY-MM-DD.md`
2. 讀 `SEEDS.md`、`talk-history-archive/` 最近的檔案
3. 產出週回顧：
   - 這週的對話主題概覽
   - 跨天/跨話題的 pattern（「你這週三次提到 X」）
   - 未解決的問題或承諾
   - 1-2 個 seed 的進展觀察
   - 下週建議探索的方向
4. 寫檔到 `memory/weekly/YYYY-WNN.md`
5. 發精簡版給用戶（3-5 bullet points + 一個開放問題）

---

#### 2.3 `challenge`（蘇格拉底提問）

> 主線：**成長**

對用戶最近學的東西拋出反面觀點或深度提問，實現 ZPD。

```json
{
  "id": "challenge",
  "name": "Socratic challenge",
  "tier": "standard",
  "trigger": {
    "type": "proactive",
    "intervalDays": 3,
    "activeDays": 7
  },
  "requires": "SEEDS.md",
  "prompt": "..."
}
```

**Prompt 要點：**
1. 讀 `SEEDS.md` 和最近的 `memory/learning/` 筆記
2. 找一個用戶最近在學的主題
3. 提出 ONE 個有深度的問題或反面觀點：
   - 不是 quiz（不是「X 是什麼？」）
   - 而是「你寫了 X，但如果 Y 的情況下，X 還成立嗎？」
   - 或「你提到 A 和 B，它們之間有沒有矛盾？」
4. 保持尊重但有挑戰性 — 像一個好的導師
5. 如果用戶最近沒有新學習，output `_SKIP`

---

#### 2.4 `callback`（追蹤跟進）

> 主線：**關係**

追蹤用戶提到的未來計畫/事件，到時候主動跟進。

```json
{
  "id": "callback",
  "name": "Callback follow-up",
  "tier": "standard",
  "trigger": {
    "type": "callback"
  },
  "prompt": "..."
}
```

**這個需要兩個部分：**

**A. 對話時提取（bridge 層）：**

在 Discord bridge 的 `claude-runner.js`，當 AI 回覆完成後，用一個輕量 prompt（或 regex）檢查對話是否包含未來意圖：
- 「明天要...」「下週...」「週四有...」「打算...」「計畫...」
- 提取並寫入 `pending-callbacks.json`

```json
[
  {
    "id": "uuid",
    "extracted": "2026-03-09T15:00:00Z",
    "targetDate": "2026-03-13",
    "topic": "週四的面試",
    "context": "用戶說下週四有一個重要面試，很緊張",
    "followedUp": false
  }
]
```

**B. Scheduler 觸發（新 trigger type）：**

`_checkTrigger` 新增 `callback` type：讀 `pending-callbacks.json`，檢查是否有 `targetDate <= today && !followedUp` 的項目。

**Prompt 要點：**
1. 讀到期的 callback item
2. 讀 USER.md 和最近對話
3. 自然地跟進：「嘿，你週四那個面試怎麼樣了？」
4. 跟進完後標記 `followedUp: true`

**改動範圍：**
- `bridges/discord/src/claude-runner.js` 或 `index.js` — callback 提取
- `user-job-scheduler.js` — 新 trigger type `callback`

---

#### 2.5 `style-calibration`（風格校準）

> 主線：**能力**

分析對話風格，更新 preferences.json 的 communicationStyle。

```json
{
  "id": "style-calibration",
  "name": "Communication style calibration",
  "tier": "standard",
  "trigger": {
    "type": "talk-history",
    "minLines": 50
  },
  "prompt": "..."
}
```

**Prompt 要點：**
1. 讀 `{{TALK_HISTORY}}` 分析用戶的訊息風格：
   - 平均長度、正式度、emoji 習慣
   - 常用語（口頭禪、語助詞）
   - 回覆模式（長文 vs 短句連發）
   - 偏好的互動深度（閒聊 vs 深度討論）
2. 讀現有 `preferences.json` 比對變化
3. 更新 `preferences.json` 的 `communicationStyle`
4. **不歸檔 talk-history**（與 seed-watering 不同，這個不清 history）
5. output `_SKIP`（不發訊息給用戶）

**注意：** trigger type 是 `talk-history` 但不應歸檔。需要在 `_runEventJob` 中區分：只有 `seed-watering` 歸檔。目前已經是這樣 — 歸檔條件是 `triggerType === 'talk-history'`，需要改成 `job.id === 'seed-watering'` 或新增 `job.archiveTalkHistory: true` flag。

---

### Phase 2 — 中優先

#### 2.6 `spaced-review`（間隔複習）

> 主線：**成長**

對學習筆記實施間隔重複。

```json
{
  "id": "spaced-review",
  "name": "Spaced review",
  "tier": "quick",
  "trigger": {
    "type": "spaced-review"
  },
  "prompt": "..."
}
```

**新 trigger type `spaced-review`：**
掃描 `memory/learning/` 目錄，找到符合複習時機的筆記：
- 建立後第 2 天 → 第一次複習
- 第 7 天 → 第二次複習
- 第 30 天 → 第三次複習
- 檢查 marker `.reviewed-{noteId}` 避免重複

**Prompt 要點：**
1. 讀到期的學習筆記
2. 提出 1 個關於該筆記內容的問題（應用型，不是背誦型）
3. 連結到用戶最近的工作/對話（「你上週做的 X 跟這個筆記裡的 Y 有關...」）
4. 輕鬆、短小 — 不是考試

**改動範圍：**
- `user-job-scheduler.js` — 新 trigger type `spaced-review`

---

#### 2.7 `reflection-prompt`（反思提問）

> 主線：**關係 + 成長**

基於長期模式提出反思性問題。

```json
{
  "id": "reflection-prompt",
  "name": "Reflection prompt",
  "tier": "standard",
  "trigger": {
    "type": "proactive",
    "intervalDays": 7,
    "activeDays": 14
  },
  "prompt": "..."
}
```

**Prompt 要點：**
1. 讀 `memory/weekly/` 近幾週的回顧
2. 讀 SEEDS.md 和 USER.md
3. 找長期模式（反覆出現的主題、情緒傾向、逃避的領域）
4. 提出一個深度反思問題：
   - 「你最近三週都提到 X 帶給你壓力。你覺得核心原因是什麼？」
   - 「你對 Y 的興趣從二月開始就很穩定。有想過把它變成更正式的東西嗎？」
5. 不要像心理醫生 — 像一個有洞察力的朋友

---

#### 2.8 `memory-consolidation`（記憶整理）

> 主線：**能力**

每日把零碎對話收斂成穩定事實。相當於大腦的「睡眠整理」。

```json
{
  "id": "memory-consolidation",
  "name": "Nightly memory consolidation",
  "tier": "standard",
  "trigger": {
    "type": "proactive",
    "intervalDays": 1,
    "activeDays": 3
  },
  "prompt": "..."
}
```

**Prompt 要點：**
1. 讀今天的 `memory/YYYY-MM-DD.md` 和 `talk-history.jsonl`
2. 從零碎對話中提取：
   - 新的穩定事實（用戶的偏好、生活事件、態度）→ 更新 USER.md
   - 未來意圖 → 寫入 `pending-callbacks.json`（供 callback job 使用）
   - 情緒信號 → 記錄到 `memory/mood.jsonl`（可選）
3. 更新 MEMORY.md（只改有變化的部分）
4. output `_SKIP`（不發訊息給用戶）

**與 seed-watering 的區別：**
- seed-watering = 深度學習筆記（用戶在學什麼）
- memory-consolidation = 日常記憶（用戶是誰、發生了什麼事）

---

### Phase 3 — 擴展

#### 2.9 `growth-planner`（成長規劃）

> 主線：**成長**

偵測到用戶反覆提到某個目標時，幫他整理成 roadmap。

```json
{
  "id": "growth-planner",
  "name": "Growth planner",
  "tier": "deep",
  "trigger": {
    "type": "proactive",
    "intervalDays": 30,
    "activeDays": 30
  },
  "requires": "SEEDS.md",
  "prompt": "..."
}
```

**Prompt 要點：**
1. 綜合 SEEDS.md、USER.md、近一個月的 weekly synthesis
2. 識別用戶的 1-2 個主要成長方向
3. 整理成 roadmap：當前位置 → 里程碑 → 可行的下一步
4. 問用戶是否想一起追蹤這個 roadmap
5. 如果用戶同意，寫入 `growth/YYYY-MM-topic.md`

---

#### 2.10 `experiment-runner`（小實驗提議）

> 主線：**成長**

用戶在某個行為上卡關時，提議一個小實驗。

```json
{
  "id": "experiment-runner",
  "name": "Experiment proposal",
  "tier": "standard",
  "trigger": {
    "type": "proactive",
    "intervalDays": 14,
    "activeDays": 14
  },
  "prompt": "..."
}
```

**Prompt 要點：**
1. 從最近對話和 memory 中找「卡住」的信號（反覆抱怨、拖延、猶豫不決）
2. 提議一個 1 週的小實驗（具體、可衡量、低風險）
3. 幾天後（由 callback 機制追蹤）問結果
4. 沒找到卡關信號 → `_SKIP`

---

## 第三層：Trigger 系統擴展

目前支援的 trigger types：
- `talk-history` — 對話行數門檻
- `proactive` — 定時 + 活躍度
- `idle-checkin` — 閒置天數
- `discovery` — 定時 + 有過對話

需要新增：

| Trigger Type | 說明 | 用於 |
|---|---|---|
| `callback` | `pending-callbacks.json` 有到期項目 | callback job |
| `spaced-review` | `memory/learning/` 有到期複習的筆記 | spaced-review job |

**改動：** `user-job-scheduler.js` — `_checkTrigger()` 新增 2 個 case。

---

## 第四層：talk-history 歸檔邏輯調整

**現狀：** `triggerType === 'talk-history'` 的 job 執行後都會歸檔 talk-history。

**問題：** `style-calibration` 也是 `talk-history` trigger，但不應該歸檔。

**方案：** 在 job 定義加 `archiveTalkHistory: true` flag，只有明確標記的 job 才歸檔。

```javascript
// Before
if (triggerType === 'talk-history' && fs.existsSync(talkHistoryPath)) {

// After
if (job.archiveTalkHistory && fs.existsSync(talkHistoryPath)) {
```

`seed-watering` 加 `"archiveTalkHistory": true`，`style-calibration` 不加。

---

## 實作順序

```
Phase 0 — 基礎設施（不影響現有功能）
  ├─ 1.1 conversation-policy.md + templateReplace 支援
  ├─ 1.2 preferences.json 讀取 + preferences-bounds.json
  ├─ 1.3 engagement tracking（notifier + discord bridge）
  └─ 修正 talk-history 歸檔邏輯（archiveTalkHistory flag）

Phase 1 — 高優先 jobs
  ├─ 2.1 self-tune（依賴 1.2 + 1.3）
  ├─ 2.2 weekly-synthesis
  ├─ 2.3 challenge
  ├─ 2.4 callback（需新 trigger type + bridge 層提取）
  └─ 2.5 style-calibration（依賴 1.2，需 archiveTalkHistory 修正）

Phase 2 — 中優先 jobs
  ├─ 2.6 spaced-review（需新 trigger type）
  ├─ 2.7 reflection-prompt（依賴 weekly-synthesis 產出的資料）
  └─ 2.8 memory-consolidation

Phase 3 — 擴展 jobs
  ├─ 2.9 growth-planner（依賴足夠的 memory/weekly/ 資料）
  └─ 2.10 experiment-runner（依賴 callback 機制）
```

---

## 現有 jobs 的調整

| 現有 Job | 調整 |
|----------|------|
| `onboarding` | 加 `{{CONVERSATION_POLICY}}`，尊重 preferences.json |
| `seed-watering` | 加 `"archiveTalkHistory": true`，prompt 末尾加評估 minLines 是否需要調整的指令 |
| `proactive` | tier: standard（已改）、加 `{{CONVERSATION_POLICY}}`、尊重 preferences.json 的 intervalDays 和 preferredHours |
| `idle-checkin` | tier: standard（已改）、加 `{{CONVERSATION_POLICY}}`、尊重 preferences.json |
| `discovery` | 加 `{{CONVERSATION_POLICY}}`、尊重 preferences.json 的 intervalDays |

---

## 檔案變動清單

### 新增
| 檔案 | 說明 |
|------|------|
| `scheduler/specs/conversation-policy.md` | 共用對話策略 |
| `scheduler/preferences-bounds.json` | 可調參數的上下限 |
| `bridges/shared/engagement.js` | Engagement 追蹤讀寫 |

### 修改
| 檔案 | 說明 |
|------|------|
| `scheduler/common-jobs.json` | 新增 event jobs、現有 jobs 加 archiveTalkHistory |
| `scheduler/src/job-runner.js` | `templateReplace()` 支援 `CONVERSATION_POLICY` |
| `scheduler/src/user-job-scheduler.js` | 讀 preferences.json、新 trigger types、archiveTalkHistory 邏輯 |
| `scheduler/src/notifier.js` | 寫 engagement pending entry |
| `bridges/discord/src/index.js` | engagement 回覆匹配、callback 提取 |

### Per-Workspace（由 AI 自動產生）
| 檔案 | 說明 |
|------|------|
| `preferences.json` | AI 寫入的偏好覆蓋 |
| `engagement.jsonl` | 互動效果紀錄 |
| `pending-callbacks.json` | 待追蹤的未來事件 |
| `memory/weekly/YYYY-WNN.md` | 每週回顧 |
| `memory/mood.jsonl` | 情緒追蹤（可選） |
| `growth/` | 成長 roadmap（Phase 3） |

---

## 風險與對策

| 風險 | 對策 |
|------|------|
| 訊息太多、用戶反感 | EVENT_COOLDOWN_HOURS（現有 4hr）+ self-tune 自動降頻 + preferences-bounds 設上限 |
| self-tune 把參數調到極端值 | preferences-bounds.json 硬限制 |
| callback 提取不準確 | 初期用保守 regex，誤報比漏報好（漏了就失去信任） |
| engagement tracking 隱私 | 只記錄回應時間和長度，不記錄內容，資料留在 workspace |
| 成本增加 | 新增的 job 大多是 standard tier（Sonnet），self-tune 和 memory-consolidation 不發訊息 |
| 過度 over-engineer | 嚴格按 phase 順序，每個 phase 可獨立運作 |

---

## 成功指標

Phase 1 完成後，觀察：
1. 用戶對 proactive/challenge 的回覆率 > 50%
2. callback 命中率（用戶確認「對，我有提過」）> 70%
3. self-tune 產出的 preferences.json 合理（人工抽查）
4. weekly-synthesis 被用戶稱讚或回覆至少 1 次/月

長期（3 個月後）：
1. 用戶主動開話題的頻率上升
2. seed 平均深度增加（從 intro → intermediate → advanced）
3. 用戶在對話中引用 AI 之前分享的 discovery/challenge 內容
