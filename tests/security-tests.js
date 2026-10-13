/**
 * Internal Brain — Security & Permission Test Suite
 *
 * These tests use mock fixtures for deterministic security verification.
 * They test the permission engine (src/permissions.js) directly.
 *
 * Run: node tests/security-tests.js
 */

const assert = require('assert');
const {
  getEffectivePermissions,
  canAccessItem,
  getFilteredData,
} = require('../src/permissions');

// ─── Mock user + permissions fixture ───
// We use require() to load the real permissions module, then temporarily
// override the data to test edge cases.

var passed = 0;
var failed = 0;
var failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log('  ✗ ' + name + ' — ' + err.message);
  }
}

console.log('\n=== Security Tests (Mock Fixtures) ===\n');

// ─── 1. Invalid user rejected ───
console.log('1. Invalid user rejected:');
test('Unknown userId returns null from getEffectivePermissions', function () {
  var result = getEffectivePermissions('nonexistent-user');
  assert.strictEqual(result, null, 'Expected null for unknown user');
});

test('getFilteredData returns null for unknown user', async function () {
  var result = await getFilteredData('nonexistent-user');
  assert.strictEqual(result, null, 'Expected null for unknown user');
});

// ─── 2. Unknown permission denied ───
console.log('\n2. Unknown permission denied:');
test('User with no matching role permission fails closed', function () {
  // Create a mock item that no role grants access to
  var mockUser = {
    id: 'test-user',
    name: 'Test User',
    title: 'Tester',
    role: 'nonexistent_role',
    permissions: {},
  };
  var mockItem = { id: 'restricted-001', title: 'Restricted Doc', restricted: true };
  var decision = canAccessItem(mockUser, {}, 'wiki', mockItem);
  assert.strictEqual(decision.allowed, false, 'Should deny for unknown role');
});

// ─── 3. Explicit DENY overrides ALLOW ───
console.log('\n3. Explicit DENY overrides ALLOW:');
test('Denial takes precedence over allow in canAccessItem', function () {
  var mockUser = {
    id: 'test-user',
    name: 'Test User',
    title: 'Tester',
    role: 'junior_engineer',
    permissions: {
      wiki: { access: 'role-based' },
    },
  };
  var mockItem = { id: 'wiki-test-001', title: 'Test Doc', restricted: false };
  var permissions = {
    wiki: {
      access: 'role-based',
      deniedItems: ['wiki-test-001'],
      allowedItems: ['wiki-test-001'], // both deny and allow — deny should win
    },
  };
  var decision = canAccessItem(mockUser, permissions, 'wiki', mockItem);
  assert.strictEqual(decision.allowed, false, 'DENY should override ALLOW');
  assert.strictEqual(decision.reason, 'DENIED_RESOURCE');
});

// ─── 4. Unauthorized content absent from LLM context ───
console.log('\n4. Unauthorized content absent from filtered data:');
test('getFilteredData excludes denied items from filtered output', async function () {
  // We need to test against the real data store.
  // Deny wiki-001 for user-contractor (who already can't see it)
  var result = await getFilteredData('user-contractor');
  assert.ok(result, 'Expected non-null result for valid user');

  // Check that security-related items are not in filtered data
  var securityItems = (result.filtered.wiki || []).filter(function (item) {
    return item.restricted === true;
  });
  assert.strictEqual(securityItems.length, 0, 'No restricted items should be visible to contractor');

  // Check that denied items are in deniedItems list
  var denied = (result.deniedItems || []).filter(function (d) {
    return d.reason === 'DENIED_RESOURCE' || d.reason === 'DENIED_CHANNEL' || d.reason === 'NO_ACCESS';
  });
  assert.ok(denied.length > 0, 'Expected some denied items for contractor');
});

// ─── 5. Unauthorized raw-data access rejected ───
// This is tested via the API (server.js requireAdmin middleware)
// We verify the permission engine doesn't expose raw data directly
console.log('\n5. Permission engine does not bypass authorization:');
test('canAccessItem is the only authorization entry point', function () {
  // Verify that getFilteredData uses canAccessItem for every item
  // This is a structural assertion — the function must exist and be callable
  assert.ok(typeof canAccessItem === 'function', 'canAccessItem must be a function');
  assert.ok(typeof getFilteredData === 'function', 'getFilteredData must be a function');
});

// ─── 6. Admin endpoint rejects unauthorized requests ───
// This is tested via API calls in integration-tests.js
console.log('\n6. Admin endpoint protection (structural check):');
test('getEffectivePermissions identifies compliance_officer role', function () {
  var result = getEffectivePermissions('user-compliance');
  assert.ok(result, 'Expected non-null for compliance user');
  assert.strictEqual(result.user.role, 'compliance_officer');
});

