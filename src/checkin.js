import { existsSync, readFileSync } from 'node:fs';
import { env, argv, exit } from 'node:process';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ACCOUNTS = [
  { name: 'AveMujica API', url: 'https://api.avemujica.moe' },
  { name: 'Link-AI', url: 'https://link-ai.cc' },
  { name: 'Xiaomu API', url: 'https://xiaomuai.cn' },
  { name: 'Huan API', url: 'https://ai.huan666.de' },
  { name: 'ElySiver', url: 'https://elysiver.h-e.top' },
  { name: 'Xcode', url: 'https://xcode.best' },
  { name: 'LPGPT', url: 'https://lpgpt.us' },
  { name: 'Muyuan', url: 'https://muyuan.do' },
];

const dryRun = argv.includes('--dry-run');
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const alreadyCheckedInPattern = /今日已签到|已经签到|已签到|重复签到|already\s+(checked|signed)/i;
const captchaRequiredPattern = /请输入验证码|验证码|captcha/i;
const retryableCheckinFailurePattern = /验证码|captcha|verify/i;
const missingAuthPattern = /not\s+logged\s+in|no\s+access\s+token|unauthorized|authorization\s+header\s+is\s+required/i;
const nonLoginCookieNames = new Set(['cf_clearance', '__cf_bm', '_cfuvid']);
const sub2ApiHosts = new Set(['sub.100xlabs.space']);

function normalizeBaseUrl(url) {
  return new URL(url).origin;
}

