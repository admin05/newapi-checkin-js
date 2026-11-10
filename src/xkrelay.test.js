import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAccount } from './checkin.js';
import { cookieHeader, refreshCookie, seedCookies, updateCookies } from './cookies.js';
import { getSetCookies } from './http.js';

const directory = mkdtempSync(join(tmpdir(), 'newapi-xkrelay-test-'));
const oldPath = process.env.NEWAPI_XKRELAY_STATE_FILE;
const oldTransport = process.env.NEWAPI_XKRELAY_REFRESH_TRANSPORT;
const originalFetch = globalThis.fetch;
const origin = 'https://xk.example';
const refreshUrl = `${origin}/api/user/auth/refresh`;
const baseAccount = {
  url: origin, siteType: 'xkrelay-qq', accessToken: 'expired', authSession: 'stale-sid',
  session: 'new_api_refresh=test-sid.old; new_api_has_session=1; unrelated=keep',
  extraHeaders: { Cookie: 'new_api_refresh=wrong.secret', Authorization: 'Bearer stale', 'X-Auth-Session': 'stale' },
};
const json = (body, status = 200, cookies = []) => {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
};
const refreshed = (cookies = ['new_api_refresh=test-sid.new; Path=/api/user/auth; Secure; HttpOnly']) => json({
  success: true, data: { access_token: 'new-access', access_expires_at: 9_999_999_999, session: { sid: 'test-sid' } },
}, 200, cookies);
const status = () => json({ success: true, data: { activity: { enabled: true }, today_reward: { reward: 1 } } });
function useState(name) {
  const path = join(directory, `${name}.json`);
  process.env.NEWAPI_XKRELAY_STATE_FILE = path;
  process.env.NEWAPI_XKRELAY_REFRESH_TRANSPORT = 'fetch';
  return path;
}
const readEntry = (path) => Object.values(JSON.parse(readFileSync(path, 'utf8')).accounts)[0];
const child = (generation, events, mode) => new Promise((resolve, reject) => {
  const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL('./test-fixtures/xkrelay-worker.js', import.meta.url)),
    String(generation), events, ...(mode ? [mode] : [])], { env: globalThis.process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  process.stdout.resume();
  process.stderr.on('data', (chunk) => { errors += chunk; });
  process.on('error', reject);
  process.on('close', (code) => code === 0 ? resolve() : reject(new Error(errors || `worker exited ${code}`)));
});

