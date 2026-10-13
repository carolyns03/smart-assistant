const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ─── Connector imports (live API mode) ───
const { fetchSlackMessages } = require('./connectors/slackConnector');
const { fetchJiraIssues } = require('./connectors/jiraConnector');
const { fetchConfluencePages } = require('./connectors/confluenceConnector');
const { fetchDriveFiles } = require('./connectors/driveConnector');

// ─── Cache for live API data (TTL: 5 minutes) ───
var liveCache = {
  data: null,       // { wiki, jira, slack, drive }
  timestamp: null,  // Date.now() when cache was populated
  pending: null,    // Promise (if a fetch is in progress)
  connectorStatus: null, // Per-connector status tracking
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
 * Fetch from a single connector with full error handling.
 * Returns { status, data, error } where:
 *   status = 'LIVE' | 'EMPTY' | 'ERROR' | 'MOCK'
 *
 * Never silently falls back to JSON. The caller decides what to do with failures.
 */
async function fetchConnector(name, fetchFn, jsonFile) {
  try {
    var result = await fetchFn();
    if (result === null) {
      // Connector returned null — either no credentials or API error
      return { status: 'ERROR', data: null, error: 'Connector returned null (check credentials or API errors)', source: 'api' };
    }
    if (Array.isArray(result) && result.length === 0) {
      // API succeeded but returned no data — EMPTY, not ERROR
      return { status: 'EMPTY', data: [], error: null, source: 'api' };
    }
    if (Array.isArray(result) && result.length > 0) {
      return { status: 'LIVE', data: result, error: null, source: 'api' };
    }
    // Unexpected response shape
    return { status: 'ERROR', data: null, error: 'Unexpected response shape from connector', source: 'api' };
  } catch (e) {
    return { status: 'ERROR', data: null, error: e.message || 'Unknown connector error', source: 'api' };
  }
}

/**
 * Fetch all app data. In live mode, tries to fetch from real APIs first.
 * For any connector that fails, falls back to JSON but marks it as MOCK.
 *
 * The connectorStatus object tracks per-connector:
 *   status: LIVE | MOCK | EMPTY | ERROR
 *   count: number of items
 *   lastSync: ISO timestamp of last successful sync
 *   lastError: error message or null
 *
 * @returns {Promise<Object>} { wiki, jira, slack, drive }
 */
async function loadAllApps() {
  // If not in live mode, use JSON files (original behavior)
  if (!isLiveMode()) {
    var jsonData = {
      wiki: loadJson('wiki.json'),
      jira: loadJson('jira.json'),
      slack: loadJson('slack.json'),
      drive: loadJson('drive.json'),
    };
    liveCache.connectorStatus = {
      wiki: { status: 'MOCK', count: jsonData.wiki.length, lastSync: null, lastError: null },
      jira: { status: 'MOCK', count: jsonData.jira.length, lastSync: null, lastError: null },
      slack: { status: 'MOCK', count: jsonData.slack.length, lastSync: null, lastError: null },
      drive: { status: 'MOCK', count: jsonData.drive.length, lastSync: null, lastError: null },
    };
    return jsonData;
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
    // If a connector has no credentials, it returns null immediately
    var fetchTasks = [
      active.wiki ? fetchConnector('confluence', fetchConfluencePages, 'wiki.json') : null,
      active.jira ? fetchConnector('jira', fetchJiraIssues, 'jira.json') : null,
      active.slack ? fetchConnector('slack', fetchSlackMessages, 'slack.json') : null,
      active.drive ? fetchConnector('drive', fetchDriveFiles, 'drive.json') : null,
    ];

    var results = await Promise.all(fetchTasks);

    var confluenceResult = results[0];
    var jiraResult = results[1];
    var slackResult = results[2];
    var driveResult = results[3];

    var data = {};
    var status = {};
    var syncTime = new Date().toISOString();

    // For each connector: use LIVE data if available, fall back to JSON (marked as MOCK)
    // Confluence
    if (confluenceResult) {
      if (confluenceResult.status === 'LIVE') {
        data.wiki = confluenceResult.data;
        status.wiki = { status: 'LIVE', count: confluenceResult.data.length, lastSync: syncTime, lastError: null };
      } else if (confluenceResult.status === 'EMPTY') {
        data.wiki = [];
        status.wiki = { status: 'EMPTY', count: 0, lastSync: syncTime, lastError: null };
      } else {
        // ERROR — fall back to JSON but report ERROR, not LIVE
        data.wiki = loadJson('wiki.json');
        status.wiki = { status: 'ERROR', count: data.wiki.length, lastSync: null, lastError: confluenceResult.error };
      }
    } else {
      data.wiki = loadJson('wiki.json');
      status.wiki = { status: 'MOCK', count: data.wiki.length, lastSync: null, lastError: 'No credentials configured' };
    }

    // Jira
    if (jiraResult) {
      if (jiraResult.status === 'LIVE') {
        data.jira = jiraResult.data;
        status.jira = { status: 'LIVE', count: jiraResult.data.length, lastSync: syncTime, lastError: null };
      } else if (jiraResult.status === 'EMPTY') {
        data.jira = [];
        status.jira = { status: 'EMPTY', count: 0, lastSync: syncTime, lastError: null };
      } else {
        data.jira = loadJson('jira.json');
        status.jira = { status: 'ERROR', count: data.jira.length, lastSync: null, lastError: jiraResult.error };
      }
    } else {
      data.jira = loadJson('jira.json');
      status.jira = { status: 'MOCK', count: data.jira.length, lastSync: null, lastError: 'No credentials configured' };
    }

    // Slack
    if (slackResult) {
      if (slackResult.status === 'LIVE') {
        data.slack = slackResult.data;
        status.slack = { status: 'LIVE', count: slackResult.data.length, lastSync: syncTime, lastError: null };
      } else if (slackResult.status === 'EMPTY') {
        data.slack = [];
        status.slack = { status: 'EMPTY', count: 0, lastSync: syncTime, lastError: null };
      } else {
        data.slack = loadJson('slack.json');
        status.slack = { status: 'ERROR', count: data.slack.length, lastSync: null, lastError: slackResult.error };
      }
    } else {
      data.slack = loadJson('slack.json');
      status.slack = { status: 'MOCK', count: data.slack.length, lastSync: null, lastError: 'No credentials configured' };
    }

    // Drive
    if (driveResult) {
      if (driveResult.status === 'LIVE') {
        data.drive = driveResult.data;
        status.drive = { status: 'LIVE', count: driveResult.data.length, lastSync: syncTime, lastError: null };
      } else if (driveResult.status === 'EMPTY') {
        data.drive = [];
        status.drive = { status: 'EMPTY', count: 0, lastSync: syncTime, lastError: null };
      } else {
        data.drive = loadJson('drive.json');
        status.drive = { status: 'ERROR', count: data.drive.length, lastSync: null, lastError: driveResult.error };
      }
    } else {
      data.drive = loadJson('drive.json');
      status.drive = { status: 'MOCK', count: data.drive.length, lastSync: null, lastError: 'No credentials configured' };
    }

    // Log which sources are live vs fallback
    console.log('[DataStore] Sources:',
      'wiki=' + status.wiki.status + '(' + status.wiki.count + ')',
      'jira=' + status.jira.status + '(' + status.jira.count + ')',
      'slack=' + status.slack.status + '(' + status.slack.count + ')',
      'drive=' + status.drive.status + '(' + status.drive.count + ')'
    );

    liveCache.data = data;
    liveCache.connectorStatus = status;
    liveCache.timestamp = Date.now();
    liveCache.pending = null;

    return data;
  })();

  return liveCache.pending;
}

/**
 * Synchronous version for endpoints that don't need live data.
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

/**
 * Async version — returns LIVE API data when in live mode (same data the Q&A flow uses).
 * Falls back to JSON files when not in live mode or cache is empty.
 */
async function loadAppDataLive(appKey) {
  if (isLiveMode()) {
    var allApps = await loadAllApps();
    if (allApps[appKey]) {
      return allApps[appKey];
    }
  }
  return loadAppData(appKey);
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
 * Also invalidates the permission cache.
 */
function refreshLiveCache() {
  liveCache.data = null;
  liveCache.timestamp = null;
  liveCache.connectorStatus = null;
}

/**
 * Get the current connector status (LIVE/MOCK/EMPTY/ERROR per connector).
 */
function getConnectorStatus() {
  return liveCache.connectorStatus || null;
}

module.exports = {
  loadAllApps,
  loadAllAppsSync,
  loadUsers,
  loadPermissions,
  savePermissions,
  loadAppData,
  loadAppDataLive,
  updateAppItem,
  loadJson,
  DATA_DIR,
  isLiveMode,
  getActiveConnectors,
  refreshLiveCache,
  getConnectorStatus,
};
