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
  getConnectorStatus,
} = require('./src/dataStore');
const { getFilteredData, getEffectivePermissions } = require('./src/permissions');
const { searchItems } = require('./src/search');
const { generateAnswer, buildAuthorizedContext } = require('./src/answerEngine');
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

// ─── P0-D: Server-side admin authorization ───
// Admin endpoints require ADMIN_API_KEY or the requesting user must have compliance_officer role.
// This is a simple but real server-side check — not a frontend-only toggle.
function requireAdmin(req, res, next) {
  var apiKey = req.headers['x-admin-api-key'] || req.headers['X-Admin-Api-Key'];
  var configuredKey = process.env.ADMIN_API_KEY;

  if (configuredKey && apiKey === configuredKey) {
    return next();
  }

  // Also allow requests that specify a compliance_officer userId (for demo convenience)
  // But this is still a server-side check — the userId must resolve to a real compliance_officer
  var adminUserId = req.headers['x-admin-user-id'] || req.query.adminUserId;
  if (adminUserId) {
    var users = loadUsers();
    var user = users.find(function (u) { return u.id === adminUserId; });
    if (user && user.role === 'compliance_officer') {
      return next();
    }
  }

  return res.status(403).json({
    error: 'Unauthorized. Admin access required. Provide x-admin-api-key header or x-admin-user-id of a compliance_officer.',
  });
}

// ─── Main Q&A endpoint ───
// Core flow: filter → search → build authorized context → call Gemini → log
app.post('/api/ask', async function (req, res) {
  var userId = req.body.userId;
  var query = req.body.query;
  if (!userId || !query) {
    return res.status(400).json({ error: 'userId and query are required' });
  }

  // Step 1: Filter data based on user permissions (BEFORE search/answer/LLM)
  var filtered = await getFilteredData(userId);
  if (!filtered) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Step 2: Search through the already-filtered data only
  var searchResults = searchItems(filtered.filtered, query);

  // Step 3: Record authorization decisions per relevant resource
  var retrievedResourceIds = searchResults.map(function (r) {
    return { app: r.app, id: r.item.id, title: r.item.title, decision: 'ALLOW' };
  });

  // Since search runs on already-filtered data, all search results are authorized
  var authorizedResourceIds = retrievedResourceIds.map(function (r) {
    return { app: r.app, id: r.id, title: r.title, decision: 'ALLOW' };
  });

  // Items sent to LLM (top 8, same as what generateAnswer uses)
  var sentToLlmIds = authorizedResourceIds.slice(0, 8);

  // Step 4: Generate answer via Gemini (or fallback)
  var generated = await generateAnswer(searchResults, query, {
    stats: filtered.stats,
    userId: filtered.user.id,
  });

  // Get connector provenance for audit
  var connectorStatus = getConnectorStatus() || {};
  var provenance = {};
  for (var ck of Object.keys(connectorStatus)) {
    provenance[ck] = {
      status: connectorStatus[ck].status,
      count: connectorStatus[ck].count,
      lastSync: connectorStatus[ck].lastSync,
    };
  }

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
    deniedItems: filtered.deniedItems,
    // Three-tier resource tracking
    retrievedResources: retrievedResourceIds,
    authorizedResources: authorizedResourceIds,
    sentToLlmResources: sentToLlmIds,
    // LLM metadata
    llmMode: generated.adpMode,
    llmRequestId: generated.requestId,
    llmConversationId: generated.conversationId,
    llmVisitorId: generated.visitorId,
    llmTraceId: generated.traceId,
    // Source provenance
    provenance: provenance,
    // Citation IDs returned to user
    citations: generated.sources,
  });

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
    llmMode: generated.adpMode,
    provenance: provenance,
    diaryEntryIndex: entry.index,
    stats: filtered.stats,
    hiddenItems: filtered.hiddenItems,
    deniedItems: filtered.deniedItems,
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

// ═══ ADMIN ENDPOINTS (protected by requireAdmin) ═══

