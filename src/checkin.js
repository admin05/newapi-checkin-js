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
];

const dryRun = argv.includes('--dry-run');
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const alreadyCheckedInPattern = /今日已签到|已经签到|已签到|重复签到|already\s+(checked|signed)/i;

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

function parseCurlAccounts(source) {
  const accounts = [];

  for (const block of splitCurlBlocks(source)) {
    const urlMatch = block.match(/curl\s+(['"])(.*?)\1/);
    if (!urlMatch) continue;

    const url = urlMatch[2];
    const headers = parseCurlHeaders(block);
    const cookieMatch = block.match(/-b\s+(['"])([\s\S]*?)\1/);
    const cookie = cookieMatch ? cookieMatch[2].trim() : '';
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
          !['authorization', 'new-api-user', 'x-user-id', 'referer', 'origin', 'user-agent'].includes(key),
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
    normalized.systemAccessToken ||
    normalized.system_access_token ||
    '';

  normalized.userId =
    normalized.userId ||
    normalized.user_id ||
    normalized.apiUser ||
    normalized.api_user ||
    '';

  normalized.cfClearance = normalized.cfClearance || normalized.cf_clearance || '';

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
  return Boolean(headers.cookie || headers.authorization);
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

async function getStatus(account) {
  const baseUrl = normalizeBaseUrl(account.url);
  const { response, body } = await fetchJson(`${baseUrl}/api/status`, {
    headers: buildHeaders(account),
  });

  if (!response.ok || !body?.success) {
    throw new Error(`status failed: HTTP ${response.status} ${body?.message || ''}`.trim());
  }

  return body.data;
}

async function getSelf(account) {
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

  throw new Error(`login check failed: ${errors.join(' | ')}`);
}

async function checkIn(account) {
  const baseUrl = normalizeBaseUrl(account.url);
  const headers = buildHeaders(account);
  const attempts = [
    { endpoint: '/api/user/checkin', method: 'POST', body: '{}' },
    { endpoint: '/api/user/checkin', method: 'GET' },
    { endpoint: '/api/user/checkin/reward-pack-plan', method: 'POST', body: '{}' },
  ];

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

    if (response.status !== 404 && !/method not allowed/i.test(message)) {
      return { method: attempt.method, endpoint: attempt.endpoint, body, error: `HTTP ${response.status} ${message}`.trim() };
    }
  }

  return { error: 'checkin endpoint did not accept known checkin routes' };
}

async function runAccount(account) {
  const name = account.name || normalizeBaseUrl(account.url);
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
    throw new Error(
      'missing login credential: create accounts.json or set NEWAPI_ACCOUNTS_JSON/NEWAPI_ACCOUNTS_CURL with a browser session cookie or access token',
    );
  }

  const user = await getSelf(account);
  const result = await checkIn(account);

  if (result.error) {
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
  const body = results.map(formatNotificationLine).join('\n\n');
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
