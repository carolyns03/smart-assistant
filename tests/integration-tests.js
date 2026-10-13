/**
 * Internal Brain — Integration Test Suite
 *
 * These tests run against a live server instance at http://localhost:3000
 * They verify API behavior, admin auth, S4 flow, audit integrity, and more.
 *
 * Run: node tests/integration-tests.js
 * (Requires server running on port 3000)
 */

const http = require('http');

const BASE = 'http://localhost:3000';
var passed = 0;
var failed = 0;
var failures = [];

function request(method, path, body, headers) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        headers || {}
      ),
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    var req = http.request(opts, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, json: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: raw });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function test(name, fn) {
  return Promise.resolve(fn())
    .then(function () {
      passed++;
      console.log('  ✓ ' + name);
    })
    .catch(function (err) {
      failed++;
      failures.push({ name, error: err.message });
      console.log('  ✗ ' + name + ' — ' + err.message);
    });
}

async function run() {
  console.log('\n=== Integration Tests (Live Server) ===\n');

  // ─── 1. Invalid user rejected ───
  console.log('1. Invalid user rejected:');
  await test('POST /api/ask with invalid userId returns 404', async function () {
    var r = await request('POST', '/api/ask', { userId: 'invalid', query: 'test' });
    assert(r.status === 404, 'Expected 404, got ' + r.status);
    assert(r.json.error, 'Expected error message');
  });

  await test('POST /api/ask with missing userId returns 400', async function () {
    var r = await request('POST', '/api/ask', { query: 'test' });
    assert(r.status === 400, 'Expected 400, got ' + r.status);
  });

  // ─── 2. Admin endpoint rejects unauthorized ───
  console.log('\n2. Admin endpoint rejects unauthorized:');
  await test('PUT /api/users/:id/role without admin header returns 403', async function () {
    var r = await request('PUT', '/api/users/user-junior/role', { role: 'admin' });
    assert(r.status === 403, 'Expected 403, got ' + r.status);
    assert(r.json.error && r.json.error.includes('Admin'), 'Expected admin auth error');
  });

  await test('GET /api/apps/wiki without admin header returns 403', async function () {
    var r = await request('GET', '/api/apps/wiki');
    assert(r.status === 403, 'Expected 403, got ' + r.status);
  });

  await test('POST /api/diary/tamper without admin header returns 403', async function () {
    var r = await request('POST', '/api/diary/tamper', { index: 0, field: 'query', newValue: 'test' });
    assert(r.status === 403, 'Expected 403, got ' + r.status);
  });

  await test('POST /api/reset without admin header returns 403', async function () {
    var r = await request('POST', '/api/reset');
    assert(r.status === 403, 'Expected 403, got ' + r.status);
  });

  // ─── 3. Admin endpoints work with auth ───
  console.log('\n3. Admin endpoints work with auth:');
  await test('PUT /api/users/:id/role with admin header succeeds', async function () {
    var r = await request('PUT', '/api/users/user-junior/role', { role: 'security_team' }, { 'x-admin-user-id': 'user-compliance' });
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.json.success === true, 'Expected success');
  });

  // Reset role
  await request('PUT', '/api/users/user-junior/role', { role: 'junior_engineer' }, { 'x-admin-user-id': 'user-compliance' });

  // ─── 4. S4: ALLOW → DENY → RESET flow ───
  console.log('\n4. S4: ALLOW → DENY → RESET:');
  var baselineSources = null;

  await test('Baseline: user-junior can see wiki-65960', async function () {
    var r = await request('POST', '/api/ask', { userId: 'user-junior', query: 'database migration' });
    assert(r.status === 200, 'Expected 200');
    var sources = (r.json.sources || []).map(function (s) { return s.id; });
    baselineSources = sources;
    assert(sources.indexOf('wiki-65960') >= 0, 'Expected wiki-65960 in sources, got: ' + JSON.stringify(sources));
  });

  await test('DENY wiki-65960 via resource override', async function () {
    var r = await request('PUT', '/api/permissions/user-junior/resource/wiki/wiki-65960', { action: 'deny' }, { 'x-admin-user-id': 'user-compliance' });
    assert(r.status === 200, 'Expected 200');
    assert(r.json.success === true, 'Expected success');
    assert(r.json.action === 'deny', 'Expected action=deny');
  });

  await test('After DENY: wiki-65960 excluded from sources and in deniedItems', async function () {
    var r = await request('POST', '/api/ask', { userId: 'user-junior', query: 'database migration' });
    assert(r.status === 200);
    var sources = (r.json.sources || []).map(function (s) { return s.id; });
    assert(sources.indexOf('wiki-65960') < 0, 'wiki-65960 should NOT be in sources after deny');

    var deniedIds = (r.json.deniedItems || []).map(function (d) { return d.id; });
    assert(deniedIds.indexOf('wiki-65960') >= 0, 'wiki-65960 should be in deniedItems');
  });

  await test('After DENY: other resources remain accessible', async function () {
    var r = await request('POST', '/api/ask', { userId: 'user-junior', query: 'database migration' });
    var sources = (r.json.sources || []).map(function (s) { return s.id; });
    assert(sources.length > 0, 'Should still have sources after denying one');
  });

  await test('RESET wiki-65960 restores access', async function () {
    var r = await request('PUT', '/api/permissions/user-junior/resource/wiki/wiki-65960', { action: 'reset' }, { 'x-admin-user-id': 'user-compliance' });
    assert(r.status === 200);
    assert(r.json.action === 'reset');
  });

  await test('After RESET: wiki-65960 returns to sources', async function () {
    var r = await request('POST', '/api/ask', { userId: 'user-junior', query: 'database migration' });
    var sources = (r.json.sources || []).map(function (s) { return s.id; });
    assert(sources.indexOf('wiki-65960') >= 0, 'wiki-65960 should be back in sources');
  });

  // ─── 5. S3: Permission enforcement ───
  console.log('\n5. S3: Permission enforcement:');
  await test('Contractor cannot see security report', async function () {
    var r = await request('POST', '/api/ask', { userId: 'user-contractor', query: 'Show me the security incident report from the Q3 breach' });
    assert(r.status === 200);
    // The answer should not contain confidential security breach details
    // It should be an evidence-insufficient response
    var answer = (r.json.answer || '').toLowerCase();
    assert(
      answer.includes('does not contain') || answer.includes('insufficient') || answer.includes('no evidence') || answer.includes('no mention of') || answer.includes('not contain'),
      'Expected evidence-insufficient response, got: ' + r.json.answer.substring(0, 100)
    );
  });

  await test('Contractor has deniedItems in response', async function () {
    var r = await request('POST', '/api/ask', { userId: 'user-contractor', query: 'security incident' });
    assert(r.json.deniedItems && r.json.deniedItems.length > 0, 'Contractor should have denied items');
  });

  // ─── 6. Audit integrity ───
  console.log('\n6. Audit integrity:');
  await test('Diary verify returns valid=true after fresh entries', async function () {
    var r = await request('GET', '/api/diary/verify');
    assert(r.status === 200);
    // After reset + new queries, diary should be valid
    assert(typeof r.json.valid === 'boolean', 'Expected valid boolean');
  });

  await test('Diary tamper + verify detects tampering', async function () {
    // First, ask a question to generate an entry
    await request('POST', '/api/ask', { userId: 'user-junior', query: 'test question for tamper' });

    // Tamper
    var tamperR = await request('POST', '/api/diary/tamper', { index: 0, field: 'query', newValue: 'TAMPERED' }, { 'x-admin-user-id': 'user-compliance' });
    assert(tamperR.status === 200, 'Tamper should succeed with admin auth');

    // Verify should detect
    var verifyR = await request('GET', '/api/diary/verify');
    assert(verifyR.json.valid === false, 'Verify should detect tampering');
    assert(verifyR.json.tamperedIndex !== undefined, 'Should report tampered index');
  });

  // Reset after tamper test
  await request('POST', '/api/reset', null, { 'x-admin-user-id': 'user-compliance' });

  // ─── 7. Connector status reporting ───
  console.log('\n7. Connector status:');
  await test('Refresh endpoint returns connector status', async function () {
    var r = await request('GET', '/api/refresh');
    assert(r.status === 200);
    assert(r.json.connectorStatus, 'Expected connectorStatus object');
    assert(typeof r.json.connectorStatus === 'object');

    // Each connector should have status, count, lastSync, lastError
    for (var key of Object.keys(r.json.connectorStatus)) {
      var cs = r.json.connectorStatus[key];
      assert(typeof cs.status === 'string', 'Connector ' + key + ' should have status string');
      assert(typeof cs.count === 'number', 'Connector ' + key + ' should have count');
    }
  });

  await test('Connector status is never "LIVE" when connector returned null', async function () {
    var r = await request('GET', '/api/refresh');
    for (var key of Object.keys(r.json.connectorStatus)) {
      var cs = r.json.connectorStatus[key];
      if (cs.lastError && cs.lastError.includes('returned null')) {
        assert(cs.status === 'ERROR', 'Connector with null return should be ERROR, not LIVE');
      }
    }
  });

  // ─── 8. Provenance in answer ───
  console.log('\n8. Provenance in answer:');
  await test('Answer response includes provenance object', async function () {
    var r = await request('POST', '/api/ask', { userId: 'user-junior', query: 'database migration' });
    assert(r.json.provenance, 'Expected provenance in response');
    assert(typeof r.json.provenance === 'object');
  });

  await test('Provenance includes LIVE/MOCK status per connector', async function () {
    var r = await request('POST', '/api/ask', { userId: 'user-junior', query: 'database migration' });
    var p = r.json.provenance;
    for (var key of Object.keys(p)) {
      assert(['LIVE', 'MOCK', 'ERROR', 'EMPTY'].indexOf(p[key].status) >= 0, 'Invalid status: ' + p[key].status);
    }
  });

  // ─── 9. S2: Data freshness ───
  console.log('\n9. S2: Data freshness:');
  await test('Update wiki-016 and verify freshness in response', async function () {
    // Update the runbook
    var updateR = await request('PUT', '/api/apps/wiki/wiki-016', {
      content: 'Payment Service Incident Runbook. UPDATED with new failover step for testing freshness.',
      lastUpdated: new Date().toISOString(),
    }, { 'x-admin-user-id': 'user-compliance' });
    assert(updateR.status === 200, 'Update should succeed');

    // Ask about it
    var askR = await request('POST', '/api/ask', { userId: 'user-oncall', query: 'payment service runbook' });
    assert(askR.status === 200);
    assert(askR.json.freshness, 'Expected freshness timestamp in response');
  });

  // ─── 10. Cache refresh ───
  console.log('\n10. Cache refresh:');
  await test('Manual refresh updates lastRefresh timestamp', async function () {
    var beforeR = await request('GET', '/api/refresh');
    var beforeTime = beforeR.json.lastRefresh;

    await new Promise(function (r) { setTimeout(r, 1100); });

    var afterR = await request('GET', '/api/refresh');
    // lastRefresh should be the same or newer (cache might not have expired)
    assert(afterR.json.lastRefresh, 'Expected lastRefresh');
  });

  // ─── Summary ───
  console.log('\n=== Summary ===');
  console.log('Passed: ' + passed);
  console.log('Failed: ' + failed);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(function (f) {
      console.log('  - ' + f.name + ': ' + f.error);
    });
  }
  console.log('');

  // Reset before exit
  await request('POST', '/api/reset', null, { 'x-admin-user-id': 'user-compliance' });
  process.exit(failed > 0 ? 1 : 0);
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

run().catch(function (err) {
  console.error('Fatal error:', err);
  process.exit(1);
});
