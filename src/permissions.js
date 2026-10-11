const { loadUsers, loadPermissions } = require('./dataStore');

/**
 * Get the effective permissions for a user, merging base permissions
 * with any runtime overrides.
 */
function getEffectivePermissions(userId) {
  const users = loadUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return null;

  const perms = loadPermissions();
  const override = perms.overrides[userId] || {};

  // Deep merge: override takes priority over base for slack channel lists
  const effective = JSON.parse(JSON.stringify(user.permissions));
  for (const appKey of Object.keys(override)) {
    effective[appKey] = { ...effective[appKey], ...override[appKey] };
  }

  return { user, permissions: effective };
}

/**
 * Check if a user can access a specific item from a specific app.
 * This is the core "lock on each door" logic.
 *
 * @param {Object} user - The user object
 * @param {Object} permissions - The effective permissions for this user
 * @param {string} appKey - Which app: 'wiki', 'jira', 'slack', 'drive'
 * @param {Object} item - The data item to check
 * @returns {boolean} - true if the user can see this item
 */
function canAccessItem(user, permissions, appKey, item) {
  const appPerm = permissions[appKey];
  if (!appPerm) return false;

  // For Slack, check channel-based access
  if (appKey === 'slack' && appPerm.access === 'channel-based') {
    const channel = item.channel;
    if (appPerm.deniedChannels && appPerm.deniedChannels.includes(channel)) {
      return false;
    }
    if (appPerm.allowedChannels && !appPerm.allowedChannels.includes(channel)) {
      return false;
    }
    return true;
  }

  // For other apps, check role-based access via the item's allowedRoles
  if (appPerm.access === 'role-based') {
    if (item.allowedRoles && item.allowedRoles.includes(user.role)) {
      if (appPerm.deniedItems && appPerm.deniedItems.includes(item.id)) {
        return false;
      }
      return true;
    }
    return false;
  }

  return false;
}

/**
 * Filter all items across all apps for a specific user.
 * This is the "filter first" step — items the user can't see
 * are removed BEFORE the AI ever sees them.
 *
 * Now async to support live API connectors.
 *
 * @param {string} userId - The user ID
 * @returns {Promise<{ user: Object, filtered: Object, stats: Object }>}
 */
async function getFilteredData(userId) {
  const { user, permissions } = getEffectivePermissions(userId);
  if (!user) return null;

  const { loadAllApps } = require('./dataStore');
  const allApps = await loadAllApps();

  const filtered = {};
  const stats = { total: 0, visible: 0, hidden: 0 };
  const hiddenItems = [];

  for (const appKey of Object.keys(allApps)) {
    filtered[appKey] = [];
    for (const item of allApps[appKey]) {
      stats.total++;
      if (canAccessItem(user, permissions, appKey, item)) {
        filtered[appKey].push(item);
        stats.visible++;
      } else {
        stats.hidden++;
        hiddenItems.push({ app: appKey, id: item.id, title: item.title || item.channel });
      }
    }
  }

  return { user, filtered, stats, hiddenItems };
}

module.exports = {
  getEffectivePermissions,
  canAccessItem,
  getFilteredData,
};
