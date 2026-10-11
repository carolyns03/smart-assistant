require('dotenv').config();
const express = require('express');
const path = require('path');
const {
  loadAllApps,
  loadAllAppsSync,
  loadUsers,
  loadAppData,
  updateAppItem,
  loadPermissions,
  savePermissions,
  loadJson,
  isLiveMode,
  getActiveConnectors,
  refreshLiveCache,
} = require('./src/dataStore');
const { getFilteredData, getEffectivePermissions } = require('./src/permissions');
const { searchItems } = require('./src/search');
const { generateAnswer } = require('./src/answerEngine');
const diary = require('./src/diary');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helper: save users.json ───
const DATA_DIR = path.join(__dirname, 'data');
function saveUsers(users) {
  fs.writeFileSync(path.join(DATA_DIR, 'users.json'), JSON.stringify(users, null, 2));
}

// ─── Main Q&A endpoint (v2: ADP integration) ───
// Core flow: filter → search → build authorized context → call ADP → log
app.post('/api/ask', async function (req, res) {
  var userId = req.body.userId;
  var query = req.body.query;
  if (!userId || !query) {
    return res.status(400).json({ error: 'userId and query are required' });
  }

  // Step 1: Filter data based on user permissions (BEFORE search/answer/ADP)
  var filtered = await getFilteredData(userId);
  if (!filtered) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Step 2: Search through the already-filtered data only
  var searchResults = searchItems(filtered.filtered, query);

  // Step 3: Record authorization decisions per relevant resource
  //   - retrieved resources: items that matched the search (before permission check on results)
  //   - authorized resources: items the user is allowed to see (already filtered)
  //   - sent to ADP: the authorized items that were included in the ADP context
  var retrievedResourceIds = searchResults.map(function (r) {
    return { app: r.app, id: r.item.id, title: r.item.title, decision: 'ALLOW' };
  });

  // Since search runs on already-filtered data, all search results are authorized
  var authorizedResourceIds = retrievedResourceIds.map(function (r) {
    return { app: r.app, id: r.id, title: r.title, decision: 'ALLOW' };
  });

  // Items sent to ADP (top 8, same as what generateAnswer uses)
  var sentToAdpIds = authorizedResourceIds.slice(0, 8);

  // Step 4: Generate answer via ADP (or fallback)
  var generated = await generateAnswer(searchResults, query, {
    stats: filtered.stats,
    userId: filtered.user.id,
  });

  // Step 5: Log to the tamper-proof audit trail
  var entry = diary.appendEntry({
    userId: filtered.user.id,
    userName: filtered.user.name,
    userRole: filtered.user.role,
    query: query,
    answer: generated.answer,
    sources: generated.sources,
    platforms: generated.platforms,
    freshness: generated.freshness,
    stats: filtered.stats,
    hiddenItems: filtered.hiddenItems,
    // v2: three-tier resource tracking
    retrievedResources: retrievedResourceIds,
    authorizedResources: authorizedResourceIds,
    sentToAdpResources: sentToAdpIds,
    // v2: ADP metadata
    adpMode: generated.adpMode,
    adpRequestId: generated.requestId,
    adpConversationId: generated.conversationId,
    adpVisitorId: generated.visitorId,
    adpTraceId: generated.traceId,
  });

  // v2: Do NOT expose stats/hiddenItems to the normal user (metadata side-channel)
  res.json({
    user: {
      id: filtered.user.id,
      name: filtered.user.name,
      title: filtered.user.title,
      role: filtered.user.role,
    },
    answer: generated.answer,
    sources: generated.sources,
    platforms: generated.platforms,
    freshness: generated.freshness,
    searchResultCount: searchResults.length,
    adpMode: generated.adpMode,
    diaryEntryIndex: entry.index,
  });
});

// ─── Get users list ───
app.get('/api/users', function (req, res) {
  var users = loadUsers().map(function (u) {
    return {
      id: u.id,
      name: u.name,
      title: u.title,
      role: u.role,
      description: u.description,
    };
  });
  res.json(users);
});

// ─── Get a single user's effective permissions ───
app.get('/api/users/:userId/permissions', function (req, res) {
  var result = getEffectivePermissions(req.params.userId);
  if (!result) return res.status(404).json({ error: 'User not found' });
  res.json({
    user: { id: result.user.id, name: result.user.name, title: result.user.title, role: result.user.role },
    permissions: result.permissions,
  });
});

