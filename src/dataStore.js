const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function loadJson(filename) {
  const raw = fs.readFileSync(path.join(DATA_DIR, filename), 'utf8');
  return JSON.parse(raw);
}

function loadAllApps() {
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

module.exports = {
  loadAllApps,
  loadUsers,
  loadPermissions,
  savePermissions,
  loadAppData,
  updateAppItem,
  DATA_DIR,
};