function splitCurlBlocks(source) {
  const blocks = [];
  const regex = /(^|\n)\s*curl\s+['"][^\n]*?['"][\s\S]*?(?=(?:\n\s*curl\s+)|$)/g;
  for (const match of source.matchAll(regex)) {
    const block = match[0].replace(/^\n/, '').trim();
    if (block) blocks.push(block);
  }
  return blocks;
}

function parseCurlHeaders(block) {
  const headers = {};
  const headerRegex = /-H\s+(['"])([\s\S]*?)\1/g;
  for (const match of block.matchAll(headerRegex)) {
    const raw = match[2];
    const idx = raw.indexOf(':');
    if (idx <= 0) continue;
    const key = raw.slice(0, idx).trim().toLowerCase();
    const value = raw.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function parseCurlCookie(block, headers) {
  const cookieMatch = block.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/);
  if (cookieMatch) return cookieMatch[2].trim().replace(/^cookie:\s*/i, '');

  return headers.cookie || '';
}

function parseCurlAccounts(source) {
  const accounts = [];

  for (const block of splitCurlBlocks(source)) {
    const urlMatch = block.match(/curl\s+(['"])(.*?)\1/);
    if (!urlMatch) continue;

    const url = urlMatch[2];
    const headers = parseCurlHeaders(block);
    const cookie = parseCurlCookie(block, headers);
    const baseUrl = normalizeBaseUrl(url);

    accounts.push({
      name: new URL(baseUrl).hostname,
      url: baseUrl,
      session: cookie.replace(/^cookie:\s*/i, ''),
      accessToken: headers.authorization ? headers.authorization.replace(/^Bearer\s+/i, '') : '',
      userId: headers['new-api-user'] || headers['x-user-id'] || '',
      referer: headers.referer || '',
      origin: headers.origin || '',
      userAgent: headers['user-agent'] || '',
      extraHeaders: Object.fromEntries(
        Object.entries(headers).filter(([key]) =>
          !['authorization', 'cookie', 'new-api-user', 'x-user-id', 'referer', 'origin', 'user-agent'].includes(key),
        ),
      ),
    });
  }

  return accounts;
}

function cookieObjectToString(cookies) {
  if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) return '';

  return Object.entries(cookies)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function getCookieNames(cookie) {
  return String(cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split('=')[0].trim().toLowerCase())
    .filter(Boolean);
}

function hasLoginCookie(cookie) {
  const names = getCookieNames(cookie);
  return names.some((name) => !nonLoginCookieNames.has(name));
}

function hasOnlyNonLoginCookies(cookie) {
  const names = getCookieNames(cookie);
  return names.length > 0 && names.every((name) => nonLoginCookieNames.has(name));
}

function parseHashAccounts(source) {
  const accounts = [];

  for (const part of source.split(',')) {
    const item = part.trim();
    if (!item || !item.includes('#')) continue;

    const [rawUrl, ...sessionParts] = item.split('#');
    const url = rawUrl.trim();
    const session = sessionParts.join('#').trim();
    if (!url || !session) continue;

    accounts.push({
      name: new URL(normalizeBaseUrl(url)).hostname,
      url: normalizeBaseUrl(url),
      session,
    });
  }

  return accounts;
}

function normalizeAccount(account, fallbackName = '') {
  if (typeof account === 'string') {
    const parsedHash = parseHashAccounts(account);
    if (parsedHash.length > 0) {
      return {
        ...parsedHash[0],
        name: fallbackName || parsedHash[0].name,
      };
    }

    return {
      name: fallbackName || 'account',
      curl: account,
    };
  }

  if (!account || typeof account !== 'object') {
    return account;
  }

  const normalized = {
    ...account,
  };

  if (!normalized.session && normalized.cookies) {
    normalized.session =
      typeof normalized.cookies === 'string' ? normalized.cookies : cookieObjectToString(normalized.cookies);
  }

  normalized.accessToken =
    normalized.accessToken ||
    normalized.access_token ||
    normalized.authToken ||
    normalized.auth_token ||
    normalized.systemAccessToken ||
    normalized.system_access_token ||
    '';

  normalized.siteType = normalized.siteType || normalized.site_type || normalized.type || normalized.platform || '';
  normalized.userId =
    normalized.userId ||
    normalized.user_id ||
    normalized.apiUser ||
    normalized.api_user ||
    '';

  normalized.cfClearance = normalized.cfClearance || normalized.cf_clearance || '';
  normalized.captchaAnswer = normalized.captchaAnswer || normalized.captcha_answer || '';

  if (normalized.cfClearance) {
    normalized.session = normalized.session
      ? `${normalized.session}; cf_clearance=${normalized.cfClearance}`
      : `cf_clearance=${normalized.cfClearance}`;
  }

  account = normalized;

  if (!account.curl) {
    return account;
  }

  const parsed = parseCurlAccounts(account.curl);
  if (parsed.length === 0) {
    return account;
  }

  const derived = parsed[0];
  return {
    ...derived,
    ...account,
    name: account.name || derived.name,
    url: account.url || derived.url,
  };
}

function loadAccountsFile(configPath) {
  const paths = isAbsolute(configPath)
    ? [configPath]
    : [configPath, join(repoRoot, configPath)];

  for (const path of paths) {
    if (!existsSync(path)) continue;

    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed)
      ? parsed.map((account, index) => normalizeAccount(account, `account-${index + 1}`))
      : parsed;
  }

  return null;
}

function loadAccounts() {
  if (env.NEWAPI_ACCOUNTS_CURL) {
    const parsed = parseCurlAccounts(env.NEWAPI_ACCOUNTS_CURL);
    if (parsed.length > 0) return parsed;
  }

  if (env.NEWAPI_ACCOUNTS_JSON) {
    const parsed = JSON.parse(env.NEWAPI_ACCOUNTS_JSON);
    return Array.isArray(parsed)
      ? parsed.map((account, index) => normalizeAccount(account, `account-${index + 1}`))
      : parsed;
  }

  if (env.NEWAPI_ACCOUNTS) {
    try {
      const parsed = JSON.parse(env.NEWAPI_ACCOUNTS);
      return Array.isArray(parsed)
        ? parsed.map((account, index) => normalizeAccount(account, `account-${index + 1}`))
        : parsed;
    } catch {
      const parsed = parseHashAccounts(env.NEWAPI_ACCOUNTS);
      if (parsed.length > 0) return parsed;
    }
  }

  const configPath = env.NEWAPI_ACCOUNTS_FILE || 'accounts.json';
  const fileAccounts = loadAccountsFile(configPath);
  if (fileAccounts) return fileAccounts;

  return DEFAULT_ACCOUNTS.map((account) => ({
    ...account,
    session: env.NEWAPI_SESSION || '',
    accessToken: env.NEWAPI_ACCESS_TOKEN || env.NEWAPI_SYSTEM_ACCESS_TOKEN || '',
    userId: env.NEWAPI_USER_ID || env.NEWAPI_API_USER || '',
    referer: env.NEWAPI_REFERER || '',
    origin: env.NEWAPI_ORIGIN || '',
  }));
}

function buildHeaders(account) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 newapi-checkin-js/0.1.0',
  };

  if (account.extraHeaders && typeof account.extraHeaders === 'object') {
    for (const [key, value] of Object.entries(account.extraHeaders)) {
      if (value !== undefined && value !== '') {
        headers[key] = value;
      }
    }
  }

  if (account.session) {
    headers.cookie = account.session.includes('=')
      ? account.session
      : `session=${account.session}`;
  }

  if (account.accessToken) {
    headers.authorization = `Bearer ${account.accessToken}`;
  }

  if (account.userId) {
    headers['new-api-user'] = String(account.userId);
    headers['x-user-id'] = String(account.userId);
  }

  headers.referer = account.referer || `${normalizeBaseUrl(account.url)}/console/personal`;

  headers.origin = account.origin || normalizeBaseUrl(account.url);

  if (account.userAgent) {
    headers['user-agent'] = account.userAgent;
  }

  return headers;
}

function hasLoginCredential(account) {
  const headers = buildHeaders(account);
  return Boolean(headers.authorization || hasLoginCookie(headers.cookie));
}

function getSiteType(account) {
  const explicit = String(account.siteType || '').toLowerCase();
  if (explicit) return explicit;

  try {
    const host = new URL(normalizeBaseUrl(account.url)).hostname.toLowerCase();
    if (sub2ApiHosts.has(host)) return 'sub2api';
  } catch {
    // Fall through to the default NewAPI behavior.
  }

  return 'newapi';
}

function isSub2ApiAccount(account) {
  return getSiteType(account) === 'sub2api';
}

async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      ...options,
    });
    const text = await response.text();
    return parseJsonResponse(response.status, response.headers, text);
  } catch (error) {
    if (!/fetch failed|network|ENOTFOUND|ECONN/i.test(error.message)) {
      throw error;
    }
    return fetchJsonWithCurl(url, options);
  }
}

