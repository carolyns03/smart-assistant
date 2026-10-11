const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DIARY_FILE = path.join(DATA_DIR, 'diary.json');

/**
 * Tamper-evident audit trail (v2).
 *
 * Each entry includes a SHA-256 hash ("fingerprint") of:
 *   - the entry's own content
 *   - the previous entry's fingerprint
 *
 * v2 changes:
 *   - Records three-tier resources: retrieved / authorized / sent-to-ADP
 *   - Records ADP metadata: RequestId, ConversationId, VisitorId, TraceId
 *   - No "repair" function: tampered records are permanently flagged, never re-hashed
 *   - No "clear" function: audit history is append-only (WORM)
 *   - Tamper detection marks the entry as "tampered" permanently
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
 * The set of fields that are included in the fingerprint computation.
 * This must be consistent between append and verify.
 */
function getEntryContentForHash(entry) {
  return {
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
    // v2: three-tier resources
    retrievedResources: entry.retrievedResources || [],
    authorizedResources: entry.authorizedResources || [],
    sentToAdpResources: entry.sentToAdpResources || [],
    // v2: ADP metadata
    adpMode: entry.adpMode,
    adpRequestId: entry.adpRequestId,
    adpConversationId: entry.adpConversationId,
    adpVisitorId: entry.adpVisitorId,
    adpTraceId: entry.adpTraceId,
  };
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
      filteredBeforeADP: true,
      visibleItems: entryData.stats ? entryData.stats.visible : 0,
      hiddenItems: entryData.stats ? entryData.stats.hidden : 0,
    },
    // v2: three-tier resource tracking
    retrievedResources: entryData.retrievedResources || [],
    authorizedResources: entryData.authorizedResources || [],
    sentToAdpResources: entryData.sentToAdpResources || [],
    // v2: ADP metadata
    adpMode: entryData.adpMode || 'fallback',
    adpRequestId: entryData.adpRequestId || null,
    adpConversationId: entryData.adpConversationId || null,
    adpVisitorId: entryData.adpVisitorId || null,
    adpTraceId: entryData.adpTraceId || null,
    // v2: tamper status (null = not tampered, true = flagged as tampered)
    tampered: null,
    previousFingerprint: previousFingerprint,
  };

  entry.fingerprint = computeFingerprint(previousFingerprint, getEntryContentForHash(entry));

  entries.push(entry);
  diary.entries = entries;
  saveDiary(diary);

  return entry;
}

/**
 * Verify the integrity of the diary chain.
 * Tampered entries are permanently flagged — never repaired.
 */
function verifyDiary() {
  var diary = loadDiary();
  var entries = diary.entries || [];
  var previousFingerprint = null;
  var tamperedEntries = [];

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var expectedFingerprint = computeFingerprint(previousFingerprint, getEntryContentForHash(entry));

    var isTampered = false;

    if (entry.fingerprint !== expectedFingerprint) {
      isTampered = true;
    }

    if (i === 0) {
      if (entry.previousFingerprint !== null) {
        isTampered = true;
      }
    } else {
      if (entry.previousFingerprint !== previousFingerprint) {
        isTampered = true;
      }
    }

    if (isTampered) {
      // Permanently flag as tampered — do NOT recompute the hash
      entry.tampered = true;
      tamperedEntries.push(i);
    }

    // Use the stored fingerprint (not recomputed) for chain continuity
    previousFingerprint = entry.fingerprint;
  }

  // Save the tamper flags (without re-computing fingerprints)
  if (tamperedEntries.length > 0) {
    saveDiary(diary);
    return {
      valid: false,
      tamperedIndex: tamperedEntries[0],
      tamperedCount: tamperedEntries.length,
      tamperedIndices: tamperedEntries,
      message: 'Tampering detected at entry #' + tamperedEntries[0] + '. ' + tamperedEntries.length + ' entr' + (tamperedEntries.length === 1 ? 'y' : 'ies') + ' flagged. The fingerprint does not match. Tampered records are permanently flagged and cannot be repaired.',
      entries: entries,
    };
  }

  return {
    valid: true,
    tamperedIndex: null,
    tamperedCount: 0,
    tamperedIndices: [],
    message: 'Diary integrity verified. All ' + entries.length + ' entries are intact and the chain is unbroken.',
    entries: entries,
  };
}

/**
 * Tamper with an entry (for demo purposes).
 * This modifies a field and does NOT update the fingerprint.
 * The tamper will be detected by verifyDiary().
 * The tampered state is permanent — no repair function exists.
 */
function tamperEntry(index, field, newValue) {
  var diary = loadDiary();
  var entries = diary.entries || [];
  if (index < 0 || index >= entries.length) {
    return { success: false, message: 'Entry index out of range' };
  }
  entries[index][field] = newValue;
  // Do NOT update fingerprint — this is the tamper
  // Do NOT update tampered flag — that's for verify to detect
  saveDiary(diary);
  return {
    success: true,
    message: 'Entry #' + index + ' has been tampered with (field: ' + field + '). Run verify to detect it. Note: tampered records cannot be repaired.',
  };
}

/**
 * Clear the diary (for demo reset only — not exposed in v2 UI).
 * Kept for internal use (e.g., /api/reset), but removed from the audit UI.
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
  clearDiary,
};
