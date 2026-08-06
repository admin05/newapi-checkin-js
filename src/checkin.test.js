import assert from 'node:assert/strict';
import { parseCurlAccounts } from './checkin.js';

const urlCurl = String.raw`curl --url 'https://chybenzun.top/api/status' \n  -H 'accept: application/json, text/plain, */*' \n  -H 'authorization: Bearer access-token-123' \n  -H 'new-api-user: 42' \n  -H 'referer: https://chybenzun.top/console/personal' \n  -b 'session=session-token-123; cf_clearance=clearance-token-123'`;
const urlAccounts = parseCurlAccounts(urlCurl);

assert.equal(urlAccounts.length, 1);
assert.equal(urlAccounts[0].url, 'https://chybenzun.top');
assert.equal(urlAccounts[0].accessToken, 'access-token-123');
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

console.log('checkin parser tests passed');
