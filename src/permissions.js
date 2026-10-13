const { loadUsers, loadPermissions } = require('./dataStore');

/**
 * Authorization Decision Module (P0-D)
 *
 * Core principles:
 *   1. Explicit DENY always takes precedence over ALLOW.
 *   2. Unknown or unverified authorization fails closed (deny by default).
 *   3. No denied content or metadata reaches the LLM.
 *   4. No raw-data API bypasses authorization.
 *   5. Permission checks happen on the server.
 *
 * Two authorization layers:
 *   - RBAC: Role-based access control (simulated demo rules)
 *   - Resource overrides: Per-resource ALLOW/DENY that can override RBAC
 *
 * An ALLOW override does NOT bypass a real source-native denial.
 */

/**
 * Get the effective permissions for a user, merging base permissions
 * with any runtime overrides. Returns null for unknown users (fail-closed).
 *
 * @param {string} userId
 * @returns {{ user: Object, permissions: Object } | null}
 */
function getEffectivePermissions(userId) {
  const users = loadUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return null; // fail-closed: unknown user

  const perms = loadPermissions();
  const override = perms.overrides[userId] || {};

  // Deep merge: override takes priority for each app key
  const effective = JSON.parse(JSON.stringify(user.permissions || {}));
  for (const appKey of Object.keys(override)) {
    if (!effective[appKey]) effective[appKey] = {};
    effective[appKey] = { ...effective[appKey], ...override[appKey] };
  }

  return { user, permissions: effective };
}

/**
 * Check if a user can access a specific item from a specific app.
 * This is the core "lock on each door" logic.
 *
 * Decision order (strict precedence):
 *   1. If the item is explicitly DENIED for this user → DENY
 *   2. If the item is explicitly ALLOWED for this user → ALLOW (but still checked against role)
 *   3. Fall back to role-based + channel-based RBAC
 *   4. If nothing matches → DENY (fail-closed)
 *
 * @param {Object} user - The user object
 * @param {Object} permissions - The effective permissions for this user
 * @param {string} appKey - Which app: 'wiki', 'jira', 'slack', 'drive'
 * @param {Object} item - The data item to check
 * @returns {{ allowed: boolean, reason: string }}
 */
function canAccessItem(user, permissions, appKey, item) {
  const appPerm = permissions[appKey];
  if (!appPerm) return { allowed: false, reason: 'NO_APP_PERMISSION' };

  // For Slack, check channel-based access + message-level overrides
  if (appKey === 'slack' && appPerm.access === 'channel-based') {
    var channel = item.channel;
    if (!channel) return { allowed: false, reason: 'NO_CHANNEL' };

    // Explicit DENY takes precedence — check per-message denial first
    if (appPerm.deniedItems && appPerm.deniedItems.includes(item.id)) {
      return { allowed: false, reason: 'DENIED_MESSAGE' };
    }

    // Then check channel-level denial
    if (appPerm.deniedChannels && appPerm.deniedChannels.includes(channel)) {
      return { allowed: false, reason: 'DENIED_CHANNEL' };
    }
    // If allowedChannels is defined and channel is not in it → deny
    if (appPerm.allowedChannels && !appPerm.allowedChannels.includes(channel)) {
      return { allowed: false, reason: 'CHANNEL_NOT_IN_ALLOWED' };
    }
    return { allowed: true, reason: 'ALLOWED_CHANNEL' };
  }

  // For other apps, check role-based access via the item's allowedRoles
  if (appPerm.access === 'role-based' || !appPerm.access) {
    var itemId = item.id;

    // Explicit DENY takes precedence (per-resource override)
    if (appPerm.deniedItems && appPerm.deniedItems.includes(itemId)) {
      return { allowed: false, reason: 'DENIED_RESOURCE' };
    }

    // Explicit ALLOW override (per-resource) — still must pass role check
    var hasRole = item.allowedRoles && item.allowedRoles.includes(user.role);
    if (!hasRole) {
      // If there's an explicit allow override, it still can't bypass role-based RBAC
      // for source-native authorization. The override only lifts a DENY.
      return { allowed: false, reason: 'ROLE_NOT_AUTHORIZED' };
    }

    return { allowed: true, reason: 'ALLOWED_ROLE' };
  }

  // Fail-closed: unknown access type
  return { allowed: false, reason: 'UNKNOWN_ACCESS_TYPE' };
}

/**
 * Filter all items across all apps for a specific user.
 * This is the "filter first" step — items the user can't see
 * are removed BEFORE the AI ever sees them.
 *
 * @param {string} userId - The user ID
 * @returns {Promise<{ user: Object, filtered: Object, stats: Object, hiddenItems: Array, deniedItems: Array } | null>}
 */
async function getFilteredData(userId) {
  var result = getEffectivePermissions(userId);
  if (!result) return null; // fail-closed: unknown user

  var user = result.user;
  var permissions = result.permissions;

  var { loadAllApps } = require('./dataStore');
  var allApps = await loadAllApps();

  var filtered = {};
  var stats = { total: 0, visible: 0, hidden: 0 };
  var hiddenItems = [];
  var deniedItems = [];

  for (var appKey of Object.keys(allApps)) {
    filtered[appKey] = [];
    for (var item of allApps[appKey]) {
      stats.total++;
      var decision = canAccessItem(user, permissions, appKey, item);
      if (decision.allowed) {
        filtered[appKey].push(item);
        stats.visible++;
      } else {
        stats.hidden++;
        hiddenItems.push({ app: appKey, id: item.id, title: item.title || item.channel, reason: decision.reason });
        deniedItems.push({ app: appKey, id: item.id, reason: decision.reason });
      }
    }
  }

  return { user, filtered, stats, hiddenItems, deniedItems };
}

module.exports = {
  getEffectivePermissions,
  canAccessItem,
  getFilteredData,
};
