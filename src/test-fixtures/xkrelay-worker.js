import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { runAccount } from '../checkin.js';

// Separate processes share only the state file, just like overlapping NAS jobs.
const generation = Number(process.argv[2]);
const eventFile = process.argv[3];
const failCheckin = process.argv[4] === 'fail-checkin';
globalThis.fetch = async (url, options) => {
  if (String(url).endsWith('/api/user/auth/refresh')) {
    assert.equal(options.headers.authorization, undefined);
    assert.match(options.headers.cookie, new RegExp(`new_api_refresh=worker-sid.secret-${generation - 1}(?:;|$)`));
    assert.equal(options.headers['x-auth-session'], 'worker-sid');
    appendFileSync(eventFile, 'refresh\n');
    await delay(150); // Let another process contend for the lock.
    return new Response(JSON.stringify({ success: true, data: {
      access_token: `access-${generation}`, access_expires_at: 9_999_999_999,
      session: { sid: 'worker-sid', expires_at: 9_999_999_999 },
    } }), { headers: { 'set-cookie': `new_api_refresh=worker-sid.secret-${generation}; Path=/api/user/auth; Secure; HttpOnly` } });
  }
  assert.ok(!options.headers.cookie?.includes('new_api_refresh='), 'refresh Cookie must not be sent to QQ endpoints');
  if (options.headers.authorization !== `Bearer access-${generation}`) {
    return new Response(JSON.stringify({ message: 'invalid access token' }), { status: 401 });
  }
  if (options.method === 'POST') {
    assert.ok(failCheckin);
    return new Response(JSON.stringify({ message: 'temporary check-in failure' }), { status: 500 });
  }
  return new Response(JSON.stringify({ success: true, data: {
    activity: { enabled: true }, today: '2026-11-10', today_reward: failCheckin ? null : { reward: 1 },
  } }));
};
const result = await runAccount({
  url: 'https://worker.example', siteType: 'xkrelay-qq', accessToken: 'expired',
  session: 'new_api_refresh=worker-sid.secret-0; new_api_has_session=1',
});
assert.equal(result.ok, !failCheckin);
console.log('worker passed');