// ─── Change a user's role (Scenario 4: live permission change) ───
app.put('/api/users/:userId/role', function (req, res) {
  var userId = req.params.userId;
  var newRole = req.body.role;
  if (!newRole) return res.status(400).json({ error: 'role is required' });

  var users = loadUsers();
  var user = users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  var oldRole = user.role;
  user.role = newRole;

  // If the role changes, update permissions to match the role template
  var roleTemplates = {
    'junior_engineer': {
      slack: {
        access: 'channel-based',
        allowedChannels: ['#general', '#engineering', '#random', '#design'],
        deniedChannels: ['#security-incidents'],
      },
    },
    'contractor': {
      slack: {
        access: 'channel-based',
        allowedChannels: ['#general', '#random', '#design'],
        deniedChannels: ['#engineering', '#security-incidents'],
      },
    },
    'customer_service': {
      slack: {
        access: 'channel-based',
        allowedChannels: ['#general', '#random', '#design'],
        deniedChannels: ['#engineering', '#security-incidents'],
      },
    },
    'security_team': {
      slack: {
        access: 'channel-based',
        allowedChannels: ['#general', '#engineering', '#random', '#design', '#security-incidents'],
        deniedChannels: [],
      },
    },
    'compliance_officer': {
      slack: {
        access: 'channel-based',
        allowedChannels: ['#general', '#engineering', '#random', '#design', '#security-incidents'],
        deniedChannels: [],
      },
      diary: { access: 'full' },
    },
  };

  var template = roleTemplates[newRole];
  if (template) {
    for (var key of Object.keys(template)) {
      user.permissions[key] = template[key];
    }
  }

  saveUsers(users);

  // Also update the overrides file to keep them in sync
  var perms = loadPermissions();
  if (template && template.slack) {
    if (!perms.overrides[userId]) perms.overrides[userId] = {};
    perms.overrides[userId].slack = template.slack;
  }
  savePermissions(perms);

  res.json({
    success: true,
    userId: userId,
    oldRole: oldRole,
    newRole: newRole,
    message: 'Role changed from ' + oldRole + ' to ' + newRole + '. Subsequent queries will reflect the new permissions immediately.',
  });
});

// ─── Diary endpoints ───
app.get('/api/diary', function (req, res) {
  res.json(diary.loadDiary());
});

// Scenario 5: Audit inquiry — filter by userId
app.get('/api/diary/search', function (req, res) {
  var userId = req.query.userId;
  var d = diary.loadDiary();
  var entries = d.entries || [];
  if (userId) {
    entries = entries.filter((e) => e.userId === userId);
  }
  res.json({ entries: entries, count: entries.length });
});

app.get('/api/diary/verify', function (req, res) {
  res.json(diary.verifyDiary());
});

app.post('/api/diary/tamper', function (req, res) {
  var index = req.body.index;
  var field = req.body.field;
  var newValue = req.body.newValue;
  if (index === undefined || !field || newValue === undefined) {
    return res.status(400).json({ error: 'index, field, and newValue are required' });
  }
  res.json(diary.tamperEntry(index, field, newValue));
});

// v2: Repair and Clear endpoints removed.
//   - Repair: tampered records are permanently flagged, never re-hashed
//   - Clear: audit history is append-only (WORM) in the UI
//   (clearDiary is still used internally by /api/reset for full demo reset)

// ─── App data editing (for the "live edit" demo) ───
app.get('/api/apps/:appKey', function (req, res) {
  var appKey = req.params.appKey;
  try {
    var items = loadAppData(appKey);
    res.json(items);
  } catch (e) {
    res.status(404).json({ error: 'App not found: ' + appKey });
  }
});

app.put('/api/apps/:appKey/:itemId', function (req, res) {
  var appKey = req.params.appKey;
  var itemId = req.params.itemId;
  var updates = req.body;
  // Set lastUpdated timestamp for freshness tracking
  if (updates.content) {
    updates.lastUpdated = new Date().toISOString();
  }
  var updated = updateAppItem(appKey, itemId, updates);
  if (!updated) {
    return res.status(404).json({ error: 'Item not found' });
  }
  res.json({ success: true, item: updated });
});

