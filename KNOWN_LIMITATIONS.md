# Internal Brain — Known Limitations

## 1. Connector Credential Dependencies

### Jira
- **Issue**: Jira connector reports ERROR if `JIRA_API_TOKEN`, `JIRA_EMAIL`, or `JIRA_BASE_URL` are missing or invalid.
- **API Version**: Uses Jira Cloud REST API **v3** (`/rest/api/3/search/jql`). The v2 `/rest/api/2/search` endpoint was deprecated by Atlassian and now returns HTTP 410.
- **JQL Bounding**: The v3 API requires a bounded JQL query (e.g. `updated >= -365d`). Unbounded queries like `ORDER BY updated DESC` alone return HTTP 400.
- **ADF Descriptions**: Jira v3 returns descriptions as Atlassian Document Format (ADF) objects. The connector includes `extractTextFromADF()` to convert these to plain text.
- **Pagination**: v3 uses `nextPageToken`/`isLast` instead of `startAt`/`total`.
- **Impact**: No Jira data is retrieved; system falls back to mock data if available.
- **Manual Setup Required**: Configure Atlassian Cloud credentials in `.env`.

### Google Drive
- **Issue**: Uses OAuth access tokens (not service accounts). Access tokens expire (~1 hour).
- **Impact**: Token refresh requires re-authorization via OAuth flow, which is not automated in this version.
- **Manual Setup Required**: Generate a new access token via [OAuth Playground](https://developers.google.com/oauthplayground/) and update `DRIVE_ACCESS_TOKEN`.

### Slack
- **Issue**: Bot must be explicitly invited to each channel (`/invite @BotName`).
- **Impact**: `not_in_channel` errors for channels where the bot hasn't been invited.
- **Manual Setup Required**: Invite bot to all channels you want to index.

### Confluence
- **Issue**: Only reads pages from spaces the integration has been granted access to.
- **Impact**: Pages in restricted spaces may not be returned.
- **Manual Setup Required**: Ensure the Atlassian app has `read:confluence-content` scope.

---

## 2. Security Limitations

### Admin Authentication
- **Current**: Uses `x-admin-user-id` HTTP header for demo purposes.
- **Limitation**: This is NOT production-grade authentication. There is no session management, JWT, or password verification.
- **Production Required**: Implement proper session/JWT-based authentication with password verification and HTTPS.

### Frontend Admin Access
- **Current**: The frontend sends admin headers automatically for demo flows.
- **Limitation**: In a real deployment, admin actions should require re-authentication (e.g., entering a password or 2FA).

---

## 3. Data & Caching

### 5-Minute Cache
- **Current**: Live data is cached for 5 minutes to reduce API calls.
- **Limitation**: Updates made at the source within the cache window will not appear until the cache expires or manual refresh.
- **Not Tested**: The 5-minute TTL is not explicitly verified with a timed test. Manual testing confirms updates appear after `GET /api/refresh`.

### Mock Data Mode
- **Current**: When `DATA_SOURCE` is not set to `live`, the system uses JSON fixtures.
- **Limitation**: Mock data does not reflect real API behavior, rate limits, pagination, or error handling.
- **Verification**: Mock tests do NOT prove real platform authorization works. LIVE integration tests are separate.

---

## 4. LLM (Gemini) Limitations

### Rate Limiting
- **Issue**: Google Gemini API has rate limits (requests per minute, tokens per minute).
- **Impact**: High query volumes may result in 429 errors.
- **Handling**: The system returns a clear error message when Gemini API fails.

### Deterministic Fallback
- **Current**: If Gemini API fails (no API key, rate limit, network error), the system returns a labeled fallback answer.
- **Limitation**: The fallback answer is deterministic and clearly labeled as "FALLBACK" — it does not use real LLM reasoning.

### Hallucination Risk
- **Mitigation**: The system provides authorized context only and instructs the model to answer only from provided evidence.
- **Limitation**: LLM models can still hallucinate. Citation IDs are validated against actual context resources, but the model's text is not post-processed for factual accuracy.

---

## 5. Tencent Cloud Integration

### Current Status
- **Not Used**: This application does NOT currently use any Tencent Cloud services.
- **LLM Provider**: Google Gemini is the LLM provider, not Tencent Cloud AI.
- **Hosting**: Application runs on Node.js locally or on any cloud VM.

### If Required for Submission
- Tencent Cloud services that could be integrated: Tencent Cloud AI (for LLM), Tencent Cloud COS (for file storage), Tencent Cloud CDB (for database).
- **Flagged for team confirmation**: Whether official submission requires Tencent Cloud services is unverified. No new cloud architecture has been introduced solely to satisfy an assumed requirement.

---

## 6. Audit Trail

### Hash Chain
- **Current**: SHA-256 fingerprinting with each entry chained to the previous.
- **Limitation**: If the diary file (`data/diary.json`) is manually edited outside the application, the chain breaks. This is detected by `/api/diary/verify` but cannot be auto-repaired.

### Tamper Endpoint
- **Current**: `POST /api/diary/tamper` is available for demonstration purposes (admin auth required).
- **Limitation**: In production, this endpoint should be disabled or strictly isolated from production operation.

### Diary Storage
- **Current**: Stored as a JSON file (`data/diary.json`).
- **Limitation**: Not suitable for high-volume production. A database (e.g., PostgreSQL with append-only tables) would be more appropriate.

---

## 7. Frontend

### Denied Item Counts Hidden from Users
- **Current**: The chat UI does NOT show denied item counts, total resource counts, per-connector status badges (LIVE/MOCK/ERROR), provenance labels, or freshness timestamps to end users. This information is available only in the audit trail (`diary.html`) for compliance officers.
- **Rationale**: Showing how many resources were denied, total resource counts, or per-connector status reveals information about what resources exist and the backend infrastructure, which could be a security concern.
- **Audit Trail**: Compliance officers can see full denied item lists, reasons, and counts in the audit trail (S5). However, provenance (LIVE/MOCK per connector) and freshness timestamps have also been removed from the audit trail UI for consistency — they remain in the server-side audit log (`data/diary.json`).

### No Framework
- **Current**: Vanilla HTML/CSS/JS.
- **Limitation**: No reactive UI framework (React, Vue). State management is manual.
- **Impact**: Suitable for demo/hackathon. Production would benefit from a framework.

### No Real-time Updates
- **Current**: Data mode indicator is loaded on page load and after refresh. Per-connector status badges are hidden from the UI.
- **Limitation**: No WebSocket or SSE for real-time status updates.

---

## 8. Search

### Keyword-Based
- **Current**: TF-IDF scoring with stop word removal, synonym expansion, and platform diversity.
- **Limitation**: No semantic search or embedding-based retrieval. Complex queries may not match well.
- **Impact**: Adequate for demo. Production would benefit from vector search (e.g., embeddings).

### No Pagination
- **Current**: All search results returned at once.
- **Limitation**: Large result sets are not paginated.

---

## 9. S4 Resource Dropdown

### Live Data Integration
- **Current**: The S4 resource dropdown fetches the full resource list via `/api/apps/:app` using compliance officer credentials. This returns live API data (same cache as the Q&A flow) when `DATA_SOURCE=live` is set.
- **Previous Issue**: The dropdown previously used `loadAppData()` which only read static JSON files — it never touched the live cache. This was fixed by adding `loadAppDataLive()` which reads from the same in-memory cache as the Q&A flow.
- **Admin Auth**: The endpoint requires compliance officer role. The frontend sends `x-admin-user-id: user-compliance` to authenticate.

### S2 Data Freshness Scenario
- **Current**: The S2 runbook update scenario no longer includes hardcoded timestamps (e.g., "updated at 1:00 PM today"). The runbook content simply states it "includes a newly added failover step."
- **Rationale**: Hardcoded timestamps become stale during demos. The freshness is demonstrated by the cache behavior, not by a specific time reference.
