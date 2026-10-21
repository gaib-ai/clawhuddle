# ClawHuddle

**自架式團隊 OpenClaw 管理平台** — 讓團隊中的每個人都擁有自己的 AI 助理。

每位團隊成員都會獲得一個獨立的 [OpenClaw](https://openclaw.ai) 實例，零維護成本。你只需要新增成員，系統自動搞定其餘的。

[中文](#功能特色) | [English](./README.md)

---

## 功能特色

- **獨立實例** — 每位團隊成員擁有自己的工作空間、對話記錄與設定，彼此完全隔離。
- **技能管理** — 建立自訂技能庫，從後台統一指派給個人或整個團隊。
- **管理後台** — 邀請成員、管理 API 金鑰、監控部署狀態，一個介面搞定一切。
- **秒級部署** — 將成員加入組織，AI 助理在幾秒內自動啟動。
- **隱私安全** — 每個實例完全隔離，對話、檔案、設定不會在使用者之間洩漏。
- **多供應商支援** — 自帶 Anthropic、OpenAI、Google Gemini 或 OpenRouter 的 API 金鑰。

## 架構

```
┌────────────────────────────────────────────────────┐
│                     Traefik                        │
│                  (reverse proxy)                   │
└──────────┬─────────────────┬───────────────────────┘
           │                 │
     ┌─────▼─────┐     ┌─────▼─────┐
     │  Next.js  │     │  Fastify  │
     │  Frontend │     │  API      │
     │  :3000    │     │  :4000    │
     └───────────┘     └─────┬─────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
        │  OpenClaw │  │  OpenClaw │  │  OpenClaw │
        │  User A   │  │  User B   │  │  User C   │
        │  (Docker) │  │  (Docker) │  │  (Docker) │
        └───────────┘  └───────────┘  └───────────┘
```

**Monorepo 專案結構：**

```
apps/
  api/          Fastify + SQLite 後端
  web/          Next.js 16 前端
packages/
  shared/       TypeScript 型別定義
docker/
  gateway/      OpenClaw 容器映像
```

## 技術棧

| 層級 | 技術                                              |
| ---- | ------------------------------------------------- |
| 前端 | Next.js 16, React 19, Tailwind CSS 4, NextAuth v5 |
| 後端 | Fastify 5, better-sqlite3, dockerode              |
| 閘道 | OpenClaw (Docker 容器，每位使用者獨立)            |
| 代理 | Traefik 2.11                                      |
| 建置 | Turborepo, TypeScript 5.7                         |

## 快速開始

### 前置需求

- Node.js 22+
- npm 11+
- Docker（用於閘道容器）

### 安裝步驟

1. **複製專案**

```bash
git clone https://github.com/allen-hsu/clawhuddle.git
cd clawhuddle
```

2. **安裝依賴**

```bash
npm install
```

3. **設定環境變數**

```bash
cp .env.example .env
```

編輯 `.env`：

```env
# 認證
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=請換成隨機字串

# LLM API 金鑰（至少需要一個供應商）
ANTHROPIC_API_KEY=sk-ant-...

# 超級管理員帳號
SUPER_ADMIN_EMAIL=you@example.com

# 選填：限制登入的 email 網域
ALLOWED_DOMAIN=

# 選填：透過 Resend 發送邀請信
RESEND_API_KEY=re_xxxx
EMAIL_FROM=ClawHuddle <noreply@yourdomain.com>
```

4. **建置閘道映像**

```bash
docker build -t clawhuddle-gateway:local docker/gateway
```

5. **啟動開發伺服器**

```bash
npm run dev
```

前端位於 `http://localhost:3000`，API 位於 `http://localhost:4000`。

### 首次登入

開啟 `http://localhost:3000/login` 登入。第一位使用者將自動成為管理員。接著你可以建立組織、邀請團隊成員、為成員佈建 AI 助理實例。

## Docker Compose（正式環境）

```bash
cp .env.example .env
# 編輯 .env，填入正式環境設定（DOMAIN、NEXTAUTH_SECRET 等）

docker compose up -d
```

這會啟動 Traefik、前端、API 伺服器，並建置閘道基礎映像。每位團隊成員的 OpenClaw 實例會透過管理後台按需佈建。

## 環境變數

| 變數                        | 說明                                                                                  | 預設值                  |
| --------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| `NEXTAUTH_URL`              | 前端 URL                                                                              | `http://localhost:3000` |
| `NEXTAUTH_SECRET`           | Session 加密密鑰                                                                      | **（必填）**            |
| `GOOGLE_CLIENT_ID`          | Google OAuth 用戶端 ID                                                                | —                       |
| `GOOGLE_CLIENT_SECRET`      | Google OAuth 用戶端密鑰                                                               | —                       |
| `ALLOWED_DOMAIN`            | 限制登入 email 網域，支援逗號分隔多個（例如 `company.com,partner.com`）               | —                       |
| `ANTHROPIC_API_KEY`         | 預設 Anthropic API 金鑰                                                               | —                       |
| `SUPER_ADMIN_EMAIL`         | 超級管理員 email                                                                      | —                       |
| `MAX_MEMBERS_PER_ORG`       | 每個組織的成員上限                                                                    | `50`                    |
| `RESEND_API_KEY`            | Resend API 金鑰（邀請信用）                                                           | —                       |
| `EMAIL_FROM`                | 寄件者地址                                                                            | —                       |
| `APP_URL`                   | 公開應用程式 URL，用於邀請信中的連結                                                  | `http://localhost:3000` |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | 顯示於設定頁面的客服信箱                                                              | —                       |
| `DATABASE_PATH`             | SQLite 檔案路徑                                                                       | `./data/db.sqlite`      |
| `CORS_ORIGIN`               | API 允許的來源                                                                        | `http://localhost:3000` |
| `DOCKER_NETWORK`            | 平台服務（Traefik、web、API）使用的 Docker 網路                                       | `clawhuddle-net`        |
| `GATEWAY_NETWORK`           | 每位成員閘道使用的 Docker 網路，只與 Traefik 和 claw-proxy 共用                        | `clawhuddle-gateways`   |
| `DOMAIN`                    | 正式環境網域（Traefik 用）                                                            | `localhost`             |
| `GATEWAY_DOMAIN`            | 每位使用者閘道的子網域基礎（例如 `gw.company.com` → `alice.gw.company.com`）         | —                       |
| `HOST_DATA_DIR`             | 主機上 Docker bind mount 的絕對路徑。預設為 `$PWD/data`，資料目錄不同時才需要覆蓋。  | —                       |

## 專案指令

```bash
npm run dev          # 啟動所有開發伺服器
npm run build        # 建置所有套件
npm run db:migrate   # 執行資料庫遷移
npm run create-admin # 手動將使用者提升為超級管理員
```

## 貢獻

歡迎貢獻！請先開 issue 討論你想做的改動。

1. Fork 本專案
2. 建立你的分支 (`git checkout -b feat/my-feature`)
3. 提交你的變更
4. 推送到分支
5. 開啟 Pull Request

## 贊助

如果 ClawHuddle 對你有幫助，歡迎請我喝杯咖啡！

<a href="https://buymeacoffee.com/unless" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="40"></a>

## 授權

[AGPL-3.0](./LICENSE) — 你可以自由使用、修改和散佈此軟體。若將修改版本作為網路服務運行，必須以相同授權公開原始碼。
