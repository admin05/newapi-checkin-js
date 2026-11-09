import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiPath = '/api/v1/plugins/tokenflux.checkin/api';
const defaultStateFile = join(dirname(dirname(fileURLToPath(import.meta.url))), '.newapi-tokenflux-tokens.json');

function saveState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function loadState(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state?.version !== 1 || !state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) {
      throw new Error('invalid state format');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, accounts: {} };
    // Do not include file contents or parser errors: they can contain credentials.
    throw new Error('MiniToken credential state could not be read; check NEWAPI_TOKENFLUX_STATE_FILE and its JSON format');
  }
}

async function withCredentials(account, action) {
  const refreshToken = account.refreshToken || account.refresh_token;
  if (!refreshToken) return action(account, null);

  const path = resolve(process.env.NEWAPI_TOKENFLUX_STATE_FILE || defaultStateFile);
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('MiniToken credential state is locked by another run; avoid overlapping jobs. If a previous process crashed, remove the .lock file only after confirming it has stopped');
    }
    throw new Error('MiniToken credential state is not writable; set NEWAPI_TOKENFLUX_STATE_FILE to a persistent writable file with an existing parent directory');
  }

  try {
    const state = loadState(path);
    // The configured refresh token identifies a login. A new browser login starts
    // a separate entry instead of reusing an old account's rotated credentials.
    const key = createHash('sha256').update(`${new URL(account.url).origin}\0${refreshToken}`).digest('hex');
    const cached = state.accounts[key];
    if (cached && (typeof cached.accessToken !== 'string' || !cached.accessToken ||
      typeof cached.refreshToken !== 'string' || !cached.refreshToken ||
      !Number.isFinite(cached.tokenExpiresAt))) {
      throw new Error('MiniToken cached credentials are invalid; restore the state file or configure a fresh browser login');
    }
    const credentials = {
      ...account,
      refreshToken,
      tokenExpiresAt: Number(account.tokenExpiresAt || account.token_expires_at || 0),
      ...cached,
    };
    // Check persistence before sending a request that can consume a refresh token.
    try { saveState(path, state); } catch {
      throw new Error('MiniToken credential state is not writable; refresh was not attempted');
    }
    return await action(credentials, () => {
      state.accounts[key] = {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        tokenExpiresAt: credentials.tokenExpiresAt,
      };
      try { saveState(path, state); } catch {
        throw new Error('MiniToken token rotated but could not be saved; restore persistent storage and obtain a fresh browser login before the next run');
      }
    });
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export async function runTokenFluxAccount(account, { fetchJson, buildHeaders, dryRun }) {
  return withCredentials(account, async (credentials, persist) => {
    const baseUrl = new URL(account.url).origin;
    const headers = () => buildHeaders({
      ...credentials,
      referer: account.referer || `${baseUrl}/ext/tokenflux.checkin`,
    });
    let refreshed = false;

    function requestError(response, body, action) {
      if (response.status === 401) {
        return `${action} failed: MiniToken login token expired or was rejected; configure refreshToken for automatic renewal, or update accessToken from localStorage.auth_token`;
      }
      const detail = body?.message || body?.reason || body?.code || 'unexpected response';
      return `${action} failed: HTTP ${response.status} ${String(detail).slice(0, 240)}`;
    }

    async function refresh() {
      refreshed = true;
      const refreshHeaders = headers();
      delete refreshHeaders.authorization;
      let result;
      try {
        result = await fetchJson(`${baseUrl}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: refreshHeaders,
          body: JSON.stringify({ refresh_token: credentials.refreshToken }),
        }, { allowCurlFallback: false }); // Never replay a rotating refresh after an ambiguous network failure.
      } catch {
        throw new Error('MiniToken token refresh failed: network error; not retried because the refresh token may have rotated. Retry the job; if rejected, obtain fresh browser credentials');
      }
      const { response, body } = result;
      if (!response.ok || body?.code !== 0) {
        throw new Error(`MiniToken token refresh failed: HTTP ${response.status}; sign in again and update refreshToken from localStorage.refresh_token`);
      }
      const data = body.data;
      if (typeof data?.access_token !== 'string' || !data.access_token.trim() ||
        typeof data.refresh_token !== 'string' || !data.refresh_token.trim() ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
        throw new Error('MiniToken token refresh failed: invalid token response; obtain fresh browser credentials');
      }
      credentials.accessToken = data.access_token;
      credentials.refreshToken = data.refresh_token;
      credentials.tokenExpiresAt = Date.now() + data.expires_in * 1000;
      persist(); // Save both tokens before attempting status/check-in again.
    }

    if (!headers().authorization && !credentials.refreshToken) {
      throw new Error('missing login credential: set accessToken from MiniToken localStorage.auth_token or refreshToken from localStorage.refresh_token');
    }
    if (credentials.refreshToken && (!headers().authorization ||
      (credentials.tokenExpiresAt > 0 && credentials.tokenExpiresAt <= Date.now() + 60_000))) {
      await refresh();
    }

    async function request(path, options = {}) {
      let result = await fetchJson(`${baseUrl}${path}`, { ...options, headers: headers() });
      if (result.response.status === 401 && credentials.refreshToken && !refreshed) {
        await refresh();
        result = await fetchJson(`${baseUrl}${path}`, { ...options, headers: headers() });
      }
      return result;
    }

    const status = await request(`${apiPath}/status`);
    if (!status.response.ok) {
      throw new Error(requestError(status.response, status.body, 'TokenFlux check-in status'));
    }
    if (typeof status.body?.checked_in !== 'boolean') {
      throw new Error('TokenFlux check-in status failed: unexpected response; expected a checked_in boolean');
    }
    const result = {
      name: account.name || baseUrl,
      ok: true,
      systemName: 'MiniToken TokenFlux check-in',
      data: status.body,
    };
    if (dryRun) return { ...result, skipped: true, message: 'checkin is enabled; dry run skipped checkin' };
    if (status.body.checked_in) return { ...result, method: 'GET', message: 'already checked in today' };

    const { response, body } = await request(`${apiPath}/checkin`, { method: 'POST' });
    if (response.ok || body?.code === 'ALREADY_CHECKED_IN' || body?.reason === 'ALREADY_CHECKED_IN') {
      return {
        ...result,
        method: 'POST',
        message: response.ok ? 'checkin succeeded' : 'already checked in today',
        data: { ...status.body, checked_in: true },
      };
    }
    return { ...result, ok: false, message: requestError(response, body, 'TokenFlux check-in') };
  });
}
