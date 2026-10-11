/**
 * Jira Connector — fetches real issues from the Jira REST API (Cloud)
 *
 * Setup:
 *   1. Go to https://developer.atlassian.com/console/ → Create app
 *   2. Add API: Jira Platform REST API → Configure scopes:
 *      - read:jira-work
 *   3. Authorization → Generate token → copy the token
 *   4. Your base URL is your Jira Cloud URL, e.g. https://yourcompany.atlassian.net
 *
 * Env vars:
 *   JIRA_API_TOKEN    — the API token from Atlassian
 *   JIRA_EMAIL        — the email of your Atlassian account (used for Basic Auth)
 *   JIRA_BASE_URL     — e.g. https://yourcompany.atlassian.net
 *   JIRA_PROJECT_KEY  — (optional) limit to one project, e.g. "ENG"
 */

const https = require('https');

function jiraRequest(baseUrl, email, token, apiPath) {
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
 * @returns {Promise<Array>} — array of { id, title, content, status, assignee, priority, tags, restricted, allowedRoles }
 */
async function fetchJiraIssues() {
  var token = process.env.JIRA_API_TOKEN;
  var email = process.env.JIRA_EMAIL;
  var baseUrl = process.env.JIRA_BASE_URL;
  if (!token || !email || !baseUrl) return null;

  var projectKey = process.env.JIRA_PROJECT_KEY || '';

  // Build JQL query
  var jql = projectKey ? 'project = ' + projectKey + ' ORDER BY updated DESC' : 'ORDER BY updated DESC';

  // Jira Cloud REST API v2
  var apiPath = '/rest/api/2/search?jql=' + encodeURIComponent(jql) + '&maxResults=100&fields=summary,description,status,assignee,priority,labels,issuetype';

  var response = await jiraRequest(baseUrl, email, token, apiPath);
  if (!response || !response.issues) {
    console.error('[Jira] No issues returned');
    return null;
  }

  var items = response.issues.map(function (issue) {
    var fields = issue.fields || {};

    var assignee = fields.assignee ? (fields.assignee.displayName || fields.assignee.name || 'Unassigned') : 'Unassigned';
    var status = fields.status ? (fields.status.name || 'Unknown') : 'Unknown';
    var priority = fields.priority ? (fields.priority.name || 'P3') : 'P3';
    var labels = fields.labels || [];
    var issueType = fields.issuetype ? (fields.issuetype.name || '') : '';

    var description = fields.description || '';
    var title = fields.summary || issue.key;

    if (issueType) labels.push(issueType.toLowerCase());

    // Determine restriction: security-related issues are restricted
    var isSecurity = labels.some(function (l) {
      return l.toLowerCase().includes('security') || l.toLowerCase().includes('vulnerability');
    });

    return {
      id: issue.key,
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
    };
  });

  console.log('[Jira] Fetched', items.length, 'issues');
  return items;
}

module.exports = { fetchJiraIssues };
