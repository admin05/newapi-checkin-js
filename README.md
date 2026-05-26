# NewAPI Check-in JS

Node.js script for NewAPI-style daily check-in. It currently targets:

- `https://link-ai.cc`
- `https://xiaomuai.cn`
- `https://ai.huan666.de`
- `https://elysiver.h-e.top`
- `https://xcode.best`
- `https://lpgpt.us`
- `https://api.avemujica.moe`

The script first reads `/api/status`. It only calls `/api/user/checkin` when
`checkin_enabled` is `true`. For compatible sites that use a reward pack
check-in route, it can also call `/api/user/checkin/reward-pack-plan`.

## Configure

Copy the example file:

```bash
cp accounts.example.json accounts.json
```

Edit `accounts.json` and fill in the browser login cookie. Usually the useful
part is the `session` cookie from DevTools.

```json
[
  {
    "name": "Link-AI",
    "url": "https://link-ai.cc",
    "session": "session=your_cookie_value",
    "userId": ""
  }
]
```

If the site requires the `new-api-user` or `x-user-id` header, fill `userId`
with the value from browser requests. The script sends both header names for
compatibility.

The script also accepts field names used by similar NewAPI check-in projects:

```json
[
  {
    "name": "Link-AI",
    "url": "https://link-ai.cc",
    "cookies": {
      "session": "your_cookie_value"
    },
    "api_user": "12345",
    "system_access_token": "sk-xxxxxxxxxxxxxxxx"
  }
]
```

- `cookies.session` is converted to the `Cookie` header.
- `api_user`, `apiUser`, and `user_id` are aliases of `userId`, sent as both
  `new-api-user` and `x-user-id`.
- `system_access_token`, `systemAccessToken`, and `access_token` are aliases of `accessToken` and are sent as `Authorization: Bearer ...`.
- `cf_clearance` is appended to the cookie string when present.

If the site also checks `Referer` or `Origin`, add those too:

```json
{
  "referer": "https://link-ai.cc/console/token",
  "origin": "https://link-ai.cc"
}
```

You can also paste one or more `curl` requests directly into `NEWAPI_ACCOUNTS_CURL`
and let the script extract `session`, `new-api-user`, `referer`, `origin`, and
`user-agent` automatically. `x-user-id` is also supported.

Or put a `curl` string in `accounts.json` under `curl` for each account.

You can also use environment variables:

```bash
NEWAPI_ACCOUNTS_JSON='[{"name":"Link-AI","url":"https://link-ai.cc","session":"session=xxx"}]' npm run checkin
```

For compatibility with other NewAPI check-in tools, `NEWAPI_ACCOUNTS` is also
supported. It accepts either the same JSON array or the compact
`URL#SESSION,URL#SESSION` format:

```bash
NEWAPI_ACCOUNTS='https://link-ai.cc#your_session_value,https://xiaomuai.cn#your_session_value' npm run checkin
```

## Run

Check whether the configured sites have check-in enabled:

```bash
npm run check
```

Run check-in:

```bash
npm run checkin
```

## Bark notification

Set one of these environment variables to push the execution result to Bark:

```bash
BARK='your_bark_key' npm run checkin
```

Common variants are also supported:

- `BARK`: Bark device key or a full Bark endpoint URL.
- `BARK_KEY`: Bark device key, sent through `https://api.day.app`.
- `BARK_PUSH`: device key or a full Bark endpoint URL.
- `BARK_URL`: full Bark endpoint URL.
- `BARK_SERVER`: custom Bark server, defaults to `https://api.day.app`.
- `BARK_GROUP`, `BARK_SOUND`, `BARK_ICON`, `BARK_LEVEL`: optional Bark query parameters.
