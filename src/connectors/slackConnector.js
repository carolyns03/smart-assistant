/**
 * Slack Connector — fetches real messages from the Slack Web API
 *
 * Setup:
 *   1. Go to https://api.slack.com/apps → Create New App
 *   2. OAuth & Permissions → add these Bot Token Scopes:
 *      - channels:read       (list public channels)
 *      - channels:history     (read public channel messages)
 *      - groups:read          (list private channels the bot is in)
 *      - groups:history       (read private channel messages)
 *      - users:read.email     (map user IDs to names)
 *   3. Install App → copy the Bot User OAuth Token (starts with xoxb-)
 *   4. Invite the bot to each channel you want to search: /invite @YourBot
 *
 * Env vars:
 *   SLACK_BOT_TOKEN    — xoxb-... bot token
 *   SLACK_CHANNELS     — comma-separated channel list to fetch (e.g. "#general,#engineering")
 *                        if omitted, fetches all channels the bot can see
 */

const https = require('https');

function slackRequest(token, method, params) {
  return new Promise(function (resolve, reject) {
    var query = Object.keys(params || {})
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    var pathStr = '/api/' + method + '?' + query;

    var options = {
      hostname: 'slack.com',
      port: 443,
      path: pathStr,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    };

    var req = https.request(options, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          var parsed = JSON.parse(data);
          if (!parsed.ok) {
            console.error('[Slack] API error for', method, ':', parsed.error);
            return resolve(null);
          }
          resolve(parsed);
        } catch (e) {
          console.error('[Slack] Parse error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', function (e) {
      console.error('[Slack] Network error:', e.message);
      resolve(null);
    });
    req.end();
  });
}

/**
 * Fetch all messages from real Slack channels and normalize them
 * to match the existing slack.json data shape.
 *
 * @returns {Promise<Array>} — array of { id, channel, author, timestamp, content, tags, restricted, allowedRoles }
 */
async function fetchSlackMessages() {
  var token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;

  // Step 1: Get list of channels
  var channelListResponse = await slackRequest(token, 'conversations.list', {
    types: 'public_channel,private_channel',
    limit: 200,
  });

  if (!channelListResponse) return null;

  var allChannels = channelListResponse.channels || [];

  // Filter to configured channels if SLACK_CHANNELS is set
  var configuredChannels = process.env.SLACK_CHANNELS;
  if (configuredChannels) {
    var wanted = configuredChannels.split(',').map(function (c) {
      return c.trim().replace('#', '');
    });
    allChannels = allChannels.filter(function (ch) {
      return wanted.includes(ch.name);
    });
  }

  // Step 2: Build user ID → display name map
  var usersResponse = await slackRequest(token, 'users.list', {});
  var userMap = {};
  if (usersResponse && usersResponse.members) {
    usersResponse.members.forEach(function (u) {
      userMap[u.id] = u.real_name || u.name || 'Unknown';
    });
  }

  // Step 3: Fetch recent messages from each channel
  var allMessages = [];

  for (var i = 0; i < allChannels.length; i++) {
    var channel = allChannels[i];
    var channelName = channel.name;

    var historyResponse = await slackRequest(token, 'conversations.history', {
      channel: channel.id,
      limit: 50, // last 50 messages per channel
    });

    if (!historyResponse || !historyResponse.messages) continue;

    var messages = historyResponse.messages;

    for (var j = messages.length - 1; j >= 0; j--) {
      var msg = messages[j];
      if (msg.type !== 'message' || msg.subtype) continue; // skip bot messages, joins, etc.

      var author = userMap[msg.user] || msg.user || 'Unknown';
      var content = msg.text || '';

      // Skip empty messages
      if (!content.trim()) continue;

      allMessages.push({
        id: 'slack-' + channel.id + '-' + msg.ts.replace(/\./g, '-'),
        channel: '#' + channelName,
        author: author,
        timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
        content: content,
        tags: [channelName, 'slack'],
        restricted: channel.is_private || false,
        allowedRoles: channel.is_private
          ? ['security_team', 'compliance_officer'] // private channels restricted by default
          : ['junior_engineer', 'contractor', 'security_team', 'compliance_officer', 'customer_service'],
      });
    }
  }

  console.log('[Slack] Fetched', allMessages.length, 'messages from', allChannels.length, 'channels');
  return allMessages;
}

module.exports = { fetchSlackMessages };
