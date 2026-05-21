import { existsSync, readFileSync } from 'node:fs';
import { env, argv, exit } from 'node:process';
import { spawn } from 'node:child_process';

const DEFAULT_ACCOUNTS = [
  { name: 'Link-AI', url: 'https://link-ai.cc' },
  { name: 'Xiaomu API', url: 'https://xiaomuai.cn' },
];

const dryRun = argv.includes('--dry-run');

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
      userId: headers['new-api-user'] || '',
      referer: headers.referer || '',
      origin: headers.origin || '',
      userAgent: headers['user-agent'] || '',
      extraHeaders: Object.fromEntries(
        Object.entries(headers).filter(([key]) =>
          !['authorization', 'new-api-user', 'referer', 'origin', 'user-agent'].includes(key),
        ),
      ),
    });
  }

  return accounts;
}

function loadAccounts() {
  if (env.NEWAPI_ACCOUNTS_CURL) {
    const parsed = parseCurlAccounts(env.NEWAPI_ACCOUNTS_CURL);
    if (parsed.length > 0) return parsed;
  }

  if (env.NEWAPI_ACCOUNTS_JSON) {
    return JSON.parse(env.NEWAPI_ACCOUNTS_JSON);
  }

  const configPath = env.NEWAPI_ACCOUNTS_FILE || 'accounts.json';
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  }

  return DEFAULT_ACCOUNTS.map((account) => ({
    ...account,
    session: env.NEWAPI_SESSION || '',
    accessToken: env.NEWAPI_ACCESS_TOKEN || '',
    userId: env.NEWAPI_USER_ID || '',
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
  }

  headers.referer = account.referer || `${normalizeBaseUrl(account.url)}/console/personal`;

  headers.origin = account.origin || normalizeBaseUrl(account.url);

  if (account.userAgent) {
    headers['user-agent'] = account.userAgent;
  }

  return headers;
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
  const methods = ['POST', 'GET'];

  for (const method of methods) {
    const { response, body } = await fetchJson(`${baseUrl}/api/user/checkin`, {
      method,
      headers,
      body: method === 'POST' ? '{}' : undefined,
    });

    if (response.ok && body?.success) {
      return { method, body };
    }

    const message = body?.message || body?.error || '';
    if (response.status !== 404 && !/method not allowed/i.test(message)) {
      return { method, body, error: `HTTP ${response.status} ${message}`.trim() };
    }
  }

  return { error: 'checkin endpoint did not accept POST or GET' };
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
    message: result.body?.message || 'checkin succeeded',
    method: result.method,
    user: user.username || user.display_name || user.email || user.id || '',
    systemName: status.system_name || '',
    data: result.body?.data,
  };
}

async function main() {
  const accounts = loadAccounts();

  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('No accounts configured.');
  }

  let failed = 0;
  for (const account of accounts) {
    try {
      const result = await runAccount(account);
      const mark = result.ok ? 'OK' : 'FAIL';
      const skip = result.skipped ? ' SKIP' : '';
      console.log(`[${mark}${skip}] ${result.name}: ${result.message}`);
      if (result.user) console.log(`  user: ${result.user}`);
      if (result.systemName) console.log(`  system: ${result.systemName}`);
      if (result.data !== undefined) console.log(`  data: ${JSON.stringify(result.data)}`);
      if (!result.ok) failed += 1;
    } catch (error) {
      failed += 1;
      console.log(`[FAIL] ${account.name || account.url}: ${error.message}`);
    }
  }

  if (failed > 0) {
    exit(1);
  }
}

main().catch((error) => {
  console.error(`[FATAL] ${error.message}`);
  exit(1);
});
