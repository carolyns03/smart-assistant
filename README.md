# Internal Brain

**Context-Aware Enterprise Knowledge System** — a secure, permission-filtered, multi-source question-answering application that integrates Slack, Jira, Confluence, and Google Drive with grounded LLM answers.

Built for the **Tencent Cloud AI Singapore Hackathon 2026**.

---

## What It Does

Internal Brain lets users ask natural-language questions and get answers grounded in **authorized** evidence from four enterprise platforms:

1. **Unified Query (S1)** — Cross-platform answers with verified citations
2. **Data Freshness (S2)** — 5-minute cache with manual refresh and source update detection
3. **Permission Enforcement (S3)** — Permission filtering BEFORE content reaches the LLM
4. **Permission Change (S4)** — Resource-level ALLOW/DENY/RESET with immediate effect
5. **Audit Trail (S5)** — Tamper-proof hash-chain audit of every query, decision, and answer

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (Browser)                        │
│  Persona Select │ Chat │ S1-S5 Nav │ Connector Status │ Audit│
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP API
┌──────────────────────────▼──────────────────────────────────┐
│                      server.js (Express)                     │
│  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐           │
│  │ /api/ask│ │ /api/    │ │ Admin  │ │ /api/    │           │
│  │         │ │ refresh  │ │ Endpts │ │ diary    │           │
│  └────┬────┘ └────┬─────┘ └───┬────┘ └────┬────┘           │
└───────┼───────────┼───────────┼───────────┼─────────────────┘
        │           │           │           │
┌───────▼──┐ ┌──────▼──┐ ┌─────▼──┐ ┌──────▼──┐
│  Search  │ │ DataSt. │ │ Perms  │ │  Diary  │
│  Engine  │ │ +Cache  │ │ Engine│ │ (Hash)  │
└────┬─────┘ └──┬──────┘ └──┬────┘ └─────────┘
     │          │            │
     │   ┌──────▼────────────▼──────┐
     │   │    Connectors (4)         │
     │   │ ┌──────┐┌──────┐┌──────┐ │
     │   │ │Slack ││ Jira ││Confl.│ │
     │   │ └──────┘└──────┘└──────┘ │
     │   │ ┌──────┐                 │
     │   │ │Drive │                 │
     │   │ └──────┘                 │
     │   └──────────────────────────┘
     │
┌────▼──────────────────────┐
│    Answer Engine (Gemini)  │
│  Authorized context only   │
│  Grounded answer + cites   │
└───────────────────────────┘
```

## Core Flow

```
User Question
    → Source Retrieval (4 connectors)
    → Authorization Enforcement (permissions.js — filter BEFORE LLM)
    → Relevance Ranking (search.js)
    → Authorized LLM Context (answerEngine.js — Gemini)
    → Grounded Answer with Verified Citations
    → Audit Record (diary.js — hash-chain)
```

## Key Security Principles

1. **Explicit DENY always takes precedence** over ALLOW
2. **Fail-closed**: Unknown or unverified authorization denies access
3. **No denied content or metadata reaches the LLM**
4. **No raw-data API bypasses authorization** — admin auth required
5. **Permission checks happen on the server**, not the frontend
6. **ALLOW demo override cannot bypass source-native denial**

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment
cp .env.example .env
# Edit .env with your API keys (see Connector Setup below)

# 3. Run in mock mode (no API keys needed)
node server.js

# 4. Or run in live mode
DATA_SOURCE=live node server.js
```

Open http://localhost:3000

## Connector Setup

### Slack
1. Create app at https://api.slack.com/apps
2. Add Bot Token Scopes: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `users:read.email`
3. Install app → copy Bot User OAuth Token
4. Invite bot to channels: `/invite @YourBotName`
5. Set `SLACK_BOT_TOKEN` in `.env`

### Jira (Atlassian Cloud)
1. Go to https://developer.atlassian.com/console/ → Create app
2. Add Jira Platform REST API → scope: `read:jira-work`
3. Generate token
4. Set `JIRA_API_TOKEN`, `JIRA_EMAIL`, `JIRA_BASE_URL` in `.env`

### Confluence (Atlassian Cloud)
1. Reuse same Atlassian app or create new one
2. Add Confluence Cloud REST API → scopes: `read:confluence-content`, `read:confluence-space`
3. Generate token
4. Set `CONFLUENCE_API_TOKEN`, `CONFLUENCE_EMAIL`, `CONFLUENCE_BASE_URL` in `.env`

### Google Drive
1. Go to https://console.cloud.google.com/ → enable Google Drive API
2. Create OAuth 2.0 credentials or Service Account
3. Get an access token with `drive.readonly` scope
4. Set `DRIVE_ACCESS_TOKEN` in `.env`
5. Optional: Set `DRIVE_FOLDER_ID` to limit scope

