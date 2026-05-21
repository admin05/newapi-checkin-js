# NewAPI Check-in JS

Node.js script for NewAPI-style daily check-in. It currently targets:

- `https://link-ai.cc`
- `https://xiaomuai.cn`

The script first reads `/api/status`. It only calls `/api/user/checkin` when
`checkin_enabled` is `true`.

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

If the site requires the `new-api-user` header, fill `userId` with the value
from browser requests.

If the site also checks `Referer` or `Origin`, add those too:

```json
{
  "referer": "https://link-ai.cc/console/token",
  "origin": "https://link-ai.cc"
}
```

You can also paste one or more `curl` requests directly into `NEWAPI_ACCOUNTS_CURL`
and let the script extract `session`, `new-api-user`, `referer`, `origin`, and
`user-agent` automatically.

Or put a `curl` string in `accounts.json` under `curl` for each account.

You can also use environment variables:

```bash
NEWAPI_ACCOUNTS_JSON='[{"name":"Link-AI","url":"https://link-ai.cc","session":"session=xxx"}]' npm run checkin
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
