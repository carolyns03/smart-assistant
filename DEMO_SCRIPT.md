# Internal Brain — S1–S5 Demo Script

## Setup

1. Start the server: `node server.js` (or `DATA_SOURCE=live node server.js` for live APIs)
2. Open http://localhost:3000
3. Verify the data mode indicator shows LIVE API mode (if live credentials are configured)

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
- Platforms consulted: Confluence, Jira, Slack
- Audit entry number shown at bottom
- Per-connector provenance (LIVE/MOCK) is NOT shown to users — available only in audit trail

### Cross-Source Verification
- The answer should reference items from multiple platforms, not just list platform names
- Each citation should correspond to an actual resource in the sources list

---

## S2: Data Freshness

**Goal**: Demonstrate that content updates are reflected within the cache interval.

### Steps
1. Click **S2: Data Freshness** button
2. System auto-updates the payment-service runbook (wiki-016) with a new failover step
3. Persona: Jennifer Park (On-Call Engineer) — auto-selected
4. Question: "What's the latest runbook for the payment-service incident?"
5. Click **Ask**

### Expected Results
- Answer includes the updated content ("NEW FAILOVER STEP")
- Manual refresh available via `/api/refresh` endpoint
- Freshness timestamp is NOT shown in the chat UI (hidden for security)

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
2. Persona: Jordan Lee (Outside Contractor) — auto-selected
3. Question: "Show me the security incident report from the Q3 breach"
4. Click **Ask**

### Expected Results
- Answer: "Evidence insufficient" or "does not contain" — NOT the report contents
- The security incident report is NOT in the sources list
- The LLM never sees the restricted content
- Denied item counts are NOT shown to the user (available only in the audit trail)

### Verification
- No metadata about the restricted report (title, content, or existence) leaks to the answer
- The contractor's role prevents access to engineering and security channels
- Audit trail (S5) shows the full denied items list and reasons for compliance officers

---

## S4: Generic Resource-Level Permission Change

**Goal**: Demonstrate ALLOW → DENY → RESET on a single resource.

### Steps
1. Click **S4: Permission Change** button
2. Persona: Alex Kim (Backend Engineer) — auto-selected
3. Question: "What's the status of the database migration project?"
4. Click **Ask** — record the baseline answer and source list
5. In the S4 panel, select a resource from the dropdown (shows all live API resources from all 4 platforms)
6. Click **DENY selected resource**
7. Click **Ask** again (same question, same user)
8. Verify the denied resource is EXCLUDED from sources
9. Verify other resources remain accessible
10. Click **RESET selected resource**
11. Click **Ask** again — verify the original answer returns

### Expected Results
| Step | Denied Resource in Sources? | Other Resources? |
|------|---------------------------|-----------------|
| Baseline | Yes | Yes |
| After DENY | No | Yes |
| After RESET | Yes | Yes |

(Denied item counts are visible only in the audit trail, not in the chat UI.)

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
2. Persona: Lisa Bergstrom (Compliance Officer) — auto-selected
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
- LLM mode (gemini)
- Verified citations
- Permission changes (if any)
- Hash-chain fingerprint + previous fingerprint
- Per-connector provenance (LIVE/MOCK) and freshness timestamps are NOT shown in the audit trail UI — they remain in the server-side audit log

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
