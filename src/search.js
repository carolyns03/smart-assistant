/**
 * Basic keyword search across all app items.
 * Splits the query into keywords and matches against title, content, tags.
 * Returns matching items with a relevance score.
 *
 * @param {Object} filteredData - Already permission-filtered data { wiki, jira, slack, drive }
 * @param {string} query - The user's question
 * @returns {Array<{app, item, score}>} - Matching items sorted by relevance
 */
function searchItems(filteredData, query) {
  // Common synonyms — if the query contains one, also match related terms
  var SYNONYMS = {
    'postgresql': ['pg ', 'postgres', 'database', 'db '],
    'postgres': ['postgresql', 'pg ', 'database', 'db '],
    'database': ['postgres', 'postgresql', 'pg ', 'db '],
    'migration': ['migrate', 'cutover', 'upgrade'],
    'security': ['breach', 'incident', 'vulnerability', 'pentest', 'penetration'],
    'payment': ['stripe', 'checkout', 'billing'],
    'revenue': ['financial', 'finance', 'revenue', 'arr', 'mrr'],
    'financial': ['revenue', 'finance', 'arr', 'mrr'],
    'incident': ['breach', 'security', 'outage', 'error'],
    'deploy': ['deployment', 'release', 'rollout'],
    'auth': ['authentication', 'login', 'sso', 'jwt'],
    'login': ['auth', 'authentication', 'sso'],
    'blocker': ['block', 'blocked', 'blocking', 'issue', 'problem', 'stuck', 'impediment'],
    'blockers': ['blocker', 'block', 'blocked', 'blocking', 'issue', 'problem', 'stuck', 'impediment'],
    'issue': ['problem', 'bug', 'blocker', 'stuck'],
    'problem': ['issue', 'bug', 'blocker', 'stuck'],
    'project': ['initiative', 'effort', 'migration', 'rollout'],
  };

  var rawKeywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter(function (k) { return k.length > 2; })
    .map(function (k) { return k.replace(/[^a-z0-9-]/g, ''); });

  // Stop words that add noise without adding relevance
  var STOP_WORDS = ['what', 'the', 'how', 'who', 'when', 'where', 'why', 'for', 'and', 'are', 'was', 'has', 'have', 'can', 'you', 'tell', 'about', 'status', 'latest', 'recent', 'current', 'our', 'from', 'that', 'this', 'with', 'they', 'been', 'were', 'will', 'would', 'there', 'their', 'any', 'all', 'some', 'each', 'every', 'much', 'many', 'these', 'those', 'show', 'list', 'give', 'find', 'get', 'do', 'does', 'did', 'should'];
  var keywords = rawKeywords.filter(function (k) { return !STOP_WORDS.includes(k); });

  // Expand keywords with synonyms
  var expandedKeywords = [];
  for (var kwi = 0; kwi < keywords.length; kwi++) {
    var kw = keywords[kwi];
    expandedKeywords.push(kw);
    if (SYNONYMS[kw]) {
      expandedKeywords = expandedKeywords.concat(SYNONYMS[kw]);
    }
  }

  if (keywords.length === 0) return [];

  var results = [];

  for (var appKey of Object.keys(filteredData)) {
    for (var item of filteredData[appKey]) {
      var titleLower = (item.title || '').toLowerCase();
      var contentText = (item.content || item.description || '').toLowerCase();
      var tagsLower = (item.tags || []).join(' ').toLowerCase();
      var channelLower = (item.channel || '').toLowerCase();
      var authorLower = (item.author || '').toLowerCase();
      var assigneeLower = (item.assignee || '').toLowerCase();

      var score = 0;

      // Score original keywords (higher weight)
      for (var ki = 0; ki < keywords.length; ki++) {
        var kw = keywords[ki];
        if (titleLower.includes(kw)) score += 5;
        if (contentText.includes(kw)) score += 3;
        if (tagsLower.includes(kw)) score += 3;
        if (channelLower.includes(kw)) score += 2;
        if (authorLower.includes(kw)) score += 2;
        if (assigneeLower.includes(kw)) score += 2;
      }

      // Score synonym matches (lower weight — they're indirect matches)
      for (var si = 0; si < expandedKeywords.length; si++) {
        var syn = expandedKeywords[si];
        if (keywords.includes(syn)) continue; // already scored above
        if (titleLower.includes(syn)) score += 2;
        if (contentText.includes(syn)) score += 2;
        if (tagsLower.includes(syn)) score += 1;
      }

      // Full query phrase match bonus
      var fullQuery = query.toLowerCase().trim();
      if (fullQuery.length > 5) {
        var fullText = [item.title, item.content || item.description, (item.tags || []).join(' ')].join(' ').toLowerCase();
        if (fullText.includes(fullQuery)) {
          score += 10;
        }
      }

      if (score > 0) {
        // Build a human-readable display title.
        // Slack items don't have a "title" field — synthesize one from channel + author + content preview.
        var displayTitle = item.title;
        if (!displayTitle) {
          if (appKey === 'slack') {
            var preview = (item.content || '').substring(0, 60);
            displayTitle = (item.channel || 'unknown') + ' — ' + (item.author || 'unknown') + ': "' + preview + (item.content && item.content.length > 60 ? '..."' : '"');
          } else {
            displayTitle = item.channel || (item.content || '').substring(0, 60) || item.id;
          }
        }

        results.push({
          app: appKey,
          item: {
            id: item.id,
            title: displayTitle,
            originalTitle: item.title || null,
            content: item.content || item.description || '',
            tags: item.tags || [],
            channel: item.channel,
            author: item.author,
            status: item.status,
            assignee: item.assignee,
            priority: item.priority,
            lastUpdated: item.lastUpdated,
            sourceUrl: item.sourceUrl || item.permalink || null,
            timestamp: item.timestamp || item.lastUpdated || null,
          },
          score: score,
        });
      }
    }
  }

  results.sort(function (a, b) { return b.score - a.score; });

  // Cut at a minimum relevance threshold — drop anything that scored below
  // 3 (essentially "matched a generic stop word" or weak synonym only).
  // Then take the top 8.
  var MIN_RELEVANCE_THRESHOLD = 3;
  var filtered = results.filter(function (r) { return r.score >= MIN_RELEVANCE_THRESHOLD; });
  var topResults = filtered.slice(0, 8);

  // Light diversity check: if the top 8 contains NO results from an app
  // that has a meaningfully-scored match (score >= 5), swap in the highest
  // scorer from that app. This prevents irrelevant messages (e.g. "#random —
  // Anyone want to join a lunch order today?") from sneaking in just because
  // they have a tiny keyword match.
  var appsInTop = {};
  topResults.forEach(function (r) { appsInTop[r.app] = true; });

  var appsWithStrongMatches = {};
  for (var ri = 0; ri < filtered.length; ri++) {
    if (filtered[ri].score >= 5) {
      appsWithStrongMatches[filtered[ri].app] = true;
    }
  }

  for (var app of Object.keys(appsWithStrongMatches)) {
    if (appsInTop[app]) continue;

    var bestMissing = null;
    for (var rj = 0; rj < filtered.length; rj++) {
      if (filtered[rj].app === app) {
        if (!bestMissing || filtered[rj].score > bestMissing.score) {
          bestMissing = filtered[rj];
        }
      }
    }
    if (!bestMissing) continue;

    // Evict the lowest-scoring top-8 item ONLY if the missing-app match
    // strictly outscores it.
    var lowestIdx = -1;
    var lowestScore = Infinity;
    for (var tk = 0; tk < topResults.length; tk++) {
      if (topResults[tk].score < lowestScore) {
        lowestScore = topResults[tk].score;
        lowestIdx = tk;
      }
    }
    if (lowestIdx >= 0 && bestMissing.score > lowestScore + 1) {
      topResults[lowestIdx] = bestMissing;
      appsInTop[app] = true;
    }
  }

  return topResults.slice(0, 8);
}

module.exports = { searchItems };
