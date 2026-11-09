import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  assert.equal('user' in result, false);
  assert.match(submittedRequest.url, /\/api\/qq-rewards\/self$/);
  assert.equal(submittedRequest.options.headers.authorization, 'Bearer test-access-token');
  assert.deepEqual(JSON.parse(submittedRequest.options.body).date, '2026-11-04');
  assert.match(JSON.parse(submittedRequest.options.body).request_id, /^[0-9a-f-]{36}$/i);
} finally {
  globalThis.fetch = originalFetch;
}

const refreshFetch = globalThis.fetch;
const refreshRequests = [];
globalThis.fetch = async (url, options = {}) => {
  const request = { url: String(url), options };
  refreshRequests.push(request);
  if (request.url.endsWith('/api/user/auth/refresh')) {
    return new Response(JSON.stringify({
      success: true,
      data: { access_token: 'refreshed-access-token', session: { sid: 'session-sid-123' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (options.headers?.authorization === 'Bearer expired-access-token') {
    return new Response(JSON.stringify({ success: false, message: 'Unauthorized, invalid access token' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (options.method === 'POST') {
    return new Response(JSON.stringify({ success: true, data: { status: 'credited' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({
    success: true,
    data: { activity: { enabled: true }, today: '2026-11-04', today_reward: null },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const result = await runAccount({
    name: 'XKRelay refresh',
    url: 'https://xkrelay.com',
    accessToken: 'expired-access-token',
    session: 'new_api_refresh=session-sid-123.refresh-secret; new_api_has_session=1',
  });
  const refreshRequest = refreshRequests.find(({ url }) => url.endsWith('/api/user/auth/refresh'));

  assert.equal(result.ok, true);
  assert.equal(refreshRequest.options.headers['x-auth-session'], 'session-sid-123');
  assert.equal(refreshRequest.options.headers.cookie, 'new_api_refresh=session-sid-123.refresh-secret; new_api_has_session=1');
  assert.ok(refreshRequests.some(({ options }) => options.headers?.authorization === 'Bearer refreshed-access-token'));
} finally {
  globalThis.fetch = refreshFetch;
}

await assert.rejects(
  runAccount({
    name: '深空 API',
    url: 'https://xkrelay.com',
    session: 'new_api_has_session=1',
    userAgent: '浏览器 User-Agent',
  }),
  /invalid request header "user-agent".*userAgent field/,
);

const rejectedRefreshFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/api/user/auth/refresh')) {
    return new Response(JSON.stringify({ success: false, code: 'AUTH_REFRESH_INVALID' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ success: false, code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
};

try {
  await assert.rejects(
    runAccount({
      name: 'XKRelay rejected refresh',
      url: 'https://xkrelay.com',
      session: 'new_api_refresh=test-refresh; new_api_has_session=1',
    }),
    /access-token refresh failed: HTTP 401 AUTH_REFRESH_INVALID/,
  );
} finally {
  globalThis.fetch = rejectedRefreshFetch;
}

const miniTokenAccount = {
  name: 'MiniToken',
  url: 'https://minitoken.cc',
  accessToken: 'test-login-token',
};
const tokenFluxApi = '/api/v1/plugins/tokenflux.checkin/api';

async function withTokenFluxFetch(handler, verify) {
  const savedFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const { status = 200, body } = handler(String(url), options);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await verify(requests);
  } finally {
    globalThis.fetch = savedFetch;
  }
}

await withTokenFluxFetch(
  () => ({ body: { checked_in: true, notice: '', reward: '0.1' } }),
  async (requests) => {
    const [account] = parseCurlAccounts(`curl 'https://minitoken.cc${tokenFluxApi}/status' -H 'authorization: Bearer test-login-token'`);
    const result = await runAccount(account);
    assert.equal(result.ok, true);
    assert.equal(result.message, 'already checked in today');
    assert.equal(result.data.reward, '0.1');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `https://minitoken.cc${tokenFluxApi}/status`);
    assert.equal(requests[0].options.headers.authorization, 'Bearer test-login-token');
    assert.equal(requests[0].options.headers.referer, 'https://minitoken.cc/ext/tokenflux.checkin');
  },
);

await withTokenFluxFetch(
  (url, options) => ({ body: options.method === 'POST'
    ? { reward: '0.1' }
    : { checked_in: false, reward: '0.1' } }),
  async (requests) => {
    const result = await runAccount({ ...miniTokenAccount, url: 'https://plugin.example', siteType: 'tokenflux-checkin' });
    assert.equal(result.ok, true);
    assert.equal(result.message, 'checkin succeeded');
    assert.equal(result.data.checked_in, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, `https://plugin.example${tokenFluxApi}/checkin`);
    assert.equal(requests[1].options.method, 'POST');
    assert.equal(requests[1].options.body, undefined);
  },
);

for (const field of ['code', 'reason']) {
  await withTokenFluxFetch(
    (url, options) => options.method === 'POST'
      ? { status: 409, body: { [field]: 'ALREADY_CHECKED_IN' } }
      : { body: { checked_in: false, reward: '0.1' } },
    async () => {
      const result = await runAccount(miniTokenAccount);
      assert.equal(result.ok, true);
      assert.equal(result.message, 'already checked in today');
    },
  );
}

for (const body of [{}, { code: 0, data: { checked_in: true } }, { checked_in: 'false' }]) {
  await withTokenFluxFetch(
    () => ({ body }),
    async (requests) => {
      await assert.rejects(runAccount(miniTokenAccount), /expected a checked_in boolean/);
      assert.equal(requests.length, 1);
    },
  );
}

await withTokenFluxFetch(
  () => ({ status: 401, body: { code: 'UNAUTHORIZED', message: '请先登录。' } }),
  async (requests) => {
    await assert.rejects(runAccount(miniTokenAccount), /login token expired or was rejected/);
    assert.equal(requests.length, 1); // Do not call the NewAPI refresh endpoint.
  },
);

for (const status of [401, 403, 500]) {
  await withTokenFluxFetch(
    (url, options) => options.method === 'POST'
      ? { status, body: { message: 'request rejected' } }
      : { body: { checked_in: false, reward: '0.1' } },
    async (requests) => {
      const result = await runAccount(miniTokenAccount);
      assert.equal(result.ok, false);
      assert.match(result.message, status === 401 ? /login token expired/ : new RegExp(`HTTP ${status}`));
      assert.equal(requests.length, 2);
    },
  );
}

await withTokenFluxFetch(
  () => { throw new Error('must not request without login token'); },
  async (requests) => {
    await assert.rejects(runAccount({ url: miniTokenAccount.url }), /missing login credential/);
    await assert.rejects(runAccount({ url: miniTokenAccount.url, session: 'session=cookie-only' }), /missing login credential/);
    assert.equal(requests.length, 0);
  },
);

const dryRunTest = spawnSync(process.execPath, ['--input-type=module', '-', '--dry-run'], {
  encoding: 'utf8',
  input: `
    import assert from 'node:assert/strict';
    import { runAccount } from ${JSON.stringify(new URL('./checkin.js', import.meta.url).href)};
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls += 1;
      assert.ok(url.endsWith('${tokenFluxApi}/status'));
      assert.notEqual(options.method, 'POST');
      return new Response(JSON.stringify({ checked_in: false, reward: '0.1' }));
    };
    const result = await runAccount(${JSON.stringify(miniTokenAccount)});
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(calls, 1);
  `,
});
assert.equal(dryRunTest.status, 0, dryRunTest.stderr || dryRunTest.error?.message);

console.log('checkin tests passed');
