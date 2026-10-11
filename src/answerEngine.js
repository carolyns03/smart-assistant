/**
 * Answer Engine v2 — Google Gemini (OpenAI-compatible endpoint) Integration
 *
 * Architecture:
 *   Authorized Evidence → Context Builder → Google Gemini → Grounded Answer + Citations
 *
 * Key security principle:
 *   Gemini receives ONLY authorized evidence. Permission filtering happens BEFORE this stage.
 *   Unauthorized content never enters the LLM context.
 *
 * Uses Google's OpenAI-compatible endpoint:
 *   https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 *
 * Requires environment variables:
 *   GEMINI_API_KEY   — your Google Gemini API key
 *   GEMINI_MODEL     — (optional) model name, defaults to 'gemini-2.0-flash'
 *
 * If GEMINI_API_KEY is not set, falls back to a clearly-labelled demo mode
 * that synthesizes from the same authorized evidence.
 */

const https = require('https');

/**
 * Build the authorized context string to send to Gemini.
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
 * Call Google Gemini via its OpenAI-compatible Chat Completions endpoint.
 *
 * Uses the standard OpenAI request/response format, but points to Google's
 * generativelanguage.googleapis.com server with the Gemini API key as
 * a Bearer token.
 *
 * @param {string} query - User's question
 * @param {string} authorizedContext - Pre-built authorized evidence context
 * @param {string} userId - Used for logging/session identification
 * @returns {Promise<{answer, requestId, conversationId, visitorId, traceId, mode}|null>}
 */
function callGemini(query, authorizedContext, userId) {
  return new Promise(function (resolve, reject) {
    var apiKey = process.env.GEMINI_API_KEY;
    var model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    var apiUrl = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

    // If no API key configured, use fallback mode
    if (!apiKey) {
      return resolve(null); // null signals fallback
    }

    var systemPrompt =
      'You are the Internal Brain — an enterprise knowledge assistant.\n' +
      'Answer ONLY from the authorized evidence provided below.\n' +
      'Do not invent, hallucinate, or paraphrase information not present in the evidence.\n' +
      'Cite the SOURCE_IDs used in your answer inline, e.g. [WIKI-001].\n' +
      'Synthesize a clear, natural-language answer (not just a list).\n' +
      'If the evidence does not contain the answer, say so explicitly.\n';

    var userPrompt =
      'USER QUESTION:\n' + query + '\n\n' +
      'AUTHORIZED EVIDENCE:\n' + authorizedContext + '\n\n' +
      'INSTRUCTION:\nAnswer only from the authorized evidence provided above. ' +
      'Do not invent missing information. Cite the SOURCE_IDs used in the answer.';

    var body = JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,        // Low temperature for factual, grounded answers
      max_tokens: 1024,
    });

    var urlObj = new URL(apiUrl);
    var options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    var req = https.request(options, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          var parsed = JSON.parse(data);

          // Handle API error response
          if (parsed.error) {
            console.error('[Gemini] API error:', parsed.error.message || JSON.stringify(parsed.error));
            return resolve(null); // fall back
          }

          // OpenAI-compatible response format:
          // { choices: [{ message: { content: "..." } }] }
          var answerText = '';
          if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
            answerText = parsed.choices[0].message.content || '';
          } else if (parsed.candidates && parsed.candidates[0]) {
            // Fallback to native Gemini format just in case
            answerText = parsed.candidates[0].content.parts[0].text || '';
          }

          resolve({
            answer: answerText,
            requestId: parsed.id || parsed.requestId || null,
            conversationId: 'conv-' + userId,
            visitorId: userId,
            traceId: parsed.model || model,
            mode: 'gemini',
          });
        } catch (e) {
          console.error('[Gemini] Parse error:', e.message);
          // Parse failed — fall back
          resolve(null);
        }
      });
    });

    req.on('error', function (e) {
      console.error('[Gemini] Network error:', e.message);
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
    adpMode: 'fallback (demo — no GEMINI_API_KEY configured)',
    requestId: null,
    conversationId: null,
    visitorId: null,
    traceId: null,
  };
}

/**
 * Generate answer from authorized search results.
 * Calls Google Gemini if configured; otherwise uses fallback.
 *
 * @param {Array} searchResults - Already permission-filtered results
 * @param {string} query - The original question
 * @param {Object} options - Optional context { userId, stats }
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

  // Try Gemini
  var userId = options.userId || 'anonymous';
  var geminiResult = await callGemini(query, authorizedContext, userId);

  if (geminiResult && geminiResult.answer) {
    return {
      answer: geminiResult.answer,
      sources: sources,
      platforms: seenAppsArr,
      freshness: freshness,
      adpMode: geminiResult.mode,
      requestId: geminiResult.requestId,
      conversationId: geminiResult.conversationId,
      visitorId: geminiResult.visitorId,
      traceId: geminiResult.traceId,
    };
  }

  // Fallback
  var fallback = fallbackAnswer(searchResults, query);
  return fallback;
}

module.exports = { generateAnswer, buildAuthorizedContext };
