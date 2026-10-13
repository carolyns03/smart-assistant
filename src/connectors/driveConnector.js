/**
 * Google Drive Connector — fetches real file metadata from the Google Drive API
 *
 * Setup:
 *   1. Go to https://console.cloud.google.com/ → Create or select a project
 *   2. Enable the Google Drive API:
 *      APIs & Services → Library → search "Google Drive API" → Enable
 *   3. Create a Service Account (or OAuth 2.0 credential):
 *      APIs & Services → Credentials → Create Credentials → Service Account
 *   4. For Service Account: create a JSON key and save it.
 *      Share the Drive files/folders with the service account email.
 *   5. For OAuth: create an OAuth 2.0 Client ID and get an access token.
 *
 * For the demo, this connector uses a simple OAuth access token approach.
 * You can get a quick access token via the OAuth Playground:
 *   https://developers.google.com/oauthplayground/
 *
 * Env vars:
 *   DRIVE_ACCESS_TOKEN  — a Google OAuth access token with drive.readonly scope
 *   DRIVE_FOLDER_ID     — (optional) limit to a specific shared Drive folder ID
 */

const https = require('https');

function driveRequest(accessToken, apiPath) {
  return new Promise(function (resolve, reject) {
    var options = {
      hostname: 'www.googleapis.com',
      port: 443,
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Accept': 'application/json',
      },
    };

    var req;
    try {
      req = https.request(options, function (res) {
        var data = '';
        res.on('data', function (chunk) { data += chunk; });
        res.on('end', function () {
          try {
            var parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            console.error('[Drive] Parse error:', e.message);
            resolve(null);
          }
        });
      });
    } catch (e) {
      console.error('[Drive] Request error:', e.message);
      return resolve(null);
    }
    req.on('error', function (e) {
      console.error('[Drive] Network error:', e.message);
      resolve(null);
    });
    req.end();
  });
}

/**
 * Export a Google Doc's actual text content via the Drive API export endpoint.
 * For Google Docs (application/vnd.google-apps.document), exports as plain text.
 * @param {string} accessToken
 * @param {string} fileId
 * @returns {Promise<string>} The document body text, or empty string on failure.
 */
function driveExportContent(accessToken, fileId) {
  return new Promise(function (resolve) {
    var apiPath = '/drive/v3/files/' + fileId + '/export?mimeType=text/plain';
    var options = {
      hostname: 'www.googleapis.com',
      port: 443,
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Accept': 'text/plain',
      },
    };

    var req;
    try {
      req = https.request(options, function (res) {
        var data = '';
        res.on('data', function (chunk) { data += chunk; });
        res.on('end', function () {
          if (res.statusCode === 200) {
            resolve(data.trim());
          } else {
            console.error('[Drive] Export error for', fileId, ': HTTP', res.statusCode);
            resolve('');
          }
        });
      });
    } catch (e) {
      console.error('[Drive] Export request error:', e.message);
      return resolve('');
    }
    req.on('error', function (e) {
      console.error('[Drive] Export network error:', e.message);
      resolve('');
    });
    req.end();
  });
}

/**
 * Fetch real Google Drive files and normalize them to match drive.json data shape.
 * @returns {Promise<Array>}
 */
async function fetchDriveFiles() {
  var accessToken = process.env.DRIVE_ACCESS_TOKEN;
  if (!accessToken) return null;

  var query = "trashed=false and mimeType!='application/vnd.google-apps.folder'";
  if (process.env.DRIVE_FOLDER_ID) {
    query = "'" + process.env.DRIVE_FOLDER_ID + "' in parents and " + query;
  }

  var fields = 'files(id,name,mimeType,description,modifiedTime,owners,shared)';
  var apiPath = '/drive/v3/files?q=' + encodeURIComponent(query) + '&pageSize=100&fields=' + encodeURIComponent(fields) + '&orderBy=' + encodeURIComponent('modifiedTime desc');

  var response = await driveRequest(accessToken, apiPath);
  if (!response || !response.files) {
    console.error('[Drive] No files returned');
    return null;
  }

  var items = [];
  for (var i = 0; i < response.files.length; i++) {
    var file = response.files[i];
    var title = file.name || 'Untitled';
    var mimeType = file.mimeType || 'application/octet-stream';
    var isFinancial = title.toLowerCase().includes('financial') || title.toLowerCase().includes('revenue') || title.toLowerCase().includes('salary');
    var typeLabel = 'file';
    if (mimeType.includes('spreadsheet')) typeLabel = 'spreadsheet';
    else if (mimeType.includes('document')) typeLabel = 'document';
    else if (mimeType.includes('pdf')) typeLabel = 'pdf';
    else if (mimeType.includes('image')) typeLabel = 'image';

    // Fetch actual document content for Google Docs
    // Falls back to description or title for non-Google-Doc files
    var content = '';
    if (mimeType === 'application/vnd.google-apps.document') {
      content = await driveExportContent(accessToken, file.id);
    }
    if (!content) {
      content = file.description || title;
    }

    // Extract a clean citation ID from the title (e.g. "DRIVE-002 Atlas Migration Timeline" → "drive-002")
    // Falls back to a zero-padded sequential number
    var idMatch = title.match(/DRIVE-(\d+)/i);
    var cleanId = idMatch ? 'drive-' + idMatch[1].padStart(3, '0') : 'drive-' + String(i + 1).padStart(3, '0');

    items.push({
      id: cleanId,
      title: title,
      type: typeLabel,
      content: content,
      tags: ['drive', typeLabel].concat(isFinancial ? ['restricted'] : []),
      restricted: isFinancial,
      allowedRoles: isFinancial
        ? ['security_team', 'compliance_officer']
        : ['junior_engineer', 'security_team', 'compliance_officer'],
      lastUpdated: file.modifiedTime || new Date().toISOString(),
    });
  }

  console.log('[Drive] Fetched', items.length, 'files');
  return items;
}

module.exports = { fetchDriveFiles };
