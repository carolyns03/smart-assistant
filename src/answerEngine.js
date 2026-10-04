/**
 * Generate an answer from the search results.
 * Since this is an MVP, the "AI" synthesizes an answer from the
 * pre-filtered search results. The key point: it only ever sees
 * what the permission filter let through.
 *
 * @param {Array} searchResults - Results from the search
 * @param {string} query - The original question
 * @returns {{ answer: string, sources: Array }}
 */
function generateAnswer(searchResults, query) {
  if (!searchResults || searchResults.length === 0) {
    return {
      answer: "I couldn't find anything relevant to your question across the connected apps.",
      sources: [],
    };
  }

  const sources = searchResults.map(function (r) {
    return {
      app: r.app,
      id: r.item.id,
      title: r.item.title,
    };
  });

  var topResults = searchResults.slice(0, 5);
  var parts = [];
  var seenApps = new Set();

  for (var i = 0; i < topResults.length; i++) {
    var result = topResults[i];
    var app = result.app;
    var item = result.item;
    var appName = ({ wiki: 'Wiki', jira: 'Jira', slack: 'Slack', drive: 'Drive' })[app] || app;

    var snippet = '';
    if (app === 'jira') {
      snippet = '**' + item.title + '** (' + item.status + ', ' + item.priority + ', assigned to ' + item.assignee + '): ' + item.content;
    } else if (app === 'slack') {
      snippet = '**' + item.channel + '** — ' + item.author + ' said: "' + item.content + '"';
    } else {
      snippet = '**' + item.title + '** (' + appName + '): ' + item.content;
    }

    if (snippet.length > 300) {
      snippet = snippet.substring(0, 297) + '...';
    }

    parts.push(snippet);
    seenApps.add(appName);
  }

  var seenAppsArr = Array.from(seenApps);
  var intro = 'Based on ' + searchResults.length + ' relevant item' + (searchResults.length === 1 ? '' : 's') + ' from ' + seenAppsArr.join(', ') + ':\n\n';
  var answer = intro + parts.join('\n\n');

  return { answer: answer, sources: sources };
}

module.exports = { generateAnswer };
