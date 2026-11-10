import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cookieHeader, refreshCookie, seedCookies, updateCookies } from './cookies.js';
import { getSetCookies } from './http.js';

const contexts = new WeakMap();
const defaultStateFile = join(dirname(dirname(fileURLToPath(import.meta.url))), '.newapi-xkrelay-sessions.json');
const digest = (value) => createHash('sha256').update(value).digest('hex');

function saveState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } catch {
    throw new Error('xkrelay credentials could not be saved; restore persistent writable storage before retrying');
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function loadState(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state?.version !== 1 || !state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) throw new Error();
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, accounts: {} };
    throw new Error('xkrelay credential state is invalid; restore it, or move the corrupt file aside and configure a fresh browser login');
  }
}

function validEntry(entry, origin) {
  const host = new URL(origin).hostname;
  return entry && typeof entry.seedHash === 'string' && typeof entry.accessToken === 'string' &&
    typeof entry.authSession === 'string' && typeof entry.refreshPending === 'boolean' &&
    typeof entry.blocked === 'string' && Array.isArray(entry.cookies) && entry.cookies.every((cookie) =>
      cookie && typeof cookie.name === 'string' && /^[!#$%&'*+\-.^_`|~\w]+$/.test(cookie.name) && typeof cookie.value === 'string' &&
      !/[\x00-\x20\x7f;,]/.test(cookie.value) && cookie.domain === host &&
      typeof cookie.path === 'string' && cookie.path.startsWith('/') && typeof cookie.secure === 'boolean' &&
      (cookie.expiresAt === null || Number.isFinite(cookie.expiresAt)));
}

async function acquireLock(path) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try { return openSync(path, 'wx', 0o600); } catch (error) {
      if (error.code !== 'EEXIST') throw new Error('xkrelay credential state is not writable; set NEWAPI_XKRELAY_STATE_FILE to a persistent file with an existing parent directory');
      if (Date.now() >= deadline) throw new Error('xkrelay credential state is locked by another run; if a process crashed, remove its .lock file only after confirming it has stopped');
      await delay(100);
    }
  }
}

export async function withXkRelayCredentials(account, action) {
  const origin = new URL(account.url).origin;
  const configuredCookies = seedCookies(account.session, origin);
  const seed = refreshCookie(configuredCookies, origin);
  if (!seed) return action(account);
  const transport = process.env.NEWAPI_XKRELAY_REFRESH_TRANSPORT || 'fetch';
  if (!['fetch', 'curl'].includes(transport)) throw new Error('NEWAPI_XKRELAY_REFRESH_TRANSPORT must be fetch or curl');
  const path = resolve(process.env.NEWAPI_XKRELAY_STATE_FILE || defaultStateFile);
  const lockPath = `${path}.lock`;
  const lock = await acquireLock(lockPath);
  try {
    const state = loadState(path); // Always read after obtaining the lock.
    const sid = seed.includes('.') ? seed.slice(0, seed.indexOf('.')) : '';
    const key = digest(`${origin}\0${sid || seed}`);
    const seedHash = digest(seed);
    let entry = state.accounts[key];
    if (entry && !validEntry(entry, origin)) throw new Error('xkrelay cached credentials are invalid; restore the state file or configure a fresh login with a new session');
    // A newly supplied Cookie replaces the seed. Unchanged configuration keeps using the rotated jar.
    if (!entry || entry.seedHash !== seedHash) {
      entry = { seedHash, cookies: configuredCookies, accessToken: account.accessToken || '',
        authSession: sid || account.authSession || '', accessExpiresAt: null, sessionExpiresAt: null,
        refreshPending: false, blocked: '' };
      state.accounts[key] = entry;
    }
    if (entry.refreshPending || entry.blocked) {
      throw new Error('xkrelay credentials require a fresh login: a previous refresh was rejected or its outcome was uncertain; update the browser Cookie instead of replaying the old refresh');
    }
    // Fail before consuming a rotating Cookie if the state cannot be persisted.
    saveState(path, state);
    const credentials = { ...account, accessToken: entry.accessToken, authSession: entry.authSession,
      extraHeaders: Object.fromEntries(Object.entries(account.extraHeaders || {})
        .filter(([name]) => !/^(authorization|cookie|x-auth-session)$/i.test(name))) };
    credentials.session = cookieHeader(entry.cookies, `${origin}/api/user/auth/refresh`);
    contexts.set(credentials, { origin, entry, transport, persist: () => saveState(path, state) });
    try { return await action(credentials); } finally { contexts.delete(credentials); }
  } finally {
    try { closeSync(lock); } finally { unlinkSync(lockPath); }
  }
}

