# Internal Brain — Test Results Report

## Test Summary

| Suite | Tests | Passed | Failed | Status |
|-------|-------|--------|--------|--------|
| Security (Mock Fixtures) | 12 | 12 | 0 | ✅ PASS |
| Integration (Live Server) | 23 | 23 | 0 | ✅ PASS |
| **Total** | **35** | **35** | **0** | **✅ ALL PASS** |

---

## Security Tests (Mock Fixtures)

Run: `node tests/security-tests.js`

These tests verify the permission engine directly using mock fixtures. They do NOT require a running server.

| # | Test | Description | Result |
|---|------|-------------|--------|
| 1 | Invalid user rejected | Unknown userId returns null from getEffectivePermissions | ✅ PASS |
| 2 | getFilteredData returns null for unknown user | Async test of invalid user handling | ✅ PASS |
| 3 | Unknown permission denied | User with no matching role permission fails closed | ✅ PASS |
| 4 | Explicit DENY overrides ALLOW | Denial takes precedence over allow in canAccessItem | ✅ PASS |
| 5 | Unauthorized content absent from filtered data | getFilteredData excludes denied items | ✅ PASS |
| 6 | Permission engine does not bypass authorization | canAccessItem is the only entry point | ✅ PASS |
| 7 | Compliance officer identified | getEffectivePermissions identifies admin role | ✅ PASS |
| 8 | Regular user is not compliance_officer | Non-admin users correctly identified | ✅ PASS |
| 9 | One-resource revocation does not deny siblings | Denying one item keeps siblings accessible | ✅ PASS |
| 10 | Slack message-level revocation | Message denial does not deny entire channel | ✅ PASS |
| 11 | ALLOW → DENY → RESET flow | Item access changes through all three states | ✅ PASS |
| 12 | Sources use stable IDs | Every item has a unique, stable ID | ✅ PASS |

---

## Integration Tests (Live Server)

Run: `node tests/integration-tests.js` (requires server on port 3000)

These tests make real HTTP requests to the running server.

| # | Test | Description | Result |
|---|------|-------------|--------|
| 1 | Invalid userId returns 404 | POST /api/ask with invalid userId | ✅ PASS |
| 2 | Missing userId returns 400 | POST /api/ask without userId | ✅ PASS |
| 3 | Admin role change without auth returns 403 | PUT /api/users/:id/role without header | ✅ PASS |
| 4 | Raw data without auth returns 403 | GET /api/apps/wiki without header | ✅ PASS |
| 5 | Tamper without auth returns 403 | POST /api/diary/tamper without header | ✅ PASS |
| 6 | Reset without auth returns 403 | POST /api/reset without header | ✅ PASS |
| 7 | Admin role change with auth succeeds | PUT /api/users/:id/role with admin header | ✅ PASS |
| 8 | Baseline: wiki-65960 visible | user-junior can see wiki-65960 in sources | ✅ PASS |
| 9 | DENY wiki-65960 via override | Resource override applied | ✅ PASS |
| 10 | After DENY: wiki-65960 excluded | Not in sources, in deniedItems | ✅ PASS |
| 11 | After DENY: other resources remain | Siblings still accessible | ✅ PASS |
| 12 | RESET wiki-65960 restores access | Override removed | ✅ PASS |
| 13 | After RESET: wiki-65960 returns | Back in sources | ✅ PASS |
| 14 | Contractor cannot see security report | Evidence-insufficient response | ✅ PASS |
| 15 | Contractor has deniedItems | Permission filtering visible in response | ✅ PASS |
| 16 | Diary verify returns valid | Hash-chain integrity confirmed | ✅ PASS |
| 17 | Tamper + verify detects tampering | Tamper detection works | ✅ PASS |
| 18 | Connector status returned | /api/refresh returns connector status (hidden from UI) | ✅ PASS |
| 19 | Null connector not reported as LIVE | ERROR status when connector returns null | ✅ PASS |
| 20 | Provenance in API response | Response includes provenance object (hidden from UI) | ✅ PASS |
| 21 | Provenance has LIVE/MOCK per connector | Each connector has status field (hidden from UI) | ✅ PASS |
| 22 | Data freshness: update + verify | wiki-016 update reflected in response | ✅ PASS |
| 23 | Cache refresh updates timestamp | Manual refresh works (timestamp hidden from UI) | ✅ PASS |

---

## Verification Levels

| Level | Description | Status |
|-------|-------------|--------|
| **Implemented in code** | All features coded and syntax-checked | ✅ Done |
| **Verified with mock data** | Security tests pass with mock fixtures | ✅ 12/12 pass |
| **Verified against LIVE APIs** | Integration tests pass with running server | ✅ 23/23 pass |
| **Connector LIVE verification** | Slack, Confluence, and Jira verified LIVE with real API keys | ✅ LIVE |
| **Connector ERROR (expired token)** | Drive shows ERROR when OAuth access token expires (~1 hour). Falls back to mock data. | ✅ Correct behavior |

---

## Manual Test Results (S1-S5)

### S1: Unified Query
| Question | User | Sources | Platforms | Result |
|----------|------|---------|-----------|--------|
| Database migration status | user-junior | wiki-65960, jira-003, wiki-98542, slack-004 | Confluence, Jira, Slack | ✅ PASS |
| Payment service runbook | user-oncall | wiki-016 | Confluence | ✅ PASS |
| Database migration project | user-junior | Cross-source: Confluence + Jira | Confluence, Jira | ✅ PASS |

### S2: Data Freshness
| Question | User | Sources | Result |
|----------|------|---------|--------|
| Payment service runbook | user-oncall | wiki-016 (updated content) | ✅ PASS |

(Freshness timestamp is no longer shown in the chat UI — hidden for security. The update is verified by checking the answer content includes the new failover step.)
| Question | User | Answer | Result |
|----------|------|--------|--------|
| Security incident report | user-contractor | "Evidence insufficient" | ✅ PASS |

(Denied item counts are visible only in the audit trail, not in the chat UI.)

### S4: Permission Change
| Step | wiki-65960 in Sources? | Other Resources? | Result |
|------|------------------------|-----------------|--------|
| Baseline | Yes | Yes | ✅ PASS |
| After DENY | No | Yes | ✅ PASS |
| After RESET | Yes | Yes | ✅ PASS |

### S5: Audit Integrity
| Test | Result | Details |
|------|--------|---------|
| Hash-chain valid after queries | ✅ PASS | All entries chain correctly |
| Tamper detected | ✅ PASS | Tampered entry flagged |
| Admin-only tamper access | ✅ PASS | 403 without admin header |

---

## Known Test Limitations

1. **LIVE API tests**: Slack, Confluence, and Jira connectors are verified LIVE with real API keys. Drive requires a valid (non-expired) OAuth access token to test LIVE.
2. **Gemini API**: Integration tests call the real Gemini API, which may rate-limit or fail if the API key is invalid.
3. **Data freshness**: The 5-minute cache TTL is not explicitly tested with a timer in the test suite. Manual verification confirms updates appear after refresh.
4. **UI hiding**: Provenance (LIVE/MOCK per connector), freshness timestamps, denied/total resource counts, and connector status badges are hidden from both the chat UI and audit trail page. The API responses still contain this data (tests 18-21 verify this), but it is not rendered in the frontend. The server-side audit log (`data/diary.json`) retains all information.
5. **S4 dropdown**: The resource dropdown now uses `loadAppDataLive()` to fetch live API data (same cache as Q&A flow). Previously it only read static JSON files.
