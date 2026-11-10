// A cookie jar for one configured origin. Never used to follow redirects.
export function seedCookies(header, origin) {
  const { hostname, protocol } = new URL(origin);
  return String(header || '').split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return [];
    const name = part.slice(0, separator).trim();
    return [{ name, value: part.slice(separator + 1).trim(), domain: hostname,
      path: name === 'new_api_refresh' ? '/api/user/auth' : '/', secure: protocol === 'https:', expiresAt: null, seeded: true }];
  });
}

function applicable(cookie, url, now) {
  return cookie.domain === url.hostname &&
    (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)) &&
    (!cookie.secure || url.protocol === 'https:') && (cookie.expiresAt === null || cookie.expiresAt > now);
}

export function cookieHeader(cookies, url, now = Date.now()) {
  const target = new URL(url);
  return cookies.filter((cookie) => applicable(cookie, target, now))
    .sort((a, b) => b.path.length - a.path.length)
    .map(({ name, value }) => `${name}=${value}`).join('; ');
}

export function refreshCookie(cookies, origin) {
  return cookieHeader(cookies, `${new URL(origin).origin}/api/user/auth/refresh`)
    .split('; ').find((part) => part.startsWith('new_api_refresh='))?.slice('new_api_refresh='.length) || '';
}

export function updateCookies(cookies, setCookies, url, now = Date.now()) {
  const target = new URL(url);
  let next = [...cookies];
  for (const line of setCookies) {
    const [pair, ...attributes] = line.split(';');
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~\w]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(value)) continue;
    const attrs = new Map(attributes.map((item) => {
      const index = item.indexOf('=');
      return index < 0 ? [item.trim().toLowerCase(), '']
        : [item.slice(0, index).trim().toLowerCase(), item.slice(index + 1).trim()];
    }));
    const domain = attrs.get('domain')?.replace(/^\./, '').toLowerCase();
    // Restrict stored cookies to this origin, even if a parent Domain is allowed.
    if (domain && target.hostname !== domain && !target.hostname.endsWith(`.${domain}`)) continue;
    const defaultPath = target.pathname.slice(0, target.pathname.lastIndexOf('/')) || '/';
    const path = attrs.get('path')?.startsWith('/') ? attrs.get('path') : defaultPath;
    const secure = attrs.has('secure');
    if (secure && target.protocol !== 'https:') continue;
    let expiresAt = null;
    const expires = Date.parse(attrs.get('expires'));
    if (Number.isFinite(expires)) expiresAt = expires;
    if (/^-?\d+$/.test(attrs.get('max-age') || '')) {
      const seconds = Number(attrs.get('max-age'));
      expiresAt = seconds <= 0 ? 0 : Math.min(now + seconds * 1000, Number.MAX_SAFE_INTEGER);
    }
    next = next.filter((cookie) => !(cookie.name === name && cookie.domain === target.hostname && (cookie.path === path || cookie.seeded)));
    if (expiresAt !== null && expiresAt <= now) continue;
    next.push({ name, value, domain: target.hostname, path, secure, expiresAt });
  }
  return next;
}