export async function fetchXkRelayJson(account, url, options, { fetchJson, buildHeaders }) {
  const context = contexts.get(account);
  if (!context) {
    const result = await fetchJson(url, { ...options, headers: options.headers || buildHeaders(account) }, { followRedirects: false });
    if (result.response.status === 401) throw new Error('xkrelay access-token refresh failed: no usable new_api_refresh Cookie; sign in again and update the browser Cookie');
    return result;
  }
  const { origin, entry, transport, persist } = context;
  if (new URL(url).origin !== origin) throw new Error('xkrelay request rejected: origin does not match the configured account');
  const makeHeaders = (target, refresh = false) => {
    const headers = buildHeaders({ ...account, referer: account.referer || `${origin}/qq-checkin` });
    const cookie = cookieHeader(entry.cookies, target);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    if (refresh) delete headers.authorization;
    return headers;
  };
  const receiveCookies = (response, target) => {
    const cookies = getSetCookies(response.headers);
    if (!cookies.length) return false;
    entry.cookies = updateCookies(entry.cookies, cookies, target);
    account.session = cookieHeader(entry.cookies, `${origin}/api/user/auth/refresh`);
    const refresh = refreshCookie(entry.cookies, origin);
    if (refresh.includes('.')) account.authSession = entry.authSession = refresh.split('.')[0];
    return true;
  };
  const send = async () => {
    const result = await fetchJson(url, { ...options, headers: makeHeaders(url) }, { followRedirects: false });
    if (receiveCookies(result.response, url)) persist();
    return result;
  };
  let result = await send();
  if (result.response.status !== 401) return result;

  const refreshUrl = `${origin}/api/user/auth/refresh`;
  if (!refreshCookie(entry.cookies, origin)) throw new Error('xkrelay access-token refresh failed: refresh Cookie expired or was deleted; sign in again');
  // Persist the in-flight marker before the server can rotate anything. A crash or
  // lost response must not cause a later process to replay a consumed secret.
  entry.refreshPending = true;
  persist();
  let refreshed;
  try {
    refreshed = await fetchJson(refreshUrl, { method: 'POST', headers: makeHeaders(refreshUrl, true) },
      { transport, allowCurlFallback: false, followRedirects: false });
  } catch {
    throw new Error('xkrelay refresh outcome is uncertain; request was not replayed. Sign in again and update the browser Cookie; if fetch cannot connect, select NEWAPI_XKRELAY_REFRESH_TRANSPORT=curl before using fresh credentials');
  }
  const { response, body } = refreshed;
  const previousCookie = refreshCookie(entry.cookies, origin);
  receiveCookies(response, refreshUrl);
  const nextCookie = refreshCookie(entry.cookies, origin);
  const nextToken = body?.success === true ? body.data?.access_token : '';
  const validToken = typeof nextToken === 'string' && !!nextToken.trim();
  // Save any new Cookie even if the JSON is malformed. It is the only way to
  // recover safely on the next run without replaying the previous Cookie.
  const receivedRefresh = getSetCookies(response.headers).some((line) => /^new_api_refresh=/i.test(line.trim()));
  const acceptedRefresh = receivedRefresh && nextCookie && nextCookie !== previousCookie;
  if (!response.ok || !validToken || !acceptedRefresh) {
    entry.accessToken = '';
    entry.refreshPending = !(response.ok && acceptedRefresh);
    entry.blocked = response.status === 401 || response.status === 403 ? 'relogin' : '';
    persist();
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(body?.code || '') ? ` ${body.code}` : '';
    throw new Error(`xkrelay access-token refresh failed: HTTP ${response.status}${code}; ${entry.refreshPending || entry.blocked ? 'sign in again and update the browser Cookie' : 'new Cookie saved; retry the job'}`);
  }
  entry.accessToken = nextToken.trim();
  entry.authSession = nextCookie.split('.')[0];
  entry.accessExpiresAt = Number.isFinite(body.data.access_expires_at) ? body.data.access_expires_at : null;
  entry.sessionExpiresAt = Number.isFinite(body.data.session?.expires_at) ? body.data.session.expires_at : null;
  entry.refreshPending = false;
  entry.blocked = '';
  persist(); // Both tokens are durable before retrying status or check-in.
  account.accessToken = entry.accessToken;
  account.authSession = entry.authSession;
  result = await send();
  return result; // At most one refresh for this request.
}
