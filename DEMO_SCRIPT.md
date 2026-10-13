# Internal Brain — S1–S5 Demo Script

## Setup

1. Start the server: `node server.js` (or `DATA_SOURCE=live node server.js` for live APIs)
2. Open http://localhost:3000
3. Verify connector status badges show LIVE or MOCK for each platform

---

## S1: Unified Natural-Language Query

**Goal**: Demonstrate cross-platform question answering with verified citations.

### Steps
1. Click **S1: Unified Query** button
2. Persona: Alex Kim (Backend Engineer) — auto-selected
3. Question: "What's the status of the database migration project and were there any blockers raised in Slack last week?"
4. Click **Ask**

### Expected Results
- Answer synthesizes evidence from Confluence + Jira + Slack
- Citation IDs shown as clickable links (e.g., `[WIKI-65960]`, `[JIRA-003]`)
- Provenance labels show LIVE/MOCK per connector
- Platforms consulted: Confluence, Jira, Slack
- Audit entry number shown at bottom

### Cross-Source Verification
- The answer should reference items from multiple platforms, not just list platform names
- Each citation should correspond to an actual resource in the sources list

---

## S2: Data Freshness

**Goal**: Demonstrate that content updates are reflected within the cache interval.

### Steps
1. Click **S2: Data Freshness** button
2. System auto-updates the payment-service runbook (wiki-016) with a new failover step
3. Persona: Sarah Chen (On-Call Engineer) — auto-selected
4. Question: "What's the latest runbook for the payment-service incident?"
5. Click **Ask**

### Expected Results
- Answer includes the updated content ("NEW FAILOVER STEP")
- Freshness timestamp shows recent update time
- Manual refresh available via `/api/refresh` endpoint

### Freshness Test
1. Read a test resource via API
2. Update its content at the source
3. Refresh or wait for 5-minute cache expiry
4. Ask again — answer reflects updated content
5. Record elapsed time

---

## S3: Permission Enforcement

**Goal**: Demonstrate that unauthorized content is filtered BEFORE the LLM.

### Steps
1. Click **S3: Permission Enforcement** button
2. Persona: Mike Torres (Contractor) — auto-selected
3. Question: "Show me the security incident report from the Q3 breach"
4. Click **Ask**

### Expected Results
- Answer: "Evidence insufficient" or "does not contain" — NOT the report contents
- The security incident report is NOT in the sources list
- Denied items count shown in the response
- Stats show N visible / M total (M - N denied)
- The LLM never sees the restricted content

### Verification
- No metadata about the restricted report (title, content, or existence) leaks to the answer
- The contractor's role prevents access to engineering and security channels

---

## S4: Generic Resource-Level Permission Change

**Goal**: Demonstrate ALLOW → DENY → RESET on a single resource.

### Steps
1. Click **S4: Permission Change** button
2. Persona: Alex Kim (Backend Engineer) — auto-selected
3. Question: "What's the status of the database migration project?"
4. Click **Ask** — record the baseline answer and source list
5. In the S4 panel, select a resource from the dropdown (e.g., a Confluence page)
6. Click **DENY selected resource**
7. Click **Ask** again (same question, same user)
8. Verify the denied resource is EXCLUDED from sources
9. Verify other resources remain accessible
10. Click **RESET selected resource**
11. Click **Ask** again — verify the original answer returns

### Expected Results
| Step | Denied Resource in Sources? | Other Resources? | Denied Items Count |
|------|---------------------------|-----------------|-------------------|
| Baseline | Yes | Yes | 0 |
| After DENY | No | Yes | 1+ |
| After RESET | Yes | Yes | 0 |

### Key Points
- Only the selected resource is denied — siblings remain accessible
- For Slack, denying a message does NOT revoke the entire channel
- The user's role is NOT changed
- Permission changes take effect immediately (cache invalidated)

---

## S5: Audit Inquiry

**Goal**: Demonstrate complete, tamper-proof audit records.

### Steps
1. Click **S5: Audit Inquiry** button
2. Persona: Lisa Chang (Compliance Officer) — auto-selected
3. Navigate to the Audit Trail page (opens automatically)
4. Use "Search by user" to filter entries
5. Click **Verify Integrity** to check hash-chain
6. Click **Tamper (demo)** to simulate tampering
7. Click **Verify Integrity** again — tamper detected

### Expected Results — Each Audit Entry Shows:
- Timestamp
- Querying user + role
- Query text
- Candidate resource IDs (retrieved)
- Authorization decisions (ALLOW/DENY per resource)
- Denied resource IDs + reasons
- Authorized resource IDs (sent to LLM)
- Source LIVE/MOCK provenance per connector
- LLM mode (gemini)
- Verified citations
- Permission changes (if any)
- Hash-chain fingerprint + previous fingerprint

### Tamper Detection
- Tampering any field breaks the hash chain
- Verify Integrity reports which entry was tampered
- Tampered entries are permanently flagged (cannot be repaired)
- Normal users cannot access tamper endpoint (admin auth required)

---

## Test Suite

```bash
# Security tests (12 tests — permission engine, mock fixtures)
node tests/security-tests.js

# Integration tests (23 tests — API, admin auth, S4 flow, audit, connectors)
node server.js &
node tests/integration-tests.js
```

All 35 tests pass.