try {
  // Node 18 may expose a combined header. Expires commas are not cookie separators.
  const lines = getSetCookies(new Map([['set-cookie', 'new_api_refresh=test-sid.new; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/api/user/auth, flag=1; Path=/']]));
  assert.equal(lines.length, 2);
  let jar = updateCookies(seedCookies(baseAccount.session, origin), lines, refreshUrl);
  assert.equal(refreshCookie(jar, origin), 'test-sid.new');
  assert.ok(!cookieHeader(jar, `${origin}/api/qq-rewards/self`).includes('new_api_refresh='));
  assert.equal(cookieHeader(jar, 'https://other.example/api/user/auth/refresh'), '');
  jar = updateCookies(jar, ['new_api_refresh=test-sid.root; Path=/; Secure'], refreshUrl);
  // The old path-scoped cookie is a real server cookie; retain its path precedence.
  assert.equal(refreshCookie(jar, origin), 'test-sid.new');
  jar = updateCookies(jar, ['new_api_refresh=gone; Max-Age=0; Path=/api/user/auth'], refreshUrl);
  assert.equal(refreshCookie(jar, origin), 'test-sid.root');
  jar = updateCookies(jar, ['new_api_refresh=evil; Domain=evil.example; Path=/', 'unrelated=gone; Max-Age=0; Path=/'], refreshUrl);
  assert.ok(!cookieHeader(jar, refreshUrl).includes('evil'));
  assert.ok(!cookieHeader(jar, refreshUrl).includes('unrelated='));
  const seeded = updateCookies(seedCookies(baseAccount.session, origin), ['new_api_refresh=test-sid.root; Path=/; Secure'], refreshUrl);
  assert.equal(refreshCookie(seeded, origin), 'test-sid.root'); // Replace the unknown browser path.
  const clock = 1_000_000;
  const expires = updateCookies([], [
    'short=lived; Path=/api; Max-Age=10; Expires=Wed, 01 Jan 2031 00:00:00 GMT',
    'past=gone; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT',
  ], refreshUrl, clock);
  assert.equal(cookieHeader(expires, `${origin}/api/status`, clock + 9_000), 'short=lived');
  assert.equal(cookieHeader(expires, `${origin}/api/status`, clock + 11_000), '');
  assert.equal(cookieHeader(expires, `${origin}/apix`, clock), '');
  assert.ok(!cookieHeader(jar, 'http://xk.example/api/user/auth/refresh').includes('new_api_refresh='));

  const rotationPath = useState('rotation');
  let refreshes = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.referer, `${origin}/qq-checkin`);
    if (String(url) === refreshUrl) {
      refreshes++;
      assert.equal(options.headers.authorization, undefined);
      assert.equal(options.headers['x-auth-session'], 'test-sid');
      assert.match(options.headers.cookie, /new_api_refresh=test-sid.old/);
      return refreshed();
    }
    assert.ok(!options.headers.cookie?.includes('new_api_refresh='));
    return options.headers.authorization === 'Bearer new-access' ? status() : json({}, 401);
  };
  assert.equal((await runAccount(baseAccount)).ok, true);
  assert.equal((await runAccount(baseAccount)).ok, true);
  assert.equal(refreshes, 1);
  assert.equal(statSync(rotationPath).mode & 0o777, 0o600);
  assert.equal(readEntry(rotationPath).accessExpiresAt, 9_999_999_999);
  assert.equal(refreshCookie(readEntry(rotationPath).cookies, origin), 'test-sid.new');
  assert.equal(existsSync(`${rotationPath}.lock`), false);
  // A fresh login overrides the old cache, including an explicitly stale header.
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fresh-login');
    assert.equal(options.headers['x-auth-session'], 'fresh-sid');
    return status();
  };
  assert.equal((await runAccount({ ...baseAccount, accessToken: 'fresh-login', session: 'new_api_refresh=fresh-sid.fresh' })).ok, true);

  for (const scenario of ['network', 'revoked', 'missing-cookie', 'invalid-json', 'deleted-cookie', 'redirect']) {
    const path = useState(scenario);
    let refreshCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url) !== refreshUrl) return json({}, 401);
      refreshCalls++;
      if (scenario === 'network') throw new Error('fetch failed');
      if (scenario === 'revoked') return json({ code: 'AUTH_SESSION_REVOKED' }, 401);
      if (scenario === 'missing-cookie') return refreshed([]);
      if (scenario === 'invalid-json') return json({ unexpected: true });
      if (scenario === 'redirect') return new Response('', { status: 307, headers: { location: 'https://other.example' } });
      return refreshed(['new_api_refresh=; Max-Age=0; Path=/api/user/auth']);
    };
    await assert.rejects(runAccount(baseAccount), /refresh/);
    const entry = readEntry(path);
    assert.equal(entry.refreshPending || !!entry.blocked, true);
    assert.equal(existsSync(`${path}.lock`), false);
    await assert.rejects(runAccount(baseAccount), /require a fresh login/);
    assert.equal(refreshCalls, 1, 'never replay a refresh with an uncertain or rejected outcome');
  }

  // A Cookie from a successful response survives a malformed JSON body.
  const malformedPath = useState('cookie-with-malformed-body');
  globalThis.fetch = async (url) => String(url) === refreshUrl
    ? new Response('not JSON', { headers: { 'set-cookie': 'new_api_refresh=test-sid.recovered; Path=/api/user/auth; Secure' } })
    : json({}, 401);
  await assert.rejects(runAccount(baseAccount), /new Cookie saved/);
  assert.equal(refreshCookie(readEntry(malformedPath).cookies, origin), 'test-sid.recovered');
  globalThis.fetch = async (url, options) => {
    if (String(url) === refreshUrl) {
      assert.match(options.headers.cookie, /test-sid.recovered/);
      return refreshed();
    }
    return options.headers.authorization === 'Bearer new-access' ? status() : json({}, 401);
  };
  assert.equal((await runAccount(baseAccount)).ok, true);

  // Persistence failure after rotation leaves the durable pending marker in place.
  const saveFailurePath = useState('save-failure');
  const originalRename = fs.renameSync;
  globalThis.fetch = async (url) => {
    if (String(url) !== refreshUrl) return json({}, 401);
    fs.renameSync = () => { throw new Error('simulated storage failure'); };
    syncBuiltinESMExports();
    return refreshed();
  };
  try {
    await assert.rejects(runAccount(baseAccount), /could not be saved/);
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(readEntry(saveFailurePath).refreshPending, true);
  await assert.rejects(runAccount(baseAccount), /require a fresh login/);
  assert.equal(existsSync(`${saveFailurePath}.lock`), false);
  assert.ok(!readdirSync(directory).some((file) => file.endsWith('.tmp')));

  const corruptPath = useState('corrupt');
  writeFileSync(corruptPath, '{"secret":"do-not-echo"');
  globalThis.fetch = async () => { throw new Error('must not request with corrupt state'); };
  await assert.rejects(runAccount(baseAccount), (error) => /credential state is invalid/.test(error.message) && !error.message.includes('do-not-echo'));
  assert.equal(existsSync(`${corruptPath}.lock`), false);

  // Two independent processes refresh using consecutive rotated Cookies.
  const processPath = useState('processes');
  const events = join(directory, 'events');
  await child(1, events, 'fail-checkin');
  assert.equal(readEntry(processPath).accessToken, 'access-1');
  await child(2, events);
  assert.equal(readEntry(processPath).accessToken, 'access-2');
  assert.equal(readFileSync(events, 'utf8').trim().split('\n').length, 2);

  // Concurrent processes wait, then reload the winning process's rotated state.
  useState('concurrent');
  const concurrentEvents = join(directory, 'concurrent-events');
  await Promise.all([child(1, concurrentEvents), child(1, concurrentEvents)]);
  assert.equal(readFileSync(concurrentEvents, 'utf8'), 'refresh\n');
  console.log('xkrelay tests passed');
} finally {
  globalThis.fetch = originalFetch;
  if (oldPath === undefined) delete process.env.NEWAPI_XKRELAY_STATE_FILE;
  else process.env.NEWAPI_XKRELAY_STATE_FILE = oldPath;
  if (oldTransport === undefined) delete process.env.NEWAPI_XKRELAY_REFRESH_TRANSPORT;
  else process.env.NEWAPI_XKRELAY_REFRESH_TRANSPORT = oldTransport;
  rmSync(directory, { recursive: true, force: true });
}
