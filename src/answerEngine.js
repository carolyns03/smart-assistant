/**
 * Generate an answer from the search results.
 * Since this is an MVP, the "AI" synthesizes an answer from the
 * pre-filtered search results. The key point: it only ever sees
 * what the permission filter let through.
 *
 * @param {Array} searchResults - Results from the search
 * @param {string} query - The original question
 * @param {Object} options - Optional context (e.g. freshness, filteredStats)
 * @returns {{ answer: string, sources: Array, platforms: Array, freshness: string }}
 */
function generateAnswer(searchResults, query, options) {
  options = options || {};

  if (!searchResults || searchResults.length === 0) {
    return {
      answer: "I couldn't find any information relevant to your question based on the documents and conversations you have access to.",
      sources: [],
      platforms: [],
      freshness: null,
    };
  }

  var sources = searchResults.map(function (r) {
    return {
      app: r.app,
      id: r.item.id,
      title: r.item.title,
    };
  });

  var topResults = searchResults.slice(0, 8);
  var parts = [];
  var seenApps = new Set();

  for (var i = 0; i < topResults.length; i++) {
    var result = topResults[i];
    var app = result.app;
    var item = result.item;
    var appName = ({ wiki: 'Confluence', jira: 'Jira', slack: 'Slack', drive: 'Google Drive' })[app] || app;

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

  // Freshness info: find the most recent lastUpdated
  var freshness = null;
  for (var j = 0; j < topResults.length; j++) {
    if (topResults[j].item.lastUpdated) {
      freshness = topResults[j].item.lastUpdated;
      break;
    }
  }

  return { answer: answer, sources: sources, platforms: seenAppsArr, freshness: freshness };
}

module.exports = { generateAnswer };