// ─── Permission management (for the "remove access" demo) ───
app.get('/api/permissions', function (req, res) {
  res.json(loadPermissions());
});

// Update Slack channel permissions for a user
app.put('/api/permissions/:userId/slack/channels', function (req, res) {
  var userId = req.params.userId;
  var allowedChannels = req.body.allowedChannels;
  var deniedChannels = req.body.deniedChannels;
  var perms = loadPermissions();
  if (!perms.overrides[userId]) {
    perms.overrides[userId] = {};
  }
  if (!perms.overrides[userId].slack) {
    perms.overrides[userId].slack = {};
  }
  if (allowedChannels) {
    perms.overrides[userId].slack.allowedChannels = allowedChannels;
  }
  if (deniedChannels) {
    perms.overrides[userId].slack.deniedChannels = deniedChannels;
  }
  savePermissions(perms);
  res.json({ success: true, permissions: perms.overrides[userId] });
});

// Update Wiki page restrictions for a user (add deniedItems)
app.put('/api/permissions/:userId/wiki/items', function (req, res) {
  var userId = req.params.userId;
  var deniedItems = req.body.deniedItems;
  var perms = loadPermissions();
  if (!perms.overrides[userId]) {
    perms.overrides[userId] = {};
  }
  if (!perms.overrides[userId].wiki) {
    perms.overrides[userId].wiki = { access: 'role-based', deniedItems: [] };
  }
  perms.overrides[userId].wiki.deniedItems = deniedItems || [];
  savePermissions(perms);
  res.json({ success: true, permissions: perms.overrides[userId] });
});

