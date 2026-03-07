# Synapsis

[English](README.md) | [繁體中文](README.zh-TW.md) | [日本語](#) | [한국어](README.ko.md)

> **実験的プロジェクト — 本番環境や商用利用を目的としていません。**
>
> このソフトウェアは学習および個人的な実験目的でのみ、現状のまま提供されます。作者は本プロジェクトの使用、変更、またはデプロイによって生じるいかなる損害、費用、問題に対しても責任を負いません。Synapsis を使用することにより、すべてのリスクをご自身で負うことに同意したものとみなします。サードパーティ API およびプラットフォーム（Anthropic、Discord、Google、OpenAI を含むがこれに限定されない）の利用規約を遵守する責任はお客様にあります。
>
> 完全な条件は [LICENSE](LICENSE) をご覧ください。

あなたと共に成長する AI コンパニオン。

すべての会話はシナプスの発火 — 話せば話すほど、お互いが賢くなる。

## 何ができるか

Synapsis は AI に永続的なアイデンティティ、記憶、そして自ら連絡する能力を与えます。チャットボットではなく、メッセージングプラットフォームを通じてあなたに寄り添うコンパニオンです。

- **あなたを覚える** — ユーザーごとに独立したワークスペースを持ち、記憶、ノート、ナレッジシードが会話をまたいで永続化
- **あなたと共に成長** — 関心のあるトピックを自動的に探索し、ナレッジシードを育て、発見を共有
- **自ら連絡** — プロアクティブなチェックイン、アイドル時のナッジ、自然に感じるオンボーディング会話
- **マルチチャネル** — 現在 Discord 対応、Telegram・WhatsApp は開発予定
- **プロバイダー非依存** — 環境変数一つで AI バックエンドを切替：Claude API（デフォルト）、Gemini API、OpenAI API などに拡張可能
- **マルチユーザー** — 各ユーザーが独立した記憶、シード、アイデンティティを持つサンドボックス化されたワークスペースを所有

## 仕組み

```
あなた ←→ Discord（ブリッジ）←→ 共有 Runner ←→ AI プロバイダー（API）
                                    ↕
                              あなたのワークスペース
                         ┌─────────────────────┐
                         │ CLAUDE.md  USER.md   │
                         │ SEEDS.md   MEMORY.md │
                         │ IDENTITY.md SOUL.md  │
                         │ memory/    jobs.json  │
                         └─────────────────────┘
```

ボットにメッセージを送ると、ブリッジが共有 Runner を通じて AI プロバイダーにルーティングします。AI はワークスペースのファイルをコンテキストとして読み取り、応答し、記憶を更新します。スケジュールされたジョブ（エンゲージメントシステム）がバックグラウンドで実行され、時間とともに関係を深めます。

## 始め方

前提条件：**Node.js v22+**（[nodejs.org](https://nodejs.org)）

始める前に準備するもの：
1. **Anthropic API キー** — [console.anthropic.com](https://console.anthropic.com/) から取得
2. **Discord bot トークン** — [Discord Developer Portal](https://discord.com/developers/applications) で作成（Bot → Privileged Gateway Intents で **Message Content Intent** を有効化）

実行：

```bash
curl -fsSL https://raw.githubusercontent.com/rc1021/synapsis/refs/heads/main/install.sh | bash
```

インストーラーが最新バージョンのダウンロード、依存パッケージのインストール、API キーと Discord トークンの入力案内、サービスの自動起動を行います。

インストーラーが `synapsis` コマンドを PATH に追加します。シェルを再起動するか `source ~/.zshrc` を実行してください。

起動後、ボットに DM を送ってください — 返信があれば完了です！

### サービス管理

```bash
synapsis status    # 実行状態を確認
synapsis logs      # リアルタイムログを表示
synapsis restart   # サービスを再起動
synapsis stop      # サービスを停止
synapsis update    # 最新バージョンに更新
synapsis version   # 現在のバージョンを表示
synapsis setup     # API キー / トークンを再設定
synapsis uninstall # synapsis を完全に削除
```

### Bot コマンド

Discord でこれらのスラッシュコマンドを使用できます（DM またはチャンネル）：

| コマンド | 説明 |
|----------|------|
| `/help` | 利用可能なコマンドを表示 |
| `/new` または `/reset` | 新しい会話を開始（現在のセッションをクリア） |
| `/connection <code>` | 招待コードで登録 |
| `/share-code` | 24時間有効の使い捨て招待コードを生成 |
| `/bind-token` | 5分間有効のクロスプラットフォーム連携トークンを生成 |
| `/bind <token>` | このアカウントを既存のワークスペースに連携 |

**初回セットアップの流れ：**
1. Bot オーナーは自動的にワークスペースを取得（`.env` の `SEED_USER` で設定）
2. オーナーが `/share-code` で招待コードを生成
3. 新ユーザーが `/connection <code>` で登録し、自分のワークスペースを取得
4. クロスプラットフォーム連携：登録済みアカウントで `/bind-token`、別のプラットフォームで `/bind <token>`

## 設定

すべての設定は `app/.env` にあります：

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `DISCORD_TOKEN` | Discord bot トークン（必須）| — |
| `AI_PROVIDER` | AI バックエンド（下記プロバイダーリスト参照）| `claude-api` |
| `ANTHROPIC_API_KEY` | Anthropic API キー（`claude-api` に必須）| — |
| `MAX_CONCURRENCY` | 最大並列 AI プロセス数 | `3` |
| `CLAUDE_TIMEOUT` | リクエストごとのハードタイムアウト（ミリ秒）| `300000`（5分）|
| `SESSION_TTL_MINUTES` | セッション有効期限 | `60` |
| `COMPACT_THRESHOLD` | セッションローテーションのトークン閾値 | `80000` |
| `SECURITY_ADMIN_ID` | セキュリティアラートを受信する Discord ユーザー ID | — |

## アーキテクチャ

```
app/
├── bridges/
│   ├── shared/
│   │   ├── providers/        # AI プロバイダー抽象層
│   │   │   ├── base.js       # BaseProvider + StreamHandle（EventEmitter）
│   │   │   ├── registry.js   # プロバイダーレジストリ（遅延初期化ファクトリ）
│   │   │   └── claude-api.js # Claude API プロバイダー（@anthropic-ai/sdk）
│   │   ├── runner.js         # 共有 Runner（ワークスペースごとのキュー、タイムアウト、セキュリティ）
│   │   ├── workspace-manager.js  # マルチワークスペース CRUD、バインディング、インデックス
│   │   └── security-monitor.js   # ツール呼び出し違反検出器
│   └── discord/              # Discord ブリッジ
├── scheduler/
│   ├── common-jobs.json      # エンゲージメントジョブ定義
│   ├── jobs.json             # システムメンテナンスジョブ
│   └── src/
│       ├── job-runner.js     # Shell + AI ジョブ実行器
│       └── user-job-scheduler.js  # ユーザーごとのイベント駆動スケジューラー
├── workspace-template/       # 新規ユーザーワークスペーステンプレート
└── workspaces/data/          # ユーザーごとのサンドボックスワークスペース
```

### 新しいプロバイダーの追加

プロバイダー層は API を提供するあらゆる AI バックエンドに対応。`providers/xxx.js` を作成、`BaseProvider` を継承、`run()` + `runStream()` を実装、`registry.js` で登録。

現在のサポート状況：

| プロバイダー | `AI_PROVIDER` | 必要な環境変数 | ステータス |
|-------------|---------------|---------------|-----------|
| Anthropic（Claude）| `claude-api` | `ANTHROPIC_API_KEY` | デフォルト |
| Gemini | `gemini-api` | `GOOGLE_API_KEY` | 予定 |
| OpenAI | `openai-api` | `OPENAI_API_KEY` | 予定 |

> **CLI ベースプロバイダーについて：**
> 一部の AI サービスは CLI ツールも提供しています（例：Claude CLI、Gemini CLI、Codex CLI）。Synapsis には CLI ベースプロバイダーの実験的サポートが含まれており、個人の開発やテストに役立ちます。CLI プロバイダーは各ベンダーの利用規約に従います — ほとんどの CLI ツールは個人使用のみにライセンスされており、マルチユーザーデプロイメントには適さない場合があります。CLI プロバイダーを使用する場合は、`AI_PROVIDER` を対応する CLI プロバイダー名（例：`claude-cli`）に設定し、CLI ツールがインストールされ認証済みであることを確認してください。

### エンゲージメントシステム

ユーザーの活動に基づいて発火するイベント駆動ジョブ — cron タイマーではありません：

| ジョブ | トリガー | 内容 |
|--------|----------|------|
| オンボーディング | USER.md に空白フィールドがある | 自然な会話を通じて新規ユーザーを知る |
| シード水やり | 30行以上の会話が蓄積 | 会話からトピックを深掘り、ナレッジノートを作成 |
| プロアクティブチェックイン | 毎日（直近7日間にアクティブな場合）| 最近のコンテキストを参照したカジュアルなメッセージ |
| アイドルチェックイン | 最後のメッセージから3日経過 | 罪悪感を与えない穏やかなナッジ |
| ディスカバリー | 5日ごと | ユーザーの興味に合うニュース・記事を検索 |

### ワークスペース構造

各ユーザーはプライベートなサンドボックスワークスペースを所有：

```
workspaces/data/<user-id>/
├── CLAUDE.md      # エージェント指示（動作、安全ルール）
├── USER.md        # ユーザー情報（名前、言語、興味、タイムゾーン）
├── SOUL.md        # エージェントの性格と価値観
├── IDENTITY.md    # エージェントの名前、絵文字、雰囲気
├── SEEDS.md       # ナレッジシード — 探索するトピック
├── MEMORY.md      # 長期キュレーション記憶
├── memory/        # デイリーノート（YYYY-MM-DD.md）
└── jobs.json      # ユーザーカスタムジョブ
```

### セキュリティ

マルチユーザーサンドボックスワークスペースの6層防御：

1. **OS レベルサンドボックス** — macOS `sandbox-exec` / Linux `firejail` がファイルシステムとネットワークを制限
2. **権限フラグ** — 制限的権限はサンドボックス内でのみ使用
3. **ツールホワイトリスト** — ワークスペースごとに許可されるツールセットを制限
4. **システムプロンプトルール** — `BASE_RULES` を全チャネルで強制適用
5. **同期プロンプトインジェクションガード** — `SYNC_PROMPT.md` がワークスペース脱出を防止
6. **ランタイムセキュリティモニター** — ツール呼び出し違反を検出しアラートを送信

完全な脅威モデルとアーキテクチャは [SECURITY.md](SECURITY.md) を参照してください。

## ライセンス

MIT — [LICENSE](LICENSE) を参照