### Google Gemini (Answer Engine)
1. Get your API key from https://aistudio.google.com/apikey
2. Set `GEMINI_API_KEY` in `.env`

## Data Modes

| Mode | Description | How to Enable |
|------|-------------|---------------|
| **LIVE** | Real API calls to Slack/Jira/Confluence/Drive | Set `DATA_SOURCE=live` + API keys |
| **MOCK** | JSON fixture files in `data/` | Leave `DATA_SOURCE` unset |

The UI clearly labels each connector as LIVE, MOCK, EMPTY, or ERROR.

## Running Tests

```bash
# Security tests (mock fixtures — no server needed)
node tests/security-tests.js

# Integration tests (requires server running on port 3000)
node server.js &
node tests/integration-tests.js
```

**Test Results**: 12 security tests + 23 integration tests = 35 total, all passing.

## Personas

| Persona | Role | Access Level |
|---------|------|-------------|
| Alex Kim | Backend Engineer | Engineering + general content, no security |
| Sarah Chen | On-Call Engineer | Engineering + runbooks, no security |
| Mike Torres | Contractor | General only, no engineering or security |
| Emma Wong | Customer Service | General only, no financial data |
| David Park | Security Team | All content including security |
| Lisa Chang | Compliance Officer | All content + admin access |

## API Endpoints

### Query
- `POST /api/ask` — Ask a question (requires `userId` + `query`)

### Data & Freshness
- `GET /api/refresh` — Refresh cache, get connector status
- `GET /api/apps/:app` — Raw data access (admin auth required)

### Permissions (S4)
- `PUT /api/permissions/:userId/resource/:appKey/:itemId` — ALLOW/DENY/RESET a resource
- `PUT /api/users/:userId/role` — Change user role
- `POST /api/permissions/:userId/reset` — Reset all overrides
- `POST /api/reset` — Reset everything (admin auth required)

### Audit (S5)
- `GET /api/diary` — Get all audit entries
- `GET /api/diary/verify` — Verify hash-chain integrity
- `GET /api/diary/search?userId=...` — Search by user
- `POST /api/diary/tamper` — Tamper test (admin auth required)

## File Structure

```
smart-assistant-master/
├── server.js                    # Express server, API endpoints
├── src/
│   ├── dataStore.js             # Data loading, caching, connector status
│   ├── permissions.js           # Authorization engine (canAccessItem, getFilteredData)
│   ├── search.js                # Relevance ranking, stop words, synonyms
│   ├── answerEngine.js          # Gemini LLM integration, context building
│   ├── diary.js                 # Hash-chain audit trail
│   └── connectors/
│       ├── slackConnector.js    # Slack API integration
│       ├── jiraConnector.js     # Jira API integration
│       ├── confluenceConnector.js # Confluence API integration
│       └── driveConnector.js    # Google Drive API integration
├── public/
│   ├── index.html               # Chat UI with S1-S5 navigation
│   └── diary.html               # Audit trail viewer
├── data/
│   ├── users.json               # Persona definitions
│   ├── permissions.json         # Permission rules + overrides
│   ├── wiki.json                # Mock Confluence data
│   ├── jira.json                # Mock Jira data
│   ├── slack.json               # Mock Slack data
│   └── drive.json               # Mock Google Drive data
├── tests/
│   ├── security-tests.js        # 12 permission/security tests
│   └── integration-tests.js     # 23 API/integration tests
├── .env.example                 # Safe template (placeholder values only)
├── .gitignore                   # Excludes .env, data/diary.json, etc.
└── package.json
```

## Known Limitations

1. **Jira connector**: Requires valid Atlassian Cloud credentials. Currently reports ERROR if credentials are missing or invalid.
2. **Google Drive**: Uses access tokens (not service account). Token refresh requires re-authorization via OAuth flow.
3. **Slack**: Bot must be invited to channels to read messages. `not_in_channel` errors are handled gracefully.
4. **Mock data**: When `DATA_SOURCE` is not set to `live`, the system uses JSON fixtures. These are clearly labeled as MOCK in the UI.
5. **Admin authentication**: Uses header-based `x-admin-user-id` for demo purposes. Production deployment should use proper session/JWT authentication.
6. **Tencent Cloud**: This application does not currently use Tencent Cloud services. The Gemini API is the LLM provider. Any Tencent Cloud integration would require additional setup and verification.

## Tech Stack

- **Backend**: Node.js, Express
- **LLM**: Google Gemini (gemini-2.0-flash)
- **Integrations**: Slack Web API, Jira REST API, Confluence REST API, Google Drive API
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Security**: Server-side permission engine, hash-chain audit trail
- **Tests**: Node.js assert module (no external test framework)

## License

MIT
