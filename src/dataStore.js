const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ─── Connector imports (live API mode) ───
const { fetchSlackMessages } = require('./connectors/slackConnector');
const { fetchJiraIssues } = require('./connectors/jiraConnector');
const { fetchConfluencePages } = require('./connectors/confluenceConnector');
const { fetchDriveFiles } = require('./connectors/driveConnector');

// ─── Cache for live API data (TTL: 5 minutes) ───
// This prevents hitting the APIs on every single request.
var liveCache = {
  data: null,       // { wiki, jira, slack, drive }
  timestamp: null,  // Date.now() when cache was populated
  pending: null,    // Promise (if a fetch is in progress)
};

var CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if we should use live API mode.
 * Live mode is enabled when DATA_SOURCE=live is set in .env.
 * Individual connectors activate when their specific credentials are present.
 */
function isLiveMode() {
  return process.env.DATA_SOURCE === 'live';
}

/**
 * Check which connectors have credentials configured.
 */
function getActiveConnectors() {
  return {
    slack: !!(process.env.SLACK_BOT_TOKEN),
    jira: !!(process.env.JIRA_API_TOKEN && process.env.JIRA_EMAIL && process.env.JIRA_BASE_URL),
    wiki: !!(process.env.CONFLUENCE_API_TOKEN && process.env.CONFLUENCE_EMAIL && process.env.CONFLUENCE_BASE_URL),
    drive: !!(process.env.DRIVE_ACCESS_TOKEN),
  };
}

function loadJson(filename) {
  const raw = fs.readFileSync(path.join(DATA_DIR, filename), 'utf8');
  return JSON.parse(raw);
}

/**
 * Fetch all app data. In live mode, tries to fetch from real APIs first,
 * falling back to JSON files for any connector that has no credentials
 * or whose API call fails.
 *
 * @returns {Promise<Object>} { wiki, jira, slack, drive }
 */
async function loadAllApps() {
  // If not in live mode, use JSON files (original behavior)
  if (!isLiveMode()) {
    return {
      wiki: loadJson('wiki.json'),
      jira: loadJson('jira.json'),
      slack: loadJson('slack.json'),
      drive: loadJson('drive.json'),
    };
  }

  // Live mode — check cache first
  var now = Date.now();
  if (liveCache.data && liveCache.timestamp && (now - liveCache.timestamp < CACHE_TTL_MS)) {
    return liveCache.data;
  }

  // If a fetch is already in progress, wait for it
  if (liveCache.pending) {
    return liveCache.pending;
  }

  // Start a new fetch
  liveCache.pending = (async function () {
    var active = getActiveConnectors();
    console.log('[DataStore] Live mode active. Connectors:', JSON.stringify(active));

    // Fetch from each connector in parallel
    // If a connector has no credentials or fails, fall back to JSON
    var results = await Promise.all([
      active.wiki ? fetchConfluencePages() : null,
      active.jira ? fetchJiraIssues() : null,
      active.slack ? fetchSlackMessages() : null,
      active.drive ? fetchDriveFiles() : null,
    ]);

    var confluencePages = results[0];
    var jiraIssues = results[1];
    var slackMessages = results[2];
    var driveFiles = results[3];

    var data = {
      wiki: confluencePages && confluencePages.length > 0 ? confluencePages : loadJson('wiki.json'),
      jira: jiraIssues && jiraIssues.length > 0 ? jiraIssues : loadJson('jira.json'),
      slack: slackMessages && slackMessages.length > 0 ? slackMessages : loadJson('slack.json'),
      drive: driveFiles && driveFiles.length > 0 ? driveFiles : loadJson('drive.json'),
    };

    // Log which sources are live vs fallback
    console.log('[DataStore] Sources:',
      'wiki=' + (confluencePages && confluencePages.length > 0 ? 'LIVE(' + confluencePages.length + ')' : 'JSON'),
      'jira=' + (jiraIssues && jiraIssues.length > 0 ? 'LIVE(' + jiraIssues.length + ')' : 'JSON'),
      'slack=' + (slackMessages && slackMessages.length > 0 ? 'LIVE(' + slackMessages.length + ')' : 'JSON'),
      'drive=' + (driveFiles && driveFiles.length > 0 ? 'LIVE(' + driveFiles.length + ')' : 'JSON')
    );

    liveCache.data = data;
    liveCache.timestamp = Date.now();
    liveCache.pending = null;

    return data;
  })();

  return liveCache.pending;
}

/**
 * Synchronous version for endpoints that don't need live data
 * (e.g., /api/stats, /api/apps/:appKey).
 * Returns JSON file data immediately.
 * In live mode, the async loadAllApps() above is used for the main Q&A flow.
 */
function loadAllAppsSync() {
  return {
    wiki: loadJson('wiki.json'),
    jira: loadJson('jira.json'),
    slack: loadJson('slack.json'),
    drive: loadJson('drive.json'),
  };
}

function loadUsers() {
  return loadJson('users.json');
}

function loadPermissions() {
  try {
    return loadJson('permissions.json');
  } catch {
    return { overrides: {} };
  }
}

function savePermissions(perms) {
  fs.writeFileSync(
    path.join(DATA_DIR, 'permissions.json'),
    JSON.stringify(perms, null, 2)
  );
}

function loadAppData(appKey) {
  const fileMap = {
    wiki: 'wiki.json',
    jira: 'jira.json',
    slack: 'slack.json',
    drive: 'drive.json',
  };
  return loadJson(fileMap[appKey]);
}

function updateAppItem(appKey, itemId, updates) {
  const fileMap = {
    wiki: 'wiki.json',
    jira: 'jira.json',
    slack: 'slack.json',
    drive: 'drive.json',
  };
  const filename = fileMap[appKey];
  const items = loadJson(filename);
  const idx = items.findIndex((i) => i.id === itemId);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...updates };
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(items, null, 2));
  return items[idx];
}

/**
 * Force-refresh the live cache (called by /api/refresh endpoint in live mode).
 */
function refreshLiveCache() {
  liveCache.data = null;
  liveCache.timestamp = null;
}

module.exports = {
  loadAllApps,
  loadAllAppsSync,
  loadUsers,
  loadPermissions,
  savePermissions,
  loadAppData,
  updateAppItem,
  loadJson,
  DATA_DIR,
  isLiveMode,
  getActiveConnectors,
  refreshLiveCache,
};
