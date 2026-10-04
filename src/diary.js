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
    sources: entryData.sources,
    stats: entryData.stats,
    previousFingerprint: previousFingerprint,
  };

  entry.fingerprint = computeFingerprint(previousFingerprint, {
    index: entry.index,
    timestamp: entry.timestamp,
    userId: entry.userId,
    query: entry.query,
    answer: entry.answer,
    sources: entry.sources,
    stats: entry.stats,
  });

  entries.push(entry);
  diary.entries = entries;
  saveDiary(diary);

  return entry;
}

/**
 * Verify the integrity of the diary chain.
 * Recomputes every fingerprint and checks it matches.
 * If any entry was tampered with, the chain breaks and we report which entry.
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
      query: entry.query,
      answer: entry.answer,
      sources: entry.sources,
      stats: entry.stats,
    });

    if (entry.fingerprint !== expectedFingerprint) {
      return {
        valid: false,
        tamperedIndex: i,
        message: 'Tampering detected at entry #' + i + '. The fingerprint does not match. This entry may have been edited or removed.',
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
 * Edits the diary file directly, changing content WITHOUT updating fingerprints.
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
    entries[i].fingerprint = computeFingerprint(previousFingerprint, {
      index: entries[i].index,
      timestamp: entries[i].timestamp,
      userId: entries[i].userId,
      query: entries[i].query,
      answer: entries[i].answer,
      sources: entries[i].sources,
      stats: entries[i].stats,
    });
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