// ─── S4: Resource-level permission toggle (ALLOW → DENY without changing role) ───
// This is the clean revocation test: same user, same query, same data,
// only one resource's permission changes ALLOW → DENY.
app.put('/api/permissions/:userId/resource/:appKey/:itemId', async function (req, res) {
  var userId = req.params.userId;
  var appKey = req.params.appKey;
  var itemId = req.params.itemId;
  var action = req.body.action; // 'allow' or 'deny'

  if (!action || (action !== 'allow' && action !== 'deny')) {
    return res.status(400).json({ error: 'action must be "allow" or "deny"' });
  }

  var users = loadUsers();
  var user = users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  var perms = loadPermissions();
  if (!perms.overrides[userId]) perms.overrides[userId] = {};

  var result = { success: true, userId: userId, appKey: appKey, itemId: itemId, action: action };

  if (appKey === 'slack') {
    // For Slack, toggle channel access
    var allApps = await loadAllApps();
    var item = allApps.slack.find((i) => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    var channel = item.channel;

    if (!perms.overrides[userId].slack) {
      perms.overrides[userId].slack = {
        access: 'channel-based',
        allowedChannels: user.permissions.slack ? user.permissions.slack.allowedChannels : [],
        deniedChannels: user.permissions.slack ? user.permissions.slack.deniedChannels : [],
      };
    }

    if (action === 'deny') {
      // Remove from allowed, add to denied
      perms.overrides[userId].slack.allowedChannels = perms.overrides[userId].slack.allowedChannels.filter(function(c) { return c !== channel; });
      if (!perms.overrides[userId].slack.deniedChannels.includes(channel)) {
        perms.overrides[userId].slack.deniedChannels.push(channel);
      }
    } else {
      // allow: remove from denied, add to allowed
      perms.overrides[userId].slack.deniedChannels = perms.overrides[userId].slack.deniedChannels.filter(function(c) { return c !== channel; });
      if (!perms.overrides[userId].slack.allowedChannels.includes(channel)) {
        perms.overrides[userId].slack.allowedChannels.push(channel);
      }
    }
    result.channel = channel;
    result.message = 'Resource ' + appKey + '/' + itemId + ' (channel ' + channel + ') set to ' + action.toUpperCase() + ' for ' + user.name + '. Role unchanged.';
  } else {
    // For wiki/jira/drive, use deniedItems list
    if (!perms.overrides[userId][appKey]) {
      perms.overrides[userId][appKey] = { access: 'role-based', deniedItems: [] };
    }
    if (!perms.overrides[userId][appKey].deniedItems) {
      perms.overrides[userId][appKey].deniedItems = [];
    }

    if (action === 'deny') {
      if (!perms.overrides[userId][appKey].deniedItems.includes(itemId)) {
        perms.overrides[userId][appKey].deniedItems.push(itemId);
      }
    } else {
      perms.overrides[userId][appKey].deniedItems = perms.overrides[userId][appKey].deniedItems.filter(function(id) { return id !== itemId; });
    }
    result.message = 'Resource ' + appKey + '/' + itemId + ' set to ' + action.toUpperCase() + ' for ' + user.name + '. Role unchanged.';
  }

  savePermissions(perms);
  res.json(result);
});

// ─── Stats / overview endpoint ───
app.get('/api/stats', async function (req, res) {
  var allApps = await loadAllApps();
  var stats = {};
  var total = 0;
  for (var key of Object.keys(allApps)) {
    stats[key] = allApps[key].length;
    total += allApps[key].length;
  }
  stats.total = total;
  stats.dataSource = isLiveMode() ? 'live' : 'json';
  res.json(stats);
});

// ─── Refresh / health endpoint ───
// The system re-reads data files on every request, so changes
// show up immediately. This endpoint reports the current state.
app.get('/api/refresh', async function (req, res) {
  // In live mode, clear the cache so next request fetches fresh data
  if (isLiveMode()) {
    refreshLiveCache();
  }
  var allApps = await loadAllApps();
  var users = loadUsers();
  var stats = {};
  var total = 0;
  for (var key of Object.keys(allApps)) {
    stats[key] = allApps[key].length;
    total += allApps[key].length;
  }
  stats.total = total;
  var connectors = isLiveMode() ? getActiveConnectors() : null;
  res.json({
    status: 'ok',
    lastRefresh: new Date().toISOString(),
    dataSource: isLiveMode() ? 'live' : 'json',
    activeConnectors: connectors,
    message: isLiveMode()
      ? 'Live API mode. Data fetched from real Slack, Jira, Confluence, Google Drive APIs (5-min cache).'
      : 'JSON file mode. Data re-read from files on every request.',
    appStats: stats,
    userCount: users.length,
  });
});

// ─── Reset permissions for a user (undo demo changes) ───
app.post('/api/permissions/:userId/reset', function (req, res) {
  var userId = req.params.userId;
  var users = loadUsers();
  var user = users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  var perms = loadPermissions();
  // Remove overrides for this user
  if (perms.overrides[userId]) {
    delete perms.overrides[userId];
    savePermissions(perms);
  }

  // Reload user's original permissions
  var originalUser = users.find((u) => u.id === userId);
  var result = getEffectivePermissions(userId);
  res.json({
    success: true,
    message: 'Permissions reset to default for ' + user.name,
    permissions: result ? result.permissions : null,
  });
});

// ─── Reset all demo changes ───
app.post('/api/reset', function (req, res) {
  // Clear diary
  diary.clearDiary();

  // Reset permissions overrides
  savePermissions({
    overrides: {
      'user-junior': {
        slack: {
          allowedChannels: ['#general', '#engineering', '#random', '#design'],
          deniedChannels: ['#security-incidents'],
        },
      },
      'user-oncall': {
        slack: {
          allowedChannels: ['#general', '#engineering', '#random', '#design'],
          deniedChannels: ['#security-incidents'],
        },
      },
      'user-contractor': {
        slack: {
          allowedChannels: ['#general', '#random', '#design'],
          deniedChannels: ['#engineering', '#security-incidents'],
        },
      },
      'user-custservice': {
        slack: {
          allowedChannels: ['#general', '#random', '#design'],
          deniedChannels: ['#engineering', '#security-incidents'],
        },
      },
      'user-security': {
        slack: {
          allowedChannels: ['#general', '#engineering', '#random', '#design', '#security-incidents'],
          deniedChannels: [],
        },
      },
      'user-compliance': {
        slack: {
          allowedChannels: ['#general', '#engineering', '#random', '#design', '#security-incidents'],
          deniedChannels: [],
        },
      },
    },
  });

  res.json({ success: true, message: 'All demo changes reset. Diary cleared, permissions restored to defaults.' });
});

app.listen(PORT, function () {
  console.log('Internal Brain running on http://localhost:' + PORT);
});
