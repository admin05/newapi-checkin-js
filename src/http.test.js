import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchJson, getSetCookies } from './http.js';
import { runAccount } from './checkin.js';

const directory = mkdtempSync(join(tmpdir(), 'newapi-http-test-'));
const oldPath = process.env.PATH;
const oldTmp = process.env.TMPDIR;
const oldState = process.env.NEWAPI_XKRELAY_STATE_FILE;
const oldTransport = process.env.NEWAPI_XKRELAY_REFRESH_TRANSPORT;
const originalFetch = globalThis.fetch;
const argsFile = join(directory, 'args.json');

try {
  // Exercise the actual child-process transport without using the network.
  writeFileSync(join(directory, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf('-D') + 1],
  'HTTP/1.1 100 Continue\\r\\n\\r\\nHTTP/2 200 OK\\r\\nContent-Type: application/json\\r\\n' +
  'Set-Cookie: new_api_refresh=curl-sid.new; Path=/api/user/auth; Secure; HttpOnly\\r\\n' +
  'Set-Cookie: new_api_has_session=1; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT\\r\\n\\r\\n');
process.stdout.write(JSON.stringify({ success: true, data: { access_token: 'curl-access', session: { sid: 'curl-sid' } } }) + '\\n200');
`, { mode: 0o700 });
  process.env.PATH = `${directory}:${oldPath || ''}`;
  process.env.TMPDIR = directory;
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  const result = await fetchJson('https://transport.example');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.access_token, 'curl-access');
  assert.equal(getSetCookies(result.response.headers).length, 2);
  assert.ok(JSON.parse(readFileSync(argsFile)).includes('-L'));
  const before = readFileSync(argsFile, 'utf8');
  await assert.rejects(fetchJson('https://transport.example', {}, { allowCurlFallback: false }), /fetch failed/);
  assert.equal(readFileSync(argsFile, 'utf8'), before, 'disabled fallback must not spawn curl');
  await fetchJson('https://transport.example', {}, { transport: 'curl', followRedirects: false });
  assert.ok(!JSON.parse(readFileSync(argsFile)).includes('-L'));
  assert.ok(!readdirSync(directory).some((name) => name.startsWith('newapi-http-')));

  // A refresh can explicitly select curl as its only transport and retain cookies.
  process.env.NEWAPI_XKRELAY_STATE_FILE = join(directory, 'sessions.json');
  process.env.NEWAPI_XKRELAY_REFRESH_TRANSPORT = 'curl';
  globalThis.fetch = async (url, options) => {
    assert.ok(!String(url).endsWith('/api/user/auth/refresh'), 'refresh must use curl directly');
    if (options.headers.authorization !== 'Bearer curl-access') return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ success: true, data: { activity: { enabled: true }, today_reward: { reward: 1 } } }));
  };
  const account = { url: 'https://transport.example', siteType: 'xkrelay-qq', session: 'new_api_refresh=curl-sid.old' };
  assert.equal((await runAccount(account)).ok, true);
  assert.equal((await runAccount(account)).ok, true);
  const state = JSON.parse(readFileSync(process.env.NEWAPI_XKRELAY_STATE_FILE, 'utf8'));
  assert.ok(Object.values(state.accounts)[0].cookies.some(({ value }) => value === 'curl-sid.new'));
  assert.ok(!JSON.parse(readFileSync(argsFile)).includes('-L'));

  writeFileSync(join(directory, 'curl'), `#!${process.execPath}\nprocess.exit(28);\n`, { mode: 0o700 });
  await assert.rejects(fetchJson('https://transport.example', {}, { transport: 'curl' }), /exit 28/);
  assert.ok(!readdirSync(directory).some((name) => name.startsWith('newapi-http-')));
  console.log('http tests passed');
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries({ PATH: oldPath, TMPDIR: oldTmp,
    NEWAPI_XKRELAY_STATE_FILE: oldState, NEWAPI_XKRELAY_REFRESH_TRANSPORT: oldTransport })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
}
