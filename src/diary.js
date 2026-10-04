const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DIARY_FILE = path.join(DATA_DIR, 'diary.json');

/**
 * Tamper-proof audit diary.
 *
 * Each entry includes a SHA-256 hash ("fingerprint") of:
 *   - the entry's own content
 *   - the previous entry's fingerprint
 *
 * This creates a chain: if anyone edits or removes an entry,
 * the fingerprints stop matching, and the verify function flags it.
 */

function loadDiary() {
  try {
    var raw = fs.readFileSync(DIARY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { entries: [] };
  }
}

function saveDiary(diary) {
  fs.writeFileSync(DIARY_FILE, JSON.stringify(diary, null, 2));
}

/**
 * Compute the fingerprint for an entry.
 * fingerprint = SHA-256(previousFingerprint + entryContent)
 */
function computeFingerprint(previousFingerprint, entryContent) {
  var data = (previousFingerprint || 'GENESIS') + '|' + JSON.stringify(entryContent);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Append a new diary entry.
 * @param {Object} entryData
 * @returns {Object} The created entry
 */
function appendEntry(entryData) {
  var diary = loadDiary();
  var entries = diary.entries || [];
  var previousEntry = entries[entries.length - 1];
  var previousFingerprint = previousEntry ? previousEntry.fingerprint : null;

  var entry = {
    index: entries.length,
    timestamp: new Date().toISOString(),
    userId: entryData.userId,
    userName: entryData.userName,
    userRole: entryData.userRole,
    query: entryData.query,
    answer: entryData.answer,
    sources: entryData.sources || [],
    platforms: entryData.platforms || [],
    freshness: entryData.freshness || null,
    stats: entryData.stats,
    hiddenItems: entryData.hiddenItems || [],
    authorization: {
      decision: 'ALLOWED',
      method: 'RBAC + channel-based filtering',
      filteredBeforeLLM: true,
      visibleItems: entryData.stats ? entryData.stats.visible : 0,
      hiddenItems: entryData.stats ? entryData.stats.hidden : 0,
    },
    previousFingerprint: previousFingerprint,
  };

  entry.fingerprint = computeFingerprint(previousFingerprint, {
    index: entry.index,
    timestamp: entry.timestamp,
    userId: entry.userId,
    userName: entry.userName,
    userRole: entry.userRole,
    query: entry.query,
    answer: entry.answer,
    sources: entry.sources,
    platforms: entry.platforms,
    freshness: entry.freshness,
    stats: entry.stats,
    hiddenItems: entry.hiddenItems,
    authorization: entry.authorization,
  });

  entries.push(entry);
  diary.entries = entries;
  saveDiary(diary);

  return entry;
}

/**
 * Verify the integrity of the diary chain.
 */
function verifyDiary() {
  var diary = loadDiary();
  var entries = diary.entries || [];
  var previousFingerprint = null;

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var expectedFingerprint = computeFingerprint(previousFingerprint, {
      index: entry.index,
      timestamp: entry.timestamp,
      userId: entry.userId,
      userName: entry.userName,
      userRole: entry.userRole,
      query: entry.query,
      answer: entry.answer,
      sources: entry.sources,
      platforms: entry.platforms,
      freshness: entry.freshness,
      stats: entry.stats,
      hiddenItems: entry.hiddenItems,
      authorization: entry.authorization,
    });

    if (entry.fingerprint !== expectedFingerprint) {
      return {
        valid: false,
        tamperedIndex: i,
        message: 'Tampering detected at entry #' + i + '. The fingerprint does not match.',
        entries: entries,
      };
    }

    if (i === 0) {
      if (entry.previousFingerprint !== null) {
        return {
          valid: false,
          tamperedIndex: i,
          message: 'Tampering detected at entry #' + i + '. The genesis entry should have no previous fingerprint.',
          entries: entries,
        };
      }
    } else {
      if (entry.previousFingerprint !== previousFingerprint) {
        return {
          valid: false,
          tamperedIndex: i,
          message: 'Tampering detected at entry #' + i + '. The link to the previous entry is broken.',
          entries: entries,
        };
      }
    }

    previousFingerprint = entry.fingerprint;
  }

  return {
    valid: true,
    tamperedIndex: null,
    message: 'Diary integrity verified. All ' + entries.length + ' entries are intact and the chain is unbroken.',
    entries: entries,
  };
}

/**
 * Tamper with an entry (for demo purposes).
 */
function tamperEntry(index, field, newValue) {
  var diary = loadDiary();
  var entries = diary.entries || [];
  if (index < 0 || index >= entries.length) {
    return { success: false, message: 'Entry index out of range' };
  }
  entries[index][field] = newValue;
  saveDiary(diary);
  return { success: true, message: 'Entry #' + index + ' has been tampered with (field: ' + field + '). Run verify to detect it.' };
}

/**
 * Repair the diary by recomputing all fingerprints.
 */
function repairDiary() {
  var diary = loadDiary();
  var entries = diary.entries || [];
  var previousFingerprint = null;

  for (var i = 0; i < entries.length; i++) {
    entries[i].previousFingerprint = previousFingerprint;
    var contentForHash = {
      index: entries[i].index,
      timestamp: entries[i].timestamp,
      userId: entries[i].userId,
      userName: entries[i].userName,
      userRole: entries[i].userRole,
      query: entries[i].query,
      answer: entries[i].answer,
      sources: entries[i].sources,
      platforms: entries[i].platforms,
      freshness: entries[i].freshness,
      stats: entries[i].stats,
      hiddenItems: entries[i].hiddenItems,
      authorization: entries[i].authorization,
    };
    entries[i].fingerprint = computeFingerprint(previousFingerprint, contentForHash);
    previousFingerprint = entries[i].fingerprint;
  }

  diary.entries = entries;
  saveDiary(diary);
  return { success: true, message: 'Diary repaired. All fingerprints recomputed.' };
}

/**
 * Clear the diary (for demo reset).
 */
function clearDiary() {
  saveDiary({ entries: [] });
  return { success: true, message: 'Diary cleared.' };
}

module.exports = {
  loadDiary,
  appendEntry,
  verifyDiary,
  tamperEntry,
  repairDiary,
  clearDiary,
};