function parseJsonResponse(status, headers, text) {
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  return {
    response: {
      status,
      ok: status >= 200 && status < 300,
      headers,
    },
    body,
  };
}

function fetchJsonWithCurl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const args = ['-sS', '-L', '--max-time', '20', '-X', method];

    for (const [key, value] of Object.entries(options.headers || {})) {
      if (value !== undefined && value !== '') {
        args.push('-H', `${key}: ${value}`);
      }
    }

    if (options.body !== undefined) {
      args.push('--data-raw', options.body);
    }

    args.push('-w', '\n%{http_code}', url);

    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
        return;
      }

      const match = stdout.match(/\n(\d{3})$/);
      if (!match) {
        reject(new Error('curl response did not include HTTP status'));
        return;
      }

      const status = Number(match[1]);
      const text = stdout.slice(0, match.index);
      resolve(parseJsonResponse(status, new Map(), text));
    });
  });
}

function compactBodyForError(body) {
  if (!body) return '';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function unwrapNewApiStatus(response, body) {
  const raw = typeof body?.raw === 'string' ? body.raw : '';
  if (/^\s*<!doctype html\b|<html\b/i.test(raw)) {
    throw new Error(
      'status failed: API URL returned HTML instead of JSON; update this account url to the real NewAPI backend/panel URL',
    );
  }

  if (!response.ok) {
    throw new Error(`status failed: HTTP ${response.status} ${body?.message || body?.error || compactBodyForError(body)}`.trim());
  }

  if (body?.success === true && body.data) {
    return body.data;
  }

  if ((body?.code === 0 || body?.code === '0') && body.data) {
    return body.data;
  }

  if (body?.data && typeof body.data === 'object') {
    return body.data;
  }

  if (body && typeof body === 'object' && ('checkin_enabled' in body || 'system_name' in body)) {
    return body;
  }

  throw new Error(`status failed: HTTP ${response.status} unexpected response ${compactBodyForError(body)}`.trim());
}

async function getStatus(account) {
  if (isSub2ApiAccount(account)) {
    return getSub2ApiStatus(account);
  }

  const baseUrl = normalizeBaseUrl(account.url);
  const { response, body } = await fetchJson(`${baseUrl}/api/status`, {
    headers: buildHeaders(account),
  });

  return unwrapNewApiStatus(response, body);
}

function getSub2ApiMessage(body) {
  return body?.message || body?.error || body?.raw || '';
}

function unwrapSub2ApiData(response, body, action) {
  if (response.ok && body?.code === 0) {
    return body.data;
  }

  const message = getSub2ApiMessage(body);
  if (response.status === 401 || /INVALID_TOKEN|UNAUTHORIZED/i.test(String(body?.code || message))) {
    throw new Error(`${action} failed: credentials were rejected by the site (HTTP ${response.status} ${message}). Refresh auth_token from localStorage or copy a logged-in browser request as curl.`);
  }

  throw new Error(`${action} failed: HTTP ${response.status} ${message}`.trim());
}

async function getSub2ApiStatus(account) {
  const baseUrl = normalizeBaseUrl(account.url);
  const { response, body } = await fetchJson(`${baseUrl}/api/v1/check-in/status`, {
    headers: buildHeaders(account),
  });

  const data = unwrapSub2ApiData(response, body, 'check-in status');
  return {
    checkin_enabled: data?.enabled === true,
    system_name: 'Sub2API',
    sub2Api: data,
  };
}

async function getSelf(account) {
  if (isSub2ApiAccount(account)) {
    return getSub2ApiSelf(account);
  }

  const baseUrl = normalizeBaseUrl(account.url);
  const headers = buildHeaders(account);
  const endpoints = ['/api/user/self/groups', '/api/user/self'];
  const errors = [];

  for (const endpoint of endpoints) {
    const { response, body } = await fetchJson(`${baseUrl}${endpoint}`, {
      headers,
    });

    if (response.ok && body?.success) {
      return body.data;
    }

    errors.push(`HTTP ${response.status} ${body?.message || body?.error || ''}`.trim());
  }

  const uniqueErrors = [...new Set(errors)];
  const detail = uniqueErrors.join(' | ');
  if (uniqueErrors.some((error) => /^HTTP 401\b/i.test(error) && missingAuthPattern.test(error))) {
    throw new Error(
      `login check failed: credentials were rejected by the site (${detail}). Refresh this account from a logged-in browser request; include the full Cookie header and Authorization Bearer token if the request has one. The safest input is a browser-copied curl in NEWAPI_ACCOUNTS_CURL or this account's curl field.`,
    );
  }

  throw new Error(`login check failed: ${detail}`);
}

async function getSub2ApiSelf(account) {
  const baseUrl = normalizeBaseUrl(account.url);
  const { response, body } = await fetchJson(`${baseUrl}/api/v1/user/profile`, {
    headers: buildHeaders(account),
  });

  return unwrapSub2ApiData(response, body, 'login check');
}

async function checkIn(account) {
  if (isSub2ApiAccount(account)) {
    return checkInSub2Api(account);
  }

  const baseUrl = normalizeBaseUrl(account.url);
  const headers = buildHeaders(account);
  const attempts = [
    { endpoint: '/api/user/checkin', method: 'POST', body: '{}' },
    { endpoint: '/api/user/checkin', method: 'GET' },
    { endpoint: '/api/user/checkin/reward-pack-plan', method: 'POST', body: '{}' },
  ];
  const errors = [];

  for (const attempt of attempts) {
    const { response, body } = await fetchJson(`${baseUrl}${attempt.endpoint}`, {
      method: attempt.method,
      headers,
      body: attempt.body,
    });

    if (response.ok && body?.success) {
      return { method: attempt.method, endpoint: attempt.endpoint, body };
    }

    const message = body?.message || body?.error || '';
    if (response.ok && alreadyCheckedInPattern.test(message)) {
      return { method: attempt.method, endpoint: attempt.endpoint, body, alreadyCheckedIn: true };
    }

    if (response.ok && captchaRequiredPattern.test(message)) {
      const captchaResult = await checkInWithCaptcha(account, baseUrl, headers);
      if (!captchaResult.error || captchaResult.captchaRequired) {
        return captchaResult;
      }
    }

    errors.push(`${attempt.method} ${attempt.endpoint}: HTTP ${response.status} ${message}`.trim());

    if (response.ok && retryableCheckinFailurePattern.test(message)) {
      continue;
    }

    if (response.status !== 404 && !/method not allowed/i.test(message)) {
      return { method: attempt.method, endpoint: attempt.endpoint, body, error: `HTTP ${response.status} ${message}`.trim() };
    }
  }

  return {
    error: errors.length > 0
      ? `checkin endpoint did not accept known checkin routes: ${errors.join(' | ')}`
      : 'checkin endpoint did not accept known checkin routes',
  };
}

function getSub2ApiTurnstileToken(account) {
  return account.turnstileToken || account.turnstile_token || env.SUB2API_TURNSTILE_TOKEN || '';
}

async function checkInSub2Api(account) {
  const baseUrl = normalizeBaseUrl(account.url);
  const headers = buildHeaders(account);
  const status = await getSub2ApiStatus(account);
  const token = getSub2ApiTurnstileToken(account);

  if (status.sub2Api?.checked_in_today) {
    return {
      method: 'GET',
      endpoint: '/api/v1/check-in/status',
      body: { data: status.sub2Api },
      alreadyCheckedIn: true,
    };
  }

  if (status.sub2Api?.turnstile_required && !token) {
    return {
      error: 'turnstile required: open the check-in page in a browser or set turnstileToken/SUB2API_TURNSTILE_TOKEN for this run',
      captchaRequired: true,
    };
  }

  const { response, body } = await fetchJson(`${baseUrl}/api/v1/check-in`, {
    method: 'POST',
    headers,
    body: JSON.stringify(token ? { turnstile_token: token } : {}),
  });

  if (response.ok && body?.code === 0) {
    return {
      method: 'POST',
      endpoint: '/api/v1/check-in',
      body: { data: body.data, message: body.data?.already_checked_in ? 'already checked in today' : 'checkin succeeded' },
      alreadyCheckedIn: body.data?.already_checked_in === true,
    };
  }

  const message = getSub2ApiMessage(body);
  if (response.ok && alreadyCheckedInPattern.test(message)) {
    return { method: 'POST', endpoint: '/api/v1/check-in', body, alreadyCheckedIn: true };
  }

  return {
    method: 'POST',
    endpoint: '/api/v1/check-in',
    body,
    error: `HTTP ${response.status} ${message}`.trim(),
  };
}

function getCaptchaAnswer(account) {
  return account.captchaAnswer || env.NEWAPI_CAPTCHA_ANSWER || '';
}

async function checkInWithCaptcha(account, baseUrl, headers) {
  const answer = getCaptchaAnswer(account).trim();
  if (!answer) {
    return {
      error: 'captcha required: set captchaAnswer in this account or NEWAPI_CAPTCHA_ANSWER with the current check-in captcha answer',
      captchaRequired: true,
    };
  }

  const captcha = await fetchJson(`${baseUrl}/api/user/checkin/captcha`, {
    method: 'POST',
    headers,
  });

  if (!captcha.response.ok || !captcha.body?.success || !captcha.body?.data?.captcha_id) {
    return {
      error: `captcha request failed: HTTP ${captcha.response.status} ${captcha.body?.message || captcha.body?.error || ''}`.trim(),
    };
  }

  const { response, body } = await fetchJson(`${baseUrl}/api/user/checkin`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      captcha_id: captcha.body.data.captcha_id,
      captcha_answer: answer,
    }),
  });

  if (response.ok && body?.success) {
    return { method: 'POST', endpoint: '/api/user/checkin', body };
  }

  const message = body?.message || body?.error || '';
  if (response.ok && alreadyCheckedInPattern.test(message)) {
    return { method: 'POST', endpoint: '/api/user/checkin', body, alreadyCheckedIn: true };
  }

  return {
    method: 'POST',
    endpoint: '/api/user/checkin',
    body,
    error: `HTTP ${response.status} ${message}`.trim(),
  };
}

