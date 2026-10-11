/**
 * Confluence Connector — fetches real pages from the Confluence Cloud REST API
 *
 * Setup:
 *   1. Go to https://developer.atlassian.com/console/ → Create app (or reuse the same one as Jira)
 *   2. Add API: Confluence Cloud REST API → Configure scopes:
 *      - read:confluence-content
 *      - read:confluence-space
 *   3. Authorization → Generate token → copy the token
 *   4. Your base URL is your Confluence Cloud URL, e.g. https://yourcompany.atlassian.net
 *
 * Env vars:
 *   CONFLUENCE_API_TOKEN  — the API token from Atlassian
 *   CONFLUENCE_EMAIL      — the email of your Atlassian account
 *   CONFLUENCE_BASE_URL   — e.g. https://yourcompany.atlassian.net
 *   CONFLUENCE_SPACE_KEY  — (optional) limit to one space, e.g. "ENG"
 */

const https = require('https');

function confluenceRequest(baseUrl, email, token, apiPath) {
  return new Promise(function (resolve, reject) {
    var urlObj = new URL(baseUrl);
    var auth = Buffer.from(email + ':' + token, 'utf8').toString('base64');

    var options = {
      hostname: urlObj.hostname,
      port: 443,
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Accept': 'application/json',
      },
    };

    var req = https.request(options, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          var parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          console.error('[Confluence] Parse error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', function (e) {
      console.error('[Confluence] Network error:', e.message);
      resolve(null);
    });
    req.end();
  });
}

function stripStorageFormat(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch real Confluence pages and normalize them to match wiki.json data shape.
 * @returns {Promise<Array>}
 */
async function fetchConfluencePages() {
  var token = process.env.CONFLUENCE_API_TOKEN;
  var email = process.env.CONFLUENCE_EMAIL;
  var baseUrl = process.env.CONFLUENCE_BASE_URL;
  if (!token || !email || !baseUrl) return null;

  var spaceKey = process.env.CONFLUENCE_SPACE_KEY;
  var apiBase = '/wiki/rest/api';

  var cql = spaceKey ? 'type=page AND space=' + spaceKey : 'type=page';
  var searchPath = apiBase + '/content/search?cql=' + encodeURIComponent(cql) + '&limit=100&expand=space,version,body.storage,history';

  var searchResponse = await confluenceRequest(baseUrl, email, token, searchPath);
  if (!searchResponse || !searchResponse.results) {
    console.error('[Confluence] No pages returned');
    return null;
  }

  var items = searchResponse.results.map(function (page) {
    var title = page.title || 'Untitled';
    var body = page.body && page.body.storage ? page.body.storage.value : '';
    var content = stripStorageFormat(body) || title;
    var spaceName = page.space ? page.space.name : '';
    var labels = [spaceName ? spaceName.toLowerCase().replace(/\s+/g, '-') : 'confluence'];
    var when = page.version && page.version.when ? page.version.when : null;
    var lastUpdated = when || new Date().toISOString();
    var isSecurity = spaceName.toLowerCase().includes('security') || title.toLowerCase().includes('security') || title.toLowerCase().includes('incident');

    return {
      id: 'wiki-' + page.id,
      title: title,
      content: content,
      tags: labels,
      restricted: isSecurity,
      allowedRoles: isSecurity
        ? ['security_team', 'compliance_officer']
        : ['junior_engineer', 'contractor', 'security_team', 'compliance_officer', 'customer_service'],
      lastUpdated: lastUpdated,
    };
  });

  console.log('[Confluence] Fetched', items.length, 'pages');
  return items;
}

module.exports = { fetchConfluencePages };