// ─── Change a user's role (Scenario 4: live permission change) ───
app.put('/api/users/:userId/role', requireAdmin, function (req, res) {
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

  // Invalidate cache — permission changes take effect immediately
  refreshLiveCache();

  // Audit the permission change
  var adminId = req.headers['x-admin-user-id'] || req.query.adminUserId || 'system';
  diary.appendEntry({
    userId: userId,
    userName: user.name,
    userRole: newRole,
    query: '[PERMISSION CHANGE]',
    answer: 'Role changed from ' + oldRole + ' to ' + newRole + ' by ' + adminId,
    sources: [],
    platforms: [],
    freshness: null,
    stats: { total: 0, visible: 0, hidden: 0 },
    hiddenItems: [],
    deniedItems: [],
    retrievedResources: [],
    authorizedResources: [],
    sentToLlmResources: [],
    llmMode: 'permission-change',
    llmRequestId: null,
    llmConversationId: null,
    llmVisitorId: null,
    llmTraceId: null,
    provenance: {},
    citations: [],
    permissionChange: { type: 'ROLE_CHANGE', userId: userId, oldRole: oldRole, newRole: newRole, actor: adminId },
  });

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

// ─── Tamper endpoint — ADMIN ONLY (strictly isolated) ───
// This is a destructive audit testing operation, protected by admin auth.
app.post('/api/diary/tamper', requireAdmin, function (req, res) {
  var index = req.body.index;
  var field = req.body.field;
  var newValue = req.body.newValue;
  if (index === undefined || !field || newValue === undefined) {
    return res.status(400).json({ error: 'index, field, and newValue are required' });
  }
  res.json(diary.tamperEntry(index, field, newValue));
});

// ─── App data editing (for the "live edit" demo) — ADMIN PROTECTED ───
app.get('/api/apps/:appKey', requireAdmin, function (req, res) {
  var appKey = req.params.appKey;
  try {
    var items = loadAppData(appKey);
    res.json(items);
  } catch (e) {
    res.status(404).json({ error: 'App not found: ' + appKey });
  }
});

app.put('/api/apps/:appKey/:itemId', requireAdmin, function (req, res) {
  var appKey = req.params.appKey;
  var itemId = req.params.itemId;
  var updates = req.body;
  if (updates.content) {
    updates.lastUpdated = new Date().toISOString();
  }
  var updated = updateAppItem(appKey, itemId, updates);
  if (!updated) {
    return res.status(404).json({ error: 'Item not found' });
  }
  // Invalidate cache so the edit shows up
  refreshLiveCache();
  res.json({ success: true, item: updated });
});

// ─── Permission management ───
app.get('/api/permissions', requireAdmin, function (req, res) {
  res.json(loadPermissions());
});

// Update Slack channel permissions for a user
app.put('/api/permissions/:userId/slack/channels', requireAdmin, function (req, res) {
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
  refreshLiveCache(); // Invalidate cache immediately
  res.json({ success: true, permissions: perms.overrides[userId] });
});

// Update Wiki page restrictions for a user
app.put('/api/permissions/:userId/wiki/items', requireAdmin, function (req, res) {
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
  refreshLiveCache();
  res.json({ success: true, permissions: perms.overrides[userId] });
});

// ═══ P0-E: Generic S4 resource-level permission interface ═══
// Supports ALLOW, DENY, RESET for all platforms and all six personas.
// One shared permission override model for individual resources.
// For Slack, message-level revocation (not channel-level).
app.put('/api/permissions/:userId/resource/:appKey/:itemId', requireAdmin, async function (req, res) {
  var userId = req.params.userId;
  var appKey = req.params.appKey;
  var itemId = req.params.itemId;
  var action = req.body.action; // 'allow', 'deny', or 'reset'

  if (!action || (action !== 'allow' && action !== 'deny' && action !== 'reset')) {
    return res.status(400).json({ error: 'action must be "allow", "deny", or "reset"' });
  }

  var users = loadUsers();
  var user = users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  var perms = loadPermissions();
  if (!perms.overrides[userId]) perms.overrides[userId] = {};

  var result = { success: true, userId: userId, appKey: appKey, itemId: itemId, action: action };

  if (appKey === 'slack') {
    // P0-E: For Slack, DENY a specific message, NOT the entire channel.
    // We track denied message IDs in a deniedItems list for the slack app.
    if (!perms.overrides[userId].slack) {
      // Initialize from user's base permissions
      var baseSlack = user.permissions.slack || {};
      perms.overrides[userId].slack = {
        access: 'channel-based',
        allowedChannels: baseSlack.allowedChannels ? baseSlack.allowedChannels.slice() : [],
        deniedChannels: baseSlack.deniedChannels ? baseSlack.deniedChannels.slice() : [],
        deniedItems: [],
      };
    }
    if (!perms.overrides[userId].slack.deniedItems) {
      perms.overrides[userId].slack.deniedItems = [];
    }

    if (action === 'deny') {
      if (!perms.overrides[userId].slack.deniedItems.includes(itemId)) {
        perms.overrides[userId].slack.deniedItems.push(itemId);
      }
    } else if (action === 'allow') {
      perms.overrides[userId].slack.deniedItems = perms.overrides[userId].slack.deniedItems.filter(function(id) { return id !== itemId; });
    } else if (action === 'reset') {
      perms.overrides[userId].slack.deniedItems = perms.overrides[userId].slack.deniedItems.filter(function(id) { return id !== itemId; });
    }
    result.message = 'Slack message ' + itemId + ' set to ' + action.toUpperCase() + ' for ' + user.name + '. Channel access unchanged.';
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
  refreshLiveCache(); // Invalidate cache — permission changes take effect immediately

  // Audit the permission change
  var adminId = req.headers['x-admin-user-id'] || req.query.adminUserId || 'system';
  diary.appendEntry({
    userId: userId,
    userName: user.name,
    userRole: user.role,
    query: '[PERMISSION CHANGE]',
    answer: result.message + ' by ' + adminId,
    sources: [],
    platforms: [],
    freshness: null,
    stats: { total: 0, visible: 0, hidden: 0 },
    hiddenItems: [],
    deniedItems: [],
    retrievedResources: [],
    authorizedResources: [],
    sentToLlmResources: [],
    llmMode: 'permission-change',
    llmRequestId: null,
    llmConversationId: null,
    llmVisitorId: null,
    llmTraceId: null,
    provenance: {},
    citations: [],
    permissionChange: { type: 'RESOURCE_OVERRIDE', userId: userId, appKey: appKey, itemId: itemId, action: action, actor: adminId },
  });

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
// Reports current state including per-connector status.
app.get('/api/refresh', async function (req, res) {
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
  var connectorStatus = getConnectorStatus();
  res.json({
    status: 'ok',
    lastRefresh: new Date().toISOString(),
    dataSource: isLiveMode() ? 'live' : 'json',
    activeConnectors: connectors,
    connectorStatus: connectorStatus,
    message: isLiveMode()
      ? 'Live API mode. Data fetched from real Slack, Jira, Confluence, Google Drive APIs (5-min cache).'
      : 'JSON file mode. Data re-read from files on every request.',
    appStats: stats,
    userCount: users.length,
  });
});

// ─── Reset permissions for a user (undo demo changes) ───
app.post('/api/permissions/:userId/reset', requireAdmin, function (req, res) {
  var userId = req.params.userId;
  var users = loadUsers();
  var user = users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  var perms = loadPermissions();
  if (perms.overrides[userId]) {
    delete perms.overrides[userId];
    savePermissions(perms);
  }
  refreshLiveCache();

  var result = getEffectivePermissions(userId);
  res.json({
    success: true,
    message: 'Permissions reset to default for ' + user.name,
    permissions: result ? result.permissions : null,
  });
});

// ─── Reset all demo changes ───
app.post('/api/reset', requireAdmin, function (req, res) {
  diary.clearDiary();

  savePermissions({
    overrides: {
      'user-junior': {
        slack: {
          access: 'channel-based',
          allowedChannels: ['#general', '#engineering', '#random', '#design'],
          deniedChannels: ['#security-incidents'],
          deniedItems: [],
        },
      },
      'user-oncall': {
        slack: {
          access: 'channel-based',
          allowedChannels: ['#general', '#engineering', '#random', '#design'],
          deniedChannels: ['#security-incidents'],
          deniedItems: [],
        },
      },
      'user-contractor': {
        slack: {
          access: 'channel-based',
          allowedChannels: ['#general', '#random', '#design'],
          deniedChannels: ['#engineering', '#security-incidents'],
          deniedItems: [],
        },
      },
      'user-custservice': {
        slack: {
          access: 'channel-based',
          allowedChannels: ['#general', '#random', '#design'],
          deniedChannels: ['#engineering', '#security-incidents'],
          deniedItems: [],
        },
      },
      'user-security': {
        slack: {
          access: 'channel-based',
          allowedChannels: ['#general', '#engineering', '#random', '#design', '#security-incidents'],
          deniedChannels: [],
          deniedItems: [],
        },
      },
      'user-compliance': {
        slack: {
          access: 'channel-based',
          allowedChannels: ['#general', '#engineering', '#random', '#design', '#security-incidents'],
          deniedChannels: [],
          deniedItems: [],
        },
      },
    },
  });

  refreshLiveCache();
  res.json({ success: true, message: 'All demo changes reset. Diary cleared, permissions restored to defaults.' });
});

app.listen(PORT, function () {
  console.log('Internal Brain running on http://localhost:' + PORT);
});