async function runAccount(account) {
  const name = account.name || normalizeBaseUrl(account.url);

  if (isSub2ApiAccount(account) && !hasLoginCredential(account)) {
    throw new Error(
      'missing login credential: set accessToken/authToken from Sub2API localStorage.auth_token, or copy a logged-in browser request as curl',
    );
  }

  const status = await getStatus(account);

  if (status.checkin_enabled !== true) {
    return {
      name,
      ok: true,
      skipped: true,
      message: 'checkin is disabled by site config',
      systemName: status.system_name || '',
    };
  }

  if (dryRun) {
    return {
      name,
      ok: true,
      skipped: true,
      message: 'checkin is enabled; dry run skipped login and checkin',
      systemName: status.system_name || '',
    };
  }

  if (!hasLoginCredential(account)) {
    const headers = buildHeaders(account);
    if (hasOnlyNonLoginCookies(headers.cookie)) {
      throw new Error(
        'missing login credential: cf_clearance is only a Cloudflare clearance cookie; refresh this account from a logged-in browser request and include the NewAPI login cookie or Authorization Bearer token',
      );
    }

    throw new Error(
      'missing login credential: create accounts.json or set NEWAPI_ACCOUNTS_JSON/NEWAPI_ACCOUNTS_CURL with a browser session cookie or access token',
    );
  }

  const user = await getSelf(account);
  const result = await checkIn(account);

  if (result.error) {
    if (result.captchaRequired) {
      return {
        name,
        ok: true,
        skipped: true,
        message: result.error,
        user: user.username || user.display_name || user.email || user.id || '',
        systemName: status.system_name || '',
      };
    }

    return {
      name,
      ok: false,
      message: result.error,
      user: user.username || user.display_name || user.email || user.id || '',
      systemName: status.system_name || '',
    };
  }

  return {
    name,
    ok: true,
    message: result.body?.message || (result.alreadyCheckedIn ? 'already checked in today' : 'checkin succeeded'),
    method: result.method,
    user: user.username || user.display_name || user.email || user.id || '',
    systemName: status.system_name || '',
    data: result.body?.data,
  };
}

