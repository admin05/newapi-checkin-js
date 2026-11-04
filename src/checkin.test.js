import assert from 'node:assert/strict';
import { parseCurlAccounts, runAccount } from './checkin.js';

const urlCurl = String.raw`curl --url 'https://chybenzun.top/api/status' \n  -H 'accept: application/json, text/plain, */*' \n  -H 'authorization: Bearer access-token-123' \n  -H 'x-auth-session: sid-123' \n  -H 'new-api-user: 42' \n  -H 'referer: https://chybenzun.top/console/personal' \n  -b 'session=session-token-123; cf_clearance=clearance-token-123'`;
const urlAccounts = parseCurlAccounts(urlCurl);

assert.equal(urlAccounts.length, 1);
assert.equal(urlAccounts[0].url, 'https://chybenzun.top');
assert.equal(urlAccounts[0].accessToken, 'access-token-123');
assert.equal(urlAccounts[0].authSession, 'sid-123');
assert.equal(urlAccounts[0].userId, '42');
assert.equal(urlAccounts[0].referer, 'https://chybenzun.top/console/personal');
assert.match(urlAccounts[0].session, /session=session-token-123/);
assert.match(urlAccounts[0].session, /cf_clearance=clearance-token-123/);

const directCurl = `curl 'https://link-ai.cc/api/status' \\
  -H 'cookie: session=link-session-token' \\
  -H 'origin: https://link-ai.cc'`;
const directAccounts = parseCurlAccounts(directCurl);

assert.equal(directAccounts.length, 1);
assert.equal(directAccounts[0].url, 'https://link-ai.cc');
assert.equal(directAccounts[0].session, 'session=link-session-token');
assert.equal(directAccounts[0].origin, 'https://link-ai.cc');

const originalFetch = globalThis.fetch;
const qqRequests = [];
globalThis.fetch = async (url, options = {}) => {
  qqRequests.push({ url: String(url), options });
  return new Response(JSON.stringify({
    success: true,
    data: {
      activity: { enabled: true },
      today: '2026-11-04',
      today_reward: null,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const result = await runAccount({
    name: 'XKRelay',
    url: 'https://xkrelay.com',
    accessToken: 'test-access-token',
  });
  const submittedRequest = qqRequests.find(({ options }) => options.method === 'POST');

  assert.equal(result.ok, true);
  assert.equal(result.message, 'checkin succeeded');
  assert.match(submittedRequest.url, /\/api\/qq-rewards\/self$/);
  assert.equal(submittedRequest.options.headers.authorization, 'Bearer test-access-token');
  assert.deepEqual(JSON.parse(submittedRequest.options.body).date, '2026-11-04');
  assert.match(JSON.parse(submittedRequest.options.body).request_id, /^[0-9a-f-]{36}$/i);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('checkin parser tests passed');
