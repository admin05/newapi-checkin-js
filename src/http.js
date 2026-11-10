import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function fetchJson(url, options = {}, {
  allowCurlFallback = true, transport = 'fetch', followRedirects = true,
} = {}) {
  if (transport === 'curl') return fetchJsonWithCurl(url, options, { followRedirects });
  if (transport !== 'fetch') throw new Error('invalid HTTP transport; expected fetch or curl');
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      ...options,
      redirect: followRedirects ? 'follow' : 'manual',
    });
    const text = await response.text();
    return parseJsonResponse(response.status, response.headers, text);
  } catch (error) {
    if (!allowCurlFallback || !/fetch failed|network|ENOTFOUND|ECONN/i.test(error.message)) throw error;
    return fetchJsonWithCurl(url, options, { followRedirects });
  }
}

function parseJsonResponse(status, headers, text) {
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { response: { status, ok: status >= 200 && status < 300, headers }, body };
}

// Preserve separate Set-Cookie lines, including on Node versions without getSetCookie().
export function getSetCookies(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers?.get?.('set-cookie') || '';
  return combined ? combined.split(/,\s*(?=[!#$%&'*+\-.^_`|~\w]+=)/) : [];
}

function parseCurlHeaders(raw) {
  const blocks = raw.trim().split(/\r?\n\r?\n/);
  const last = blocks.filter((block) => /^HTTP\/\S+\s+\d{3}/.test(block)).at(-1) || '';
  const headers = new Map();
  const cookies = [];
  for (const line of last.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'set-cookie') cookies.push(value);
    headers.set(name, value);
  }
  headers.getSetCookie = () => cookies;
  return headers;
}

async function fetchJsonWithCurl(url, options = {}, { followRedirects }) {
  // Header dumps contain credentials. Use a private directory and always remove it.
  const directory = mkdtempSync(join(tmpdir(), 'newapi-http-'));
  const headerFile = join(directory, 'headers');
  try {
    writeFileSync(headerFile, '', { mode: 0o600, flag: 'wx' });
    const args = ['-sS', '--max-time', '20', '-X', options.method || 'GET', '-D', headerFile];
    if (followRedirects) args.push('-L');
    for (const [key, value] of Object.entries(options.headers || {})) {
      if (value !== undefined && value !== '') args.push('-H', `${key}: ${value}`);
    }
    if (options.body !== undefined) args.push('--data-raw', options.body);
    args.push('-w', '\n%{http_code}', url);
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      // Do not echo curl stderr: proxy errors can include credential-bearing URLs.
      child.stderr.resume();
      child.on('error', () => reject(new Error('curl could not start; check that curl is installed')));
      child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`curl request failed (exit ${code})`)));
    });
    const match = stdout.match(/\n(\d{3})$/);
    if (!match) throw new Error('curl response did not include HTTP status');
    return parseJsonResponse(Number(match[1]), parseCurlHeaders(readFileSync(headerFile, 'utf8')), stdout.slice(0, match.index));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