function resolveBarkConfig() {
  const raw = env.BARK || env.BARK_URL || env.BARK_PUSH || env.BARK_KEY || '';
  if (!raw) return null;

  const server = (env.BARK_SERVER || 'https://api.day.app').replace(/\/+$/, '');
  const endpoint = /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `${server}/${raw.replace(/^\/+/, '')}`;
  const params = new URLSearchParams();

  if (env.BARK_GROUP) params.set('group', env.BARK_GROUP);
  if (env.BARK_SOUND) params.set('sound', env.BARK_SOUND);
  if (env.BARK_ICON) params.set('icon', env.BARK_ICON);
  if (env.BARK_LEVEL) params.set('level', env.BARK_LEVEL);

  return {
    endpoint,
    params,
  };
}

function formatNotificationLine(result) {
  const mark = result.ok ? 'OK' : 'FAIL';
  const skip = result.skipped ? ' SKIP' : '';
  const parts = [`[${mark}${skip}] ${result.name}: ${result.message}`];

  if (result.user) parts.push(`user: ${result.user}`);
  if (result.data !== undefined) parts.push(`data: ${JSON.stringify(result.data)}`);

  return parts.join('\n');
}

async function sendBarkNotification(results, failed) {
  const config = resolveBarkConfig();
  if (!config) return;

  const title = failed > 0 ? `NewAPI Check-in failed ${failed}/${results.length}` : 'NewAPI Check-in succeeded';
  const targetUrl = 'https://muyuan.do/';
  const body = `${results.map(formatNotificationLine).join('\n\n')}\n\n${targetUrl}`;
  const url = `${config.endpoint}${config.params.size > 0 ? `?${config.params.toString()}` : ''}`;

  try {
    const { response, body: responseBody } = await fetchJson(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        title,
        body,
        url: targetUrl,
      }),
    });
    if (!response.ok || responseBody?.code === 400 || responseBody?.code === 500) {
      console.log(`[WARN] Bark notification failed: HTTP ${response.status} ${responseBody?.message || ''}`.trim());
    }
  } catch (error) {
    console.log(`[WARN] Bark notification failed: ${error.message}`);
  }
}

async function main() {
  const accounts = loadAccounts();

  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('No accounts configured.');
  }

  let failed = 0;
  const results = [];
  for (const account of accounts) {
    try {
      const result = await runAccount(account);
      results.push(result);
      const mark = result.ok ? 'OK' : 'FAIL';
      const skip = result.skipped ? ' SKIP' : '';
      console.log(`[${mark}${skip}] ${result.name}: ${result.message}`);
      if (result.user) console.log(`  user: ${result.user}`);
      if (result.systemName) console.log(`  system: ${result.systemName}`);
      if (result.data !== undefined) console.log(`  data: ${JSON.stringify(result.data)}`);
      if (!result.ok) failed += 1;
    } catch (error) {
      failed += 1;
      const result = {
        name: account.name || account.url,
        ok: false,
        message: error.message,
      };
      results.push(result);
      console.log(`[FAIL] ${result.name}: ${result.message}`);
    }
  }

  await sendBarkNotification(results, failed);

  if (failed > 0) {
    exit(1);
  }
}

main().catch((error) => {
  console.error(`[FATAL] ${error.message}`);
  exit(1);
});
