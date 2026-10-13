/**
 * Jira Connector — fetches real issues from the Jira REST API (Cloud v3)
 *
 * Setup:
 *   1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
 *   2. Create an API token and copy it
 *   3. Your base URL is your Jira Cloud URL, e.g. https://yourcompany.atlassian.net
 *
 * Env vars:
 *   JIRA_API_TOKEN    — the API token from Atlassian
 *   JIRA_EMAIL        — the email of your Atlassian account (used for Basic Auth)
 *   JIRA_BASE_URL     — e.g. https://yourcompany.atlassian.net
 *   JIRA_PROJECT_KEY  — (optional) limit to one project, e.g. "ENG"
 *
 * Features:
 *   - Preserves issue keys, descriptions, status, URLs, and timestamps
 *   - Handles empty projects separately from API failures
 *   - Supports pagination via nextPageToken
 *   - Extracts plain text from Atlassian Document Format (ADF) descriptions
 *   - Bounded JQL query (updated >= -365d) per v3 API requirement
 */

const https = require('https');

/**
 * Extract plain text from an Atlassian Document Format (ADF) object.
 * ADF structure: { type: 'doc', content: [ { type: 'paragraph', content: [ { type: 'text', text: '...' } ] } ] }
 * Also handles null, undefined, or plain string values.
 */
function extractTextFromADF(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';

  var text = '';
  if (node.text) return node.text;

  if (node.content && Array.isArray(node.content)) {
    for (var i = 0; i < node.content.length; i++) {
      text += extractTextFromADF(node.content[i]);
    }
  }
  return text;
}

function jiraRequest(baseUrl, email, token, apiPath) {
  return new Promise(function (resolve) {
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
        // Handle HTTP error codes
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.error('[Jira] Auth error: HTTP', res.statusCode, '— check JIRA_EMAIL and JIRA_API_TOKEN');
          return resolve(null);
        }
        if (res.statusCode === 404) {
          console.error('[Jira] Not found: HTTP 404 — check JIRA_BASE_URL');
          return resolve(null);
        }
        if (res.statusCode === 410) {
          console.error('[Jira] API endpoint deprecated (HTTP 410) — must use /rest/api/3/search/jql');
          return resolve(null);
        }
        try {
          var parsed = JSON.parse(data);
          if (parsed.errorMessages && parsed.errorMessages.length > 0) {
            console.error('[Jira] API errors:', parsed.errorMessages.join('; '));
            return resolve(null);
          }
          resolve(parsed);
        } catch (e) {
          console.error('[Jira] Parse error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', function (e) {
      console.error('[Jira] Network error:', e.message);
      resolve(null);
    });
    req.end();
  });
}

/**
 * Fetch real Jira issues and normalize them to match jira.json data shape.
 *
 * Distinguishes between:
 *   - API failure (auth error, network error) → returns null (→ ERROR status)
 *   - Empty project (API success, 0 issues) → returns [] (→ EMPTY status)
 *   - Success with issues → returns array (→ LIVE status)
 *
 * @returns {Promise<Array|null>}
 */
async function fetchJiraIssues() {
  var token = process.env.JIRA_API_TOKEN;
  var email = process.env.JIRA_EMAIL;
  var baseUrl = process.env.JIRA_BASE_URL;
  if (!token || !email || !baseUrl) return null;

  var projectKey = process.env.JIRA_PROJECT_KEY || '';

  // Build JQL query — v3 API requires a bounded query (no unbounded "ORDER BY" alone)
  var jqlBase = projectKey ? 'project = ' + projectKey : 'updated >= -365d';
  var jql = projectKey
    ? jqlBase + ' AND updated >= -365d ORDER BY updated DESC'
    : jqlBase + ' ORDER BY updated DESC';

  var allIssues = [];
  var maxResults = 50;
  var nextPageToken = null;
  var isLast = false;

  // Pagination loop — v3 uses nextPageToken instead of startAt/total
  do {
    var apiPath = '/rest/api/3/search/jql?jql=' + encodeURIComponent(jql) +
      '&maxResults=' + maxResults +
      '&fields=summary,description,status,assignee,priority,labels,issuetype,updated,created';

    if (nextPageToken) {
      apiPath += '&nextPageToken=' + encodeURIComponent(nextPageToken);
    }

    var response = await jiraRequest(baseUrl, email, token, apiPath);
    if (!response || !response.issues) {
      // API failure — return null so it's marked as ERROR, not EMPTY
      console.error('[Jira] API call failed');
      return null;
    }

    allIssues = allIssues.concat(response.issues);
    isLast = response.isLast === true || !response.nextPageToken;
    nextPageToken = response.nextPageToken || null;

    // If we've fetched all issues, stop
    if (response.issues.length === 0 || isLast) {
      break;
    }
  } while (nextPageToken);

  // Empty project: API succeeded but returned 0 issues
  if (allIssues.length === 0) {
    console.log('[Jira] No issues found (empty project)');
    return [];
  }

  var items = allIssues.map(function (issue) {
    var fields = issue.fields || {};

    var assignee = fields.assignee ? (fields.assignee.displayName || fields.assignee.name || 'Unassigned') : 'Unassigned';
    var status = fields.status ? (fields.status.name || 'Unknown') : 'Unknown';
    var priority = fields.priority ? (fields.priority.name || 'P3') : 'P3';
    var labels = fields.labels || [];
    var issueType = fields.issuetype ? (fields.issuetype.name || '') : '';

    // Extract plain text from ADF description (v3) or use string directly (v2 fallback)
    var description = extractTextFromADF(fields.description) || '';
    var title = fields.summary || issue.key;

    if (issueType) labels.push(issueType.toLowerCase());

    // Determine restriction: security-related issues are restricted
    var isSecurity = labels.some(function (l) {
      return l.toLowerCase().includes('security') || l.toLowerCase().includes('vulnerability');
    });

    // Build the Jira issue URL
    var issueUrl = baseUrl + '/browse/' + issue.key;

    // Use lastUpdated from the issue's updated field
    var lastUpdated = fields.updated || new Date().toISOString();

    return {
      id: 'jira-' + issue.key, // Use stable issue key (e.g. ENG-123)
      title: title,
      content: description || title,
      status: status,
      assignee: assignee,
      priority: priority,
      tags: labels,
      restricted: isSecurity,
      allowedRoles: isSecurity
        ? ['security_team', 'compliance_officer']
        : ['junior_engineer', 'security_team', 'compliance_officer'],
      lastUpdated: lastUpdated,
      sourceUrl: issueUrl,
    };
  });

  console.log('[Jira] Fetched', items.length, 'issues');
  return items;
}

module.exports = { fetchJiraIssues };
