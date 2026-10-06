/**
 * Answer Engine v2 — Tencent Cloud ADP Integration
 *
 * Architecture:
 *   Authorized Evidence → Context Builder → Tencent Cloud ADP → Grounded Answer + Citations
 *
 * Key security principle:
 *   ADP receives ONLY authorized evidence. Permission filtering happens BEFORE this stage.
 *   Unauthorized content never enters the ADP context.
 *
 * If ADP credentials are not available, falls back to a clearly-labelled demo mode
 * that synthesizes from the same authorized evidence.
 */

const https = require('https');

/**
 * Build the authorized context string to send to ADP.
 * Each evidence item retains: source ID, platform, title, relevant content.
 * DENY resources are never included.
 */
function buildAuthorizedContext(searchResults) {
  var appNameMap = {
    wiki: 'Confluence',
    jira: 'Jira',
    slack: 'Slack',
    drive: 'Google Drive',
  };

  var evidenceParts = [];
  for (var i = 0; i < searchResults.length; i++) {
    var r = searchResults[i];
    var app = r.app;
    var item = r.item;
    var appName = appNameMap[app] || app;
    var sourceId = (app.toUpperCase()) + '-' + item.id;

    var content = '';
    if (app === 'jira') {
      content = item.title + ' [Jira] (Status: ' + item.status + ', Priority: ' + item.priority + ', Assignee: ' + item.assignee + '): ' + item.content;
    } else if (app === 'slack') {
      content = '#' + item.channel + ' [Slack] — ' + item.author + ' said: "' + item.content + '"';
    } else if (app === 'wiki') {
      content = item.title + ' [Confluence]: ' + item.content;
      if (item.lastUpdated) {
        content += ' (last updated: ' + new Date(item.lastUpdated).toLocaleString() + ')';
      }
    } else {
      content = item.title + ' [' + appName + ']: ' + item.content;
    }

    evidenceParts.push(
      'SOURCE_ID: ' + sourceId + '\n' +
      'PLATFORM: ' + appName + '\n' +
      'TITLE: ' + (item.title || item.channel || '') + '\n' +
      'CONTENT:\n' + content
    );
  }

  return evidenceParts.join('\n\n---\n\n');
}

/**
 * Call Tencent Cloud ADP Chat API.
 *
 * Requires environment variables:
 *   ADP_APP_KEY    — the ADP application key
 *   ADP_API_URL    — (optional) the ADP API endpoint URL
 *   ADP_VISITOR_ID — (optional) base visitor ID; per-user suffix is appended
 *
 * @param {string} query - User's question
 * @param {string} authorizedContext - Pre-built authorized evidence context
 * @param {string} userId - Used for session separation (VisitorId)
 * @returns {Promise<{answer, requestId, conversationId, visitorId, traceId, mode}>}
 */
