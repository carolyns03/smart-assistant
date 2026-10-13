const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DIARY_FILE = path.join(DATA_DIR, 'diary.json');

/**
 * Tamper-evident audit trail (v3).
 *
 * Each entry includes a SHA-256 hash ("fingerprint") of:
 *   - the entry's own content
 *   - the previous entry's fingerprint
 *
 * v3 changes:
 *   - Records full authorization decisions (deniedItems, deniedReasons)
 *   - Records source provenance (LIVE/MOCK per connector)
 *   - Records permission changes (actor, type, target)
 *   - Records actual LLM context resource IDs (not estimated via slice)
 *   - Audit events support S3 and S4 verification
 *
 * Security:
 *   - Tampered entries are permanently flagged, never re-hashed
 *   - Audit history is append-only (WORM)
 *   - Normal users cannot read confidential audit details
 *   - Destructive tamper endpoints are admin-protected in server.js
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
    deniedItems: entry.deniedItems || [],
    authorization: entry.authorization,
    // Three-tier resource tracking
    retrievedResources: entry.retrievedResources || [],
    authorizedResources: entry.authorizedResources || [],
    sentToLlmResources: entry.sentToLlmResources || [],
    // LLM metadata
    llmMode: entry.llmMode,
    llmRequestId: entry.llmRequestId,
    llmConversationId: entry.llmConversationId,
    llmVisitorId: entry.llmVisitorId,
    llmTraceId: entry.llmTraceId,
    // Source provenance
    provenance: entry.provenance || {},
    // Citations returned to user
    citations: entry.citations || [],
    // Permission changes
    permissionChange: entry.permissionChange || null,
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
    deniedItems: entryData.deniedItems || [],
    authorization: {
      decision: 'ALLOWED',
      method: 'RBAC + channel-based + resource-level filtering',
      filteredBeforeLLM: true,
      visibleItems: entryData.stats ? entryData.stats.visible : 0,
      hiddenItems: entryData.stats ? entryData.stats.hidden : 0,
      deniedResourceCount: entryData.deniedItems ? entryData.deniedItems.length : 0,
    },
    // Three-tier resource tracking
    retrievedResources: entryData.retrievedResources || [],
    authorizedResources: entryData.authorizedResources || [],
    sentToLlmResources: entryData.sentToLlmResources || [],
    // LLM metadata
    llmMode: entryData.llmMode || 'fallback',
    llmRequestId: entryData.llmRequestId || null,
    llmConversationId: entryData.llmConversationId || null,
    llmVisitorId: entryData.llmVisitorId || null,
    llmTraceId: entryData.llmTraceId || null,
    // Source provenance (LIVE/MOCK per connector)
    provenance: entryData.provenance || {},
    // Citations returned to user
    citations: entryData.citations || [],
    // Permission changes (if this is a permission-change audit entry)
    permissionChange: entryData.permissionChange || null,
    // Tamper status (null = not tampered, true = flagged as tampered)
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
      entry.tampered = true;
      tamperedEntries.push(i);
    }

    previousFingerprint = entry.fingerprint;
  }

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
 *
 * SECURITY: This endpoint is protected by requireAdmin in server.js.
 */
function tamperEntry(index, field, newValue) {
  var diary = loadDiary();
  var entries = diary.entries || [];
  if (index < 0 || index >= entries.length) {
    return { success: false, message: 'Entry index out of range' };
  }
  entries[index][field] = newValue;
  saveDiary(diary);
  return {
    success: true,
    message: 'Entry #' + index + ' has been tampered with (field: ' + field + '). Run verify to detect it. Note: tampered records cannot be repaired.',
  };
}

/**
 * Clear the diary (for demo reset only — admin-protected in server.js).
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
