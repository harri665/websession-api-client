# websession-api-client

Call APIs using a browser-captured bearer token, or call public APIs without auth.

## Usage

```js
const ApiExtractor = require('./index');

(async () => {
  const client = new ApiExtractor();
  await client.init();

  // 1) Public API (no auth header sent)
  const publicData = await client.callApi('https://api.example.com/public', {
    auth: false
  });

  // 2) Set auth (captures a bearer token from site traffic)
  await client.setAuth('cookie_name', 'app.example.com', 'cookie_value');

  // 3) Authenticated API (explicit)
  const privateData = await client.callApi('https://api.example.com/private', {
    auth: true
  });

  // 4) Authenticated API with helper
  const privateData2 = await client.callAuthApi('https://api.example.com/private');

  // 5) POST JSON (auth optional)
  const created = await client.callApi('https://api.example.com/items', {
    method: 'POST',
    auth: true,
    json: { name: 'test' }
  });

  // 6) Browser-session request (useful for sites protected by Cloudflare/anti-bot checks)
  const protectedData = await client.callApi('https://www.example.com/api/data.json', {
    auth: false,
    transport: 'browser'
  });

  console.log({ publicData, privateData, privateData2, created, protectedData });
})();
```

## `callApi(url, options)`

Supports normal `fetch` options plus:

- `auth`: `true` | `false` | `'auto'` (default)
  - `true`: require bearer token and send `Authorization`
  - `false`: never send `Authorization`
  - `'auto'`: send `Authorization` only if a bearer token is available
- `json`: object to JSON.stringify into `body` and auto-set `Content-Type: application/json`
- `transport`: `'node'` (default) | `'browser'`
  - `'node'`: regular Node.js `fetch`
  - `'browser'`: runs `fetch` inside the Puppeteer page session (uses browser cookies/session)

All other `fetch` options (`method`, `headers`, `body`, etc.) are passed through.

## Cloudflare / Bot Protection Note

If a public endpoint returns an HTML challenge page (403) instead of JSON, that is usually a bot-protection challenge, not an auth issue.

Use browser transport:

```js
const data = await client.callApi('https://www.artstation.com/users/yourname/projects.json', {
  auth: false,
  transport: 'browser'
});
```

If the site still challenges headless Chrome, start Puppeteer in a visible window and complete the check once:

```js
await client.init({ headless: false });
```