function callAdp(query, authorizedContext, userId) {
  return new Promise(function (resolve, reject) {
    var appKey = process.env.ADP_APP_KEY;
    var apiUrl = process.env.ADP_API_URL || 'https://api.lkeap.tencentcloud.com/v1/app/chat';
    var visitorId = (process.env.ADP_VISITOR_ID || 'internal-brain-') + userId;

    // If no AppKey configured, use fallback mode
    if (!appKey) {
      return resolve(null); // null signals fallback
    }

    var instruction =
      'Answer only from the authorized evidence provided.\n' +
      'Do not invent missing information.\n' +
      'Cite the SOURCE_IDs used in the answer.\n' +
      'Synthesize a clear, natural-language answer (not just a list).\n\n' +
      'USER QUESTION:\n' + query + '\n\n' +
      'AUTHORIZED EVIDENCE:\n' + authorizedContext + '\n\n' +
      'INSTRUCTION:\nAnswer only from the authorized evidence provided. ' +
      'Do not invent missing information. Cite the SOURCE_IDs used in the answer.';

    var body = JSON.stringify({
      content: instruction,
      visitor_id: visitorId,
      // Use a per-user conversation ID to separate sessions
      conversation_id: 'conv-' + userId,
    });

    var urlObj = new URL(apiUrl);
    var options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'AppKey': appKey,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    var req = https.request(options, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          var parsed = JSON.parse(data);
          resolve({
            answer: parsed.reply || parsed.answer || parsed.content || '',
            requestId: parsed.request_id || parsed.RequestId || null,
            conversationId: parsed.conversation_id || parsed.ConversationId || ('conv-' + userId),
            visitorId: visitorId,
            traceId: parsed.trace_id || parsed.TraceId || null,
            mode: 'adp',
          });
        } catch (e) {
          // Parse failed — fall back
          resolve(null);
        }
      });
    });

    req.on('error', function (e) {
      // Network error — fall back
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

/**
 * Fallback answer generation (demo mode) — clearly labelled.
 * Synthesizes from the same authorized evidence without a real LLM.
 */
function fallbackAnswer(searchResults, query) {
  var sources = searchResults.map(function (r) {
    return { app: r.app, id: r.item.id, title: r.item.title };
  });

  var topResults = searchResults.slice(0, 8);
  var parts = [];
  var seenApps = new Set();
  var appNameMap = { wiki: 'Confluence', jira: 'Jira', slack: 'Slack', drive: 'Google Drive' };

  for (var i = 0; i < topResults.length; i++) {
    var result = topResults[i];
    var app = result.app;
    var item = result.item;
    var appName = appNameMap[app] || app;

    var snippet = '';
    if (app === 'jira') {
      snippet = '**' + item.title + '** [Jira] (' + item.status + ', ' + item.priority + ', assigned to ' + item.assignee + '): ' + item.content;
    } else if (app === 'slack') {
      snippet = '**#' + item.channel + '** [Slack] — ' + item.author + ' said: "' + item.content + '"';
    } else if (app === 'wiki') {
      snippet = '**' + item.title + '** [Confluence]: ' + item.content;
      if (item.lastUpdated) {
        snippet += ' (last updated: ' + new Date(item.lastUpdated).toLocaleString() + ')';
      }
    } else {
      snippet = '**' + item.title + '** [' + appName + ']: ' + item.content;
    }

    if (snippet.length > 400) {
      snippet = snippet.substring(0, 397) + '...';
    }

    parts.push(snippet);
    seenApps.add(appName);
  }

  var seenAppsArr = Array.from(seenApps);
  var intro = 'Based on ' + searchResults.length + ' relevant item' + (searchResults.length === 1 ? '' : 's') + ' from ' + seenAppsArr.join(', ') + ':\n\n';
  var answer = intro + parts.join('\n\n');

  var freshness = null;
  for (var j = 0; j < topResults.length; j++) {
    if (topResults[j].item.lastUpdated) {
      freshness = topResults[j].item.lastUpdated;
      break;
    }
  }

  return {
    answer: answer,
    sources: sources,
    platforms: seenAppsArr,
    freshness: freshness,
    adpMode: 'fallback (demo — no ADP AppKey configured)',
    requestId: null,
    conversationId: null,
    visitorId: null,
    traceId: null,
  };
}

/**
 * Generate answer from authorized search results.
 * Calls Tencent Cloud ADP if configured; otherwise uses fallback.
 *
 * @param {Array} searchResults - Already permission-filtered results
 * @param {string} query - The original question
 * @param {Object} options - Optional context
 * @returns {Promise<{answer, sources, platforms, freshness, adpMode, requestId, conversationId, visitorId, traceId}>}
 */
async function generateAnswer(searchResults, query, options) {
  options = options || {};

  if (!searchResults || searchResults.length === 0) {
    return {
      answer: "I couldn't find any information relevant to your question based on the documents and conversations you have access to.",
      sources: [],
      platforms: [],
      freshness: null,
      adpMode: 'no-results',
      requestId: null,
      conversationId: null,
      visitorId: null,
      traceId: null,
    };
  }

  var sources = searchResults.map(function (r) {
    return { app: r.app, id: r.item.id, title: r.item.title };
  });

  var topResults = searchResults.slice(0, 8);
  var seenApps = new Set();
  var appNameMap = { wiki: 'Confluence', jira: 'Jira', slack: 'Slack', drive: 'Google Drive' };
  topResults.forEach(function (r) { seenApps.add(appNameMap[r.app] || r.app); });
  var seenAppsArr = Array.from(seenApps);

  var freshness = null;
  for (var j = 0; j < topResults.length; j++) {
    if (topResults[j].item.lastUpdated) {
      freshness = topResults[j].item.lastUpdated;
      break;
    }
  }

  // Build authorized context (only ALLOW resources)
  var authorizedContext = buildAuthorizedContext(topResults);

  // Try ADP
  var userId = options.userId || 'anonymous';
  var adpResult = await callAdp(query, authorizedContext, userId);

  if (adpResult && adpResult.answer) {
    return {
      answer: adpResult.answer,
      sources: sources,
      platforms: seenAppsArr,
      freshness: freshness,
      adpMode: 'adp',
      requestId: adpResult.requestId,
      conversationId: adpResult.conversationId,
      visitorId: adpResult.visitorId,
      traceId: adpResult.traceId,
    };
  }

  // Fallback
  var fallback = fallbackAnswer(searchResults, query);
  return fallback;
}

module.exports = { generateAnswer, buildAuthorizedContext };