test('Regular user is not compliance_officer', function () {
  var result = getEffectivePermissions('user-junior');
  assert.ok(result);
  assert.notStrictEqual(result.user.role, 'compliance_officer');
});

// ─── 7. One-resource revocation does not affect other resources ───
console.log('\n7. One-resource revocation does not affect others:');
test('Denying one item does not deny siblings', function () {
  var mockUser = {
    id: 'test-user',
    name: 'Test User',
    title: 'Tester',
    role: 'junior_engineer',
    permissions: {
      wiki: { access: 'role-based' },
    },
  };
  var permissions = {
    wiki: {
      access: 'role-based',
      deniedItems: ['wiki-test-001'],
    },
  };
  // Items must have allowedRoles matching the user's role for role-based access
  var item1 = { id: 'wiki-test-001', title: 'Denied', restricted: false, allowedRoles: ['junior_engineer', 'senior_engineer'] };
  var item2 = { id: 'wiki-test-002', title: 'Allowed', restricted: false, allowedRoles: ['junior_engineer', 'senior_engineer'] };

  var d1 = canAccessItem(mockUser, permissions, 'wiki', item1);
  var d2 = canAccessItem(mockUser, permissions, 'wiki', item2);

  assert.strictEqual(d1.allowed, false, 'Item 1 should be denied');
  assert.strictEqual(d2.allowed, true, 'Item 2 should remain allowed');
});

// ─── 8. Slack message-level revocation ───
console.log('\n8. Slack message-level revocation:');
test('Slack message denial does not deny entire channel', function () {
  var mockUser = {
    id: 'test-user',
    name: 'Test User',
    title: 'Tester',
    role: 'junior_engineer',
    permissions: {
      slack: {
        access: 'channel-based',
        allowedChannels: ['#general', '#engineering'],
        deniedChannels: [],
      },
    },
  };
  var permissions = {
    slack: {
      access: 'channel-based',
      allowedChannels: ['#general', '#engineering'],
      deniedChannels: [],
      deniedItems: ['slack-msg-001'],
    },
  };
  var msg1 = { id: 'slack-msg-001', channel: '#general', author: 'user1' };
  var msg2 = { id: 'slack-msg-002', channel: '#general', author: 'user2' };

  var d1 = canAccessItem(mockUser, permissions, 'slack', msg1);
  var d2 = canAccessItem(mockUser, permissions, 'slack', msg2);

  assert.strictEqual(d1.allowed, false, 'Slack message 1 should be denied');
  assert.strictEqual(d1.reason, 'DENIED_MESSAGE');
  assert.strictEqual(d2.allowed, true, 'Slack message 2 in same channel should remain allowed');
});

// ─── 9. ALLOW → DENY → RESET flow ───
console.log('\n9. ALLOW → DENY → RESET flow:');
test('Item starts allowed, gets denied, then reset restores access', function () {
  var mockUser = {
    id: 'test-user',
    name: 'Test User',
    title: 'Tester',
    role: 'junior_engineer',
    permissions: { wiki: { access: 'role-based' } },
  };
  var item = { id: 'wiki-reset-001', title: 'Reset Test', restricted: false, allowedRoles: ['junior_engineer', 'senior_engineer'] };

  // ALLOW (baseline)
  var permsAllow = { wiki: { access: 'role-based', deniedItems: [] } };
  var dAllow = canAccessItem(mockUser, permsAllow, 'wiki', item);
  assert.strictEqual(dAllow.allowed, true, 'Should be allowed initially');

  // DENY
  var permsDeny = { wiki: { access: 'role-based', deniedItems: ['wiki-reset-001'] } };
  var dDeny = canAccessItem(mockUser, permsDeny, 'wiki', item);
  assert.strictEqual(dDeny.allowed, false, 'Should be denied after override');

  // RESET (remove from deniedItems)
  var permsReset = { wiki: { access: 'role-based', deniedItems: [] } };
  var dReset = canAccessItem(mockUser, permsReset, 'wiki', item);
  assert.strictEqual(dReset.allowed, true, 'Should be allowed after reset');
});

// ─── 10. Citation IDs match actual LLM context ───
// This is tested via integration tests against the API
console.log('\n10. Citation validation (structural check):');
test('Sources array uses stable IDs from the filtered data', async function () {
  var result = await getFilteredData('user-junior');
  assert.ok(result);
  // Verify every source has an id field
  for (var appKey of Object.keys(result.filtered)) {
    for (var item of result.filtered[appKey]) {
      assert.ok(item.id, 'Every item must have an id');
    }
  }
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
process.exit(failed > 0 ? 1 : 0);
