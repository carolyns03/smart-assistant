const express = require('express');
const path = require('path');
const {
  loadAllApps,
  loadUsers,
  loadAppData,
  updateAppItem,
  loadPermissions,
  savePermissions,
} = require('./src/dataStore');
const { getFilteredData } = require('./src/permissions');
const { searchItems } = require('./src/search');
const { generateAnswer } = require('./src/answerEngine');
const diary = require('./src/diary');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Main Q&A endpoint ───
// Core flow: filter → search → answer → log
app.post('/api/ask', function (req, res) {
  var userId = req.body.userId;
  var query = req.body.query;
  if (!userId || !query) {
    return res.status(400).json({ error: 'userId and query are required' });
  }

  // Step 1: Filter data based on user permissions (BEFORE search/answer)
  var filtered = getFilteredData(userId);
  if (!filtered) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Step 2: Search through the already-filtered data only
  var searchResults = searchItems(filtered.filtered, query);

  // Step 3: Generate answer from filtered results only
  var generated = generateAnswer(searchResults, query);

  // Step 4: Log to the tamper-proof diary
  var entry = diary.appendEntry({
    userId: filtered.user.id,
    userName: filtered.user.name,
    userRole: filtered.user.role,
    query: query,
    answer: generated.answer,
    sources: generated.sources,
    stats: filtered.stats,
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
    searchResultCount: searchResults.length,
    stats: filtered.stats,
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

// ─── Diary endpoints ───
app.get('/api/diary', function (req, res) {
  res.json(diary.loadDiary());
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

app.post('/api/diary/repair', function (req, res) {
  res.json(diary.repairDiary());
});

app.post('/api/diary/clear', function (req, res) {
  res.json(diary.clearDiary());
});

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

// ─── Stats / overview endpoint ───
app.get('/api/stats', function (req, res) {
  var allApps = loadAllApps();
  var stats = {};
  var total = 0;
  for (var key of Object.keys(allApps)) {
    stats[key] = allApps[key].length;
    total += allApps[key].length;
  }
  stats.total = total;
  res.json(stats);
});

// ─── Refresh / health endpoint ───
// The system re-reads data files on every request, so changes
// show up immediately. This endpoint reports the current state.
app.get('/api/refresh', function (req, res) {
  var allApps = loadAllApps();
  var users = loadUsers();
  var stats = {};
  var total = 0;
  for (var key of Object.keys(allApps)) {
    stats[key] = allApps[key].length;
    total += allApps[key].length;
  }
  stats.total = total;
  res.json({
    status: 'ok',
    lastRefresh: new Date().toISOString(),
    message: 'Data re-read from files on every request. Changes appear immediately.',
    appStats: stats,
    userCount: users.length,
  });
});

app.listen(PORT, function () {
  console.log('Smart Assistant MVP running on http://localhost:' + PORT);
});
