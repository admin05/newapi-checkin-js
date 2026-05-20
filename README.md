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
