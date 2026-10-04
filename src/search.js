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
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 2)
    .map((k) => k.replace(/[^a-z0-9-]/g, ''));

  if (keywords.length === 0) return [];

  const results = [];

  for (const appKey of Object.keys(filteredData)) {
    for (const item of filteredData[appKey]) {
      const searchText = [
        item.title || '',
        item.content || item.description || '',
        (item.tags || []).join(' '),
        item.channel || '',
        item.author || '',
        item.assignee || '',
      ]
        .join(' ')
        .toLowerCase();

      let score = 0;

      for (const kw of keywords) {
        if (item.title && item.title.toLowerCase().includes(kw)) {
          score += 5;
        }
        const contentText = (item.content || item.description || '').toLowerCase();
        if (contentText.includes(kw)) {
          score += 2;
        }
        if (item.tags && item.tags.some((t) => t.toLowerCase().includes(kw))) {
          score += 3;
        }
        if (item.channel && item.channel.toLowerCase().includes(kw)) {
          score += 2;
        }
      }

      const fullQuery = query.toLowerCase().trim();
      if (fullQuery.length > 5) {
        const fullText = [item.title, item.content || item.description, (item.tags || []).join(' ')]
          .join(' ')
          .toLowerCase();
        if (fullText.includes(fullQuery)) {
          score += 10;
        }
      }

      if (score > 0) {
        results.push({
          app: appKey,
          item: {
            id: item.id,
            title: item.title,
            content: item.content || item.description || '',
            tags: item.tags || [],
            channel: item.channel,
            author: item.author,
            status: item.status,
            assignee: item.assignee,
            priority: item.priority,
          },
          score,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 8);
}

module.exports = { searchItems };
