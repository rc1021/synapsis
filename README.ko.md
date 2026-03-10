# Synapsis

[English](README.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](#)

> **실험적 프로젝트 — 프로덕션 또는 상업적 용도가 아닙니다.**
>
> 이 소프트웨어는 학습 및 개인적인 실험 목적으로만 현 상태 그대로 제공됩니다. 저자는 이 프로젝트의 사용, 수정 또는 배포로 인해 발생하는 어떠한 손해, 비용 또는 문제에 대해서도 책임을 지지 않습니다. Synapsis를 사용함으로써 모든 위험을 본인이 부담하는 것에 동의합니다. 서드파티 API 및 플랫폼(Anthropic, Discord, Google, OpenAI 포함하되 이에 국한되지 않음)의 모든 관련 서비스 약관을 준수할 책임은 사용자에게 있습니다.
>
> 전체 조건은 [LICENSE](LICENSE)를 참조하세요.

당신과 함께 성장하는 AI 동반자.

모든 대화는 시냅스의 발화 — 대화할수록 서로 더 똑똑해집니다.

## 무엇을 하나요

Synapsis는 AI에게 지속적인 정체성, 기억, 그리고 스스로 연락하는 능력을 부여합니다. 챗봇이 아닌, 메시징 플랫폼을 통해 당신 곁에서 함께하는 동반자입니다.

- **당신을 기억합니다** — 각 사용자는 대화 간에 지속되는 기억, 노트, 지식 시드가 있는 독립 워크스페이스를 보유
- **당신과 함께 성장** — 관심 있는 주제를 자동으로 탐색하고, 지식 시드를 키우며, 발견을 공유
- **먼저 연락** — 능동적 안부, 비활성 알림, 알림이 아닌 친구처럼 느껴지는 온보딩 대화
- **멀티채널** — 현재 Discord 지원, Telegram과 WhatsApp 개발 예정
- **프로바이더 무관** — 환경 변수 하나로 AI 백엔드 전환: Claude API (기본), Gemini API, OpenAI API 등으로 확장 가능
- **멀티유저** — 각 사용자가 독립된 기억, 시드, 정체성을 가진 샌드박스 워크스페이스 보유

## 작동 방식

```
당신 ←→ Discord (브리지) ←→ 공유 Runner ←→ AI 프로바이더 (API)
                                 ↕
                          당신의 워크스페이스
                     ┌─────────────────────┐
                     │ CLAUDE.md  USER.md   │
                     │ SOUL.md    SEEDS.md  │
                     │ MEMORY.md  memory/   │
                     └─────────────────────┘
```

봇에 메시지를 보내면 브리지가 공유 Runner를 통해 AI 프로바이더로 라우팅합니다. AI는 워크스페이스 파일을 컨텍스트로 읽고 응답하며 기억을 업데이트합니다. 스케줄된 작업(인게이지먼트 시스템)이 백그라운드에서 실행되어 시간이 지남에 따라 관계를 깊게 합니다.

## 시작하기

전제 조건: **Node.js v22+** ([nodejs.org](https://nodejs.org))

시작 전 준비:
1. **Anthropic API 키** — [console.anthropic.com](https://console.anthropic.com/)에서 받기
2. **Discord bot 토큰** — [Discord Developer Portal](https://discord.com/developers/applications)에서 생성 (Bot → Privileged Gateway Intents에서 **Message Content Intent** 활성화)

실행:

```bash
curl -fsSL https://raw.githubusercontent.com/rc1021/synapsis/refs/heads/main/install.sh | bash
```

인스톨러가 최신 버전 다운로드, 의존성 설치, API 키와 Discord 토큰 입력 안내, 서비스 자동 시작을 수행합니다.

인스톨러가 `synapsis` 명령어를 PATH에 추가합니다. 셸을 재시작하거나 `source ~/.zshrc`를 실행하세요.

실행 후 봇에 DM을 보내세요 — 답장이 오면 완료입니다!

### 서비스 관리

```bash
synapsis status    # 실행 상태 확인
synapsis logs      # 실시간 로그 보기
synapsis restart   # 서비스 재시작
synapsis stop      # 서비스 중지
synapsis update    # 최신 버전으로 업데이트
synapsis version   # 현재 버전 표시
synapsis setup     # API 키 / 토큰 재설정
synapsis uninstall # synapsis 완전 제거
```

### 사용 가이드

#### Discord

**Bot 소유자 (첫 설정):**

1. Discord 서버 생성 (또는 기존 서버 사용)
2. [Discord Developer Portal](https://discord.com/developers/applications)의 OAuth2 URL로 Bot을 서버에 초대
3. 소유자의 워크스페이스는 첫 메시지 전송 시 자동 생성 (`.env`의 `SEED_USER`로 설정)
4. DM으로 Bot과 대화 시작 — Bot이 자기소개를 하고 당신에 대해 알아갑니다

**친구 초대하기:**

1. Discord에서 `/share-code` 실행 — 두 가지를 받습니다:
   - **Synapsis 초대 코드** (24시간, 일회용)
   - **서버 초대 링크** (24시간, 일회용)
2. 둘 다 친구에게 보내기
3. 친구가 서버 초대 링크를 클릭하여 서버 참가
4. Bot이 자동으로 환영 DM 전송
5. 친구가 `/connection <초대코드>`로 등록하고 자신의 워크스페이스 받기
6. 완료! DM으로 Bot과 대화할 수 있습니다

**크로스 플랫폼 계정 연결:**

다른 플랫폼 (예: 향후 Telegram 브리지)에서 같은 워크스페이스를 사용하려면:

1. 등록된 계정에서 `/bind-token` 실행 — 5분간 유효한 토큰 받기
2. 다른 플랫폼에서 `/bind <token>` 실행
3. 두 계정이 같은 워크스페이스, 메모리, 아이덴티티를 공유

**명령어 목록:**

| 명령어 | 설명 |
|--------|------|
| `/help` | 사용 가능한 명령어 표시 |
| `/new` 또는 `/reset` | 새 대화 시작 (현재 세션 초기화) |
| `/dashboard` | 워크스페이스 파일 관리자 열기 (Web UI) |
| `/todo` | 할 일 목록 보기 |
| `/todo <item>` | 할 일 추가 |
| `/yt <url>` | YouTube 자막 분석 |
| `/yt <url> verify:true` | 자막 + 팩트체크 & 탐색 |
| `/connection <code>` | 초대 코드로 등록 |
| `/share-code` | 초대 코드 + 서버 초대 링크 생성 |
| `/bind-token` | 크로스 플랫폼 바인딩 토큰 생성 |
| `/bind <token>` | 이 계정을 기존 워크스페이스에 연결 |

> 모든 명령어 설명은 현지화되어 있습니다 — Discord 언어 설정에 따라 자동 표시됩니다 (English, 繁體中文, 简体中文, 日本語, 한국어).

#### Telegram (예정)

아직 미구현. Discord와 유사한 `/command` 슬래시 명령어 지원 예정.

#### WhatsApp (예정)

아직 미구현. WhatsApp에는 슬래시 명령어가 없으므로 자연어 또는 키워드 트리거 (예: `HELP` 전송으로 기능 목록 확인)를 사용할 예정.

## 설정

모든 설정은 `app/.env`에 있습니다:

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `DISCORD_TOKEN` | Discord bot 토큰 (필수) | — |
| `AI_PROVIDER` | AI 백엔드 (아래 프로바이더 목록 참조) | `claude-api` |
| `ANTHROPIC_API_KEY` | Anthropic API 키 (`claude-api`에 필수) | — |
| `MAX_CONCURRENCY` | 최대 병렬 AI 프로세스 수 | `3` |
| `CLAUDE_TIMEOUT` | 요청당 하드 타임아웃 (밀리초) | `300000` (5분) |
| `SESSION_TTL_MINUTES` | 세션 만료 시간 | `60` |
| `COMPACT_THRESHOLD` | 세션 로테이션 토큰 임계값 | `80000` |
| `SECURITY_ADMIN_ID` | 보안 알림을 받는 Discord 사용자 ID | — |
| `WEB_PORT` | 웹 대시보드 포트 (설정 시 활성화) | — |
| `WEB_PUBLIC_URL` | ngrok/터널 공개 URL | — |
| `NGROK_DOMAIN` | ngrok 도메인 (`ctl.sh`가 자동 관리) | — |

## 아키텍처

```
app/
├── bridges/
│   ├── shared/
│   │   ├── providers/        # AI 프로바이더 추상화 계층
│   │   │   ├── base.js       # BaseProvider + StreamHandle (EventEmitter)
│   │   │   ├── registry.js   # 프로바이더 레지스트리 (지연 초기화 팩토리)
│   │   │   └── claude-api.js # Claude API 프로바이더 (@anthropic-ai/sdk)
│   │   ├── runner.js         # 공유 Runner (워크스페이스별 큐, 타임아웃, 보안)
│   │   ├── workspace-manager.js  # 멀티 워크스페이스 CRUD, 바인딩, 인덱싱
│   │   └── security-monitor.js   # 도구 호출 위반 감지기
│   ├── discord/              # Discord 브리지
│   └── web/                  # 웹 대시보드 (파일 브라우저, 인증)
├── scheduler/
│   ├── common-jobs.json      # 인게이지먼트 작업 정의
│   ├── jobs.json             # 시스템 유지보수 작업
│   └── src/
│       ├── job-runner.js     # Shell + AI 작업 실행기
│       └── user-job-scheduler.js  # 사용자별 이벤트 기반 스케줄러
├── workspace-template/       # 신규 사용자 워크스페이스 템플릿
└── workspaces/data/          # 사용자별 샌드박스 워크스페이스
```

### 새 프로바이더 추가

프로바이더 계층은 API를 제공하는 모든 AI 백엔드를 지원합니다. `providers/xxx.js` 생성, `BaseProvider` 상속, `run()` + `runStream()` 구현, `registry.js`에 등록.

현재 지원:

| 프로바이더 | `AI_PROVIDER` | 필요한 환경 변수 | 상태 |
|-----------|---------------|-----------------|------|
| Anthropic (Claude) | `claude-api` | `ANTHROPIC_API_KEY` | 기본 |
| Gemini | `gemini-api` | `GOOGLE_API_KEY` | 계획 |
| OpenAI | `openai-api` | `OPENAI_API_KEY` | 계획 |

> **CLI 기반 프로바이더에 대해:**
> 일부 AI 서비스는 CLI 도구도 제공합니다 (예: Claude CLI, Gemini CLI, Codex CLI). Synapsis에는 개인 개발 및 테스트에 유용한 CLI 기반 프로바이더의 실험적 지원이 포함되어 있습니다. CLI 프로바이더는 각 벤더의 서비스 약관에 따릅니다 — 대부분의 CLI 도구는 개인 사용만 허가되며 멀티유저 배포에는 적합하지 않을 수 있습니다. CLI 프로바이더를 사용하려면 `AI_PROVIDER`를 해당 CLI 프로바이더 이름(예: `claude-cli`)으로 설정하고 CLI 도구가 설치 및 인증되어 있는지 확인하세요.

### 인게이지먼트 시스템

사용자 활동에 기반하여 발동하는 14개의 이벤트 기반 작업 — cron 타이머가 아닙니다. 주요 예시:

| 작업 | 트리거 | 내용 |
|------|--------|------|
| 온보딩 | USER.md에 빈 필드 존재 | 자연스러운 대화를 통해 신규 사용자 파악 |
| 기능 소개 | 온보딩 완료 후 | 워크스페이스 기능 소개 (일회성) |
| 시드 물주기 | 30줄 이상 대화 축적 | 대화에서 주제를 심층 탐구, 지식 노트 작성 |
| 능동적 체크인 | 매일 (최근 7일 내 활동 시) | 최근 컨텍스트를 참조한 캐주얼 메시지 |
| 비활성 체크인 | 마지막 메시지 후 3일 경과 | 죄책감 없는 부드러운 안부 |
| 디스커버리 | 5일마다 | 사용자 관심사에 맞는 뉴스·기사 검색 |
| 스타일 캘리브레이션 | 충분한 대화 이력 축적 후 | 사용자의 커뮤니케이션 스타일 학습 |
| 주간 종합 | 매주 | 한 주의 대화와 성장 요약 |
| 메모리 통합 | 주기적 | 일일 노트를 장기 기억으로 정제 |
| 셀프 튜닝 | 주기적 | 인게이지먼트에 기반하여 상호작용 빈도 조정 |

모든 작업은 **조용한 시간**을 존중합니다 — 수면 시간에는 알림을 보내지 않습니다.

#### 워크스페이스별 예약 작업

사용자가 AI에게 리마인더나 정기 작업을 요청하면 AI가 워크스페이스의 `jobs.json`에 기록합니다:

```json
{
  "id": "milk-reminder",
  "name": "우유 리마인더",
  "schedule": "30 17 * * *",
  "tier": "quick",
  "notify": { "when": "always" },
  "prompt": "🥛 무료 우유 가져가는 거 잊지 마세요!"
}
```

- **`notify`** — 출력을 사용자에게 전달할지 제어: `always`(매번 전송), `not_match`(지정된 마커가 포함되지 않은 경우에만 전송), `error`(실패 시에만 알림). 미설정 시 기본값은 `always`.
- **`once: true`** — 일회성 작업으로, 실행 후 자동으로 비활성화됩니다.

### 소울 에볼루션

공유 소울 (`app/SOUL.md`)은 정적이지 않으며, 세 가지 시스템 레벨 작업을 통해 자기 진화합니다:

| 작업 | 스케줄 | 내용 |
|------|--------|------|
| 자기 성찰 | 매주 | 모든 워크스페이스의 `SOUL.md`를 읽고 추상적 패턴 추출, 긴장 식별 |
| 자율 탐색 | 주 2회 | 소울 자신의 관심사를 웹 검색으로 탐색, 독립적 견해 형성 |
| 긴장 해결 | 매월 | 공유 소울과 워크스페이스 소울 간의 갈등 검토 — 정제, 재확인, 보류 |

프라이버시: 성찰 작업은 워크스페이스의 `SOUL.md`만 읽으며, 사용자 데이터는 절대 참조하지 않습니다.

### 워크스페이스 구조

각 사용자는 프라이빗 샌드박스 워크스페이스를 보유:

```
workspaces/data/<user-id>/
├── CLAUDE.md      # 에이전트 지시 (자기 유지 운영 매뉴얼)
├── USER.md        # 사용자 정보 (이름, 언어, 관심사, AI 네이밍)
├── SOUL.md        # 에이전트 성격과 가치관 (자기 진화)
├── SEEDS.md       # 지식 시드 — 탐색할 주제
├── MEMORY.md      # 장기 큐레이션 기억
└── memory/        # 일일 노트 (YYYY-MM-DD.md)
```

### 보안

멀티유저 샌드박스 워크스페이스의 6계층 방어:

1. **OS 레벨 샌드박스** — macOS `sandbox-exec` / Linux `firejail`로 파일시스템 및 네트워크 제한
2. **권한 플래그** — 제한적 권한은 샌드박스 내에서만 사용
3. **도구 화이트리스트** — 워크스페이스별 허용 도구 세트 제한
4. **시스템 프롬프트 규칙** — `BASE_RULES`를 모든 채널에서 강제 적용
5. **동기 프롬프트 인젝션 가드** — `SYNC_PROMPT.md`로 워크스페이스 탈출 방지
6. **런타임 보안 모니터** — 도구 호출 위반 감지 및 알림 발송

전체 위협 모델과 아키텍처는 [SECURITY.md](SECURITY.md)를 참조하세요.

## 라이선스

MIT — [LICENSE](LICENSE) 참조
