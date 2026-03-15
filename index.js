const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Resolve Chrome executable in order of preference:
//   1. PUPPETEER_EXECUTABLE_PATH env var (set in Docker/CI)
//   2. Common system-installed Chrome/Chromium paths
//   3. Puppeteer's own downloaded Chrome (falls back to its default)
function resolveChromePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const candidates = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
    ];

    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // not found, try next
        }
    }

    // Let Puppeteer use its own downloaded Chrome
    return null;
}

class ApiExtractor {
    constructor() {
        this.browser = null;
        this.page = null;
        this.TargetCookie = null;
        this.TargetCookieValue = null;
        this.TargetDomain = null;

        this.authPage = null;
        this.bearerToken = null;
        this.tokenExpiry = null;
    }

    async init(options = {}) {
        console.log('starting browser...');

        const chromePath = options.executablePath || resolveChromePath();
        if (chromePath) {
            console.log('Using Chrome at:', chromePath);
        }

        const defaultArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-gpu',
        ];

        const puppeteerConfig = {
            headless: true,
            ...(chromePath ? { executablePath: chromePath } : {}),
            ...options,
            args: options.args ? [...defaultArgs, ...options.args] : defaultArgs
        };

        this.browser = await puppeteer.launch(puppeteerConfig);

        this.page = await this.browser.newPage();
        await this.page.setUserAgent(DEFAULT_USER_AGENT);

        console.log('Browser initialized');
    }

    async getBearer(timeoutMs = 15000) {
        console.log('Getting fresh Bearer token...');

        if (!this.browser) {
            throw new Error('Browser not initialized. Call init() first.');
        }

        const tokenPage = await this.browser.newPage();
        await tokenPage.setUserAgent(DEFAULT_USER_AGENT);
        await tokenPage.setRequestInterception(true);

        let settled = false;
        let timeoutId;

        const tokenPromise = new Promise((resolve) => {
            const onRequest = (request) => {
                try {
                    const authHeader = request.headers()['authorization'];
                    if (!settled && authHeader && authHeader.startsWith('Bearer ') && authHeader.length > 100) {
                        settled = true;
                        const capturedToken = authHeader.substring(7);
                        console.log('Fresh Bearer token captured:', capturedToken.substring(0, 10) + '...');
                        clearTimeout(timeoutId);
                        tokenPage.off('request', onRequest);
                        resolve(capturedToken);
                    }
                } finally {
                    request.continue();
                }
            };

            tokenPage.on('request', onRequest);

            timeoutId = setTimeout(() => {
                if (settled) return;
                settled = true;
                tokenPage.off('request', onRequest);
                resolve(null);
            }, timeoutMs);
        });

        this.authPage = tokenPage;
        return { tokenPromise };
    }

    // CookieName is what the cookie is named in devtools, value is the value from devtools, and domain is the cookie domain
    async setAuth(cookieName, domain, cookieValue) {
        this.TargetDomain = domain;
        this.TargetCookie = cookieName;
        this.TargetCookieValue = cookieValue;
        console.log('Setting auth cookie and attempting token capture...');
        try {
            const { tokenPromise } = await this.getBearer();

            const domainparts = this.TargetDomain.split('.').slice(-2);
            const baseDomain = domainparts.join('.');

            await this.authPage.setCookie({
                name: this.TargetCookie,
                value: this.TargetCookieValue,
                domain: `.${baseDomain}`,
            });

            const navigationPromise = this.authPage.goto(`https://${this.TargetDomain}/`, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            }).catch((error) => {
                if (error && error.name === 'TimeoutError') {
                    return null;
                }
                throw error;
            });

            const capturedToken = await tokenPromise;
            await navigationPromise;

            if (capturedToken) {
                this.bearerToken = capturedToken;
                this.tokenExpiry = Date.now() + (55 * 60 * 1000);
                console.log('Bearer token set successfully');
                await this.authPage.close();
                return true;
            }

            console.log('No Bearer token captured');
            await this.authPage.close();
            return false;
        } catch (error) {
            console.error('Bearer token extraction error:', error.message);
            return false;
        }
    }

    async callApi(url, options = {}) {
        const {
            auth = 'auto',
            transport = 'node',
            headers = {},
            json,
            ...fetchOptions
        } = options;

        const shouldUseAuth = auth === true || (auth === 'auto' && !!this.bearerToken);

        if (auth === true && !this.bearerToken) {
            throw new Error('This request requires auth, but no bearer token is set. Call setAuth() first.');
        }

        const finalHeaders = {
            'Accept': 'application/json',
            'User-Agent': DEFAULT_USER_AGENT,
            ...headers
        };

        if (shouldUseAuth) {
            finalHeaders.Authorization = `Bearer ${this.bearerToken}`;
        }

        // Convenience: pass { json: {...} } instead of manually stringifying body
        if (json !== undefined) {
            fetchOptions.body = JSON.stringify(json);
            const hasContentTypeHeader = Object.keys(finalHeaders).some(
                (key) => key.toLowerCase() === 'content-type'
            );
            if (!hasContentTypeHeader) {
                finalHeaders['Content-Type'] = 'application/json';
            }
        }

        if (transport === 'browser') {
            return this.callApiInBrowser(url, {
                ...fetchOptions,
                headers: finalHeaders
            });
        }

        try {
            const response = await fetch(url, {
                ...fetchOptions,
                headers: finalHeaders
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.error(`API call failed (${response.status} ${response.statusText})`, errorText);
                return null;
            }

            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                return await response.json();
            }

            return await response.text();
        } catch (error) {
            console.error('API call error:', error.message);
            return null;
        }
    }

    async callAuthApi(url, options = {}) {
        return this.callApi(url, { ...options, auth: true });
    }

    async callApiInBrowser(url, options = {}) {
        if (!this.page) {
            throw new Error('Browser page not initialized. Call init() first.');
        }

        const browserFetchOptions = { ...options };

        if (browserFetchOptions.body !== undefined && typeof browserFetchOptions.body !== 'string') {
            throw new Error('Browser transport only supports string bodies. Use `json` or a string `body`.');
        }

        if (!browserFetchOptions.credentials) {
            browserFetchOptions.credentials = 'include';
        }

        let currentOrigin = null;
        let targetOrigin = null;

        try {
            currentOrigin = new URL(this.page.url()).origin;
        } catch (error) {
            currentOrigin = null;
        }

        try {
            targetOrigin = new URL(url).origin;
        } catch (error) {
            targetOrigin = null;
        }

        // Reduce CORS issues by putting the browser page on the target origin first.
        if (targetOrigin && currentOrigin !== targetOrigin) {
            try {
                await this.page.goto(targetOrigin, {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
            } catch (error) {
                if (!error || error.name !== 'TimeoutError') {
                    throw error;
                }
            }
        }

        try {
            const response = await this.page.evaluate(async ({ requestUrl, requestOptions }) => {
                try {
                    const res = await fetch(requestUrl, requestOptions);
                    const headers = {};

                    res.headers.forEach((value, key) => {
                        headers[key] = value;
                    });

                    return {
                        ok: res.ok,
                        status: res.status,
                        statusText: res.statusText,
                        headers,
                        text: await res.text()
                    };
                } catch (error) {
                    return {
                        ok: false,
                        status: 0,
                        statusText: 'BrowserFetchError',
                        headers: {},
                        text: error && error.message ? error.message : String(error)
                    };
                }
            }, {
                requestUrl: url,
                requestOptions: browserFetchOptions
            });

            if (!response.ok) {
                console.error(`API call failed (${response.status} ${response.statusText})`, response.text);
                return null;
            }

            const contentType = (response.headers && response.headers['content-type']) || '';
            if (contentType.includes('application/json')) {
                try {
                    return JSON.parse(response.text);
                } catch (error) {
                    console.error('API call error: failed to parse JSON response from browser transport');
                    return null;
                }
            }

            return response.text;
        } catch (error) {
            console.error('API call error (browser transport):', error.message);
            return null;
        }
    }

    /**
     * Navigate to any webpage and capture matching network requests/responses.
     *
     * @param {string} targetUrl - The URL to navigate to.
     * @param {object} [options]
     * @param {function} [options.filter] - Called with a request summary object.
     *   Return true to capture that request. If omitted, all requests are captured.
     *   Summary shape: { url, method, headers, postData, resourceType }
     * @param {boolean} [options.captureResponse] - Also capture response body (slower). Default false.
     * @param {number} [options.timeout] - Max ms to wait for page + requests. Default 30000.
     * @param {number} [options.waitAfterLoad] - Extra ms to wait after page load for late requests. Default 3000.
     * @param {number} [options.maxCaptures] - Stop early after capturing this many. Default Infinity.
     * @param {object[]} [options.cookies] - Cookies to set before navigating.
     *   Each: { name, value, domain, ... }
     * @returns {Promise<object[]>} Array of captured request (and optionally response) objects.
     */
    async captureRequests(targetUrl, options = {}) {
        const {
            filter = null,
            captureResponse = false,
            timeout = 30000,
            waitAfterLoad = 3000,
            maxCaptures = Infinity,
            cookies = []
        } = options;

        if (!this.browser) {
            throw new Error('Browser not initialized. Call init() first.');
        }

        const page = await this.browser.newPage();
        await page.setUserAgent(DEFAULT_USER_AGENT);

        if (cookies.length > 0) {
            await page.setCookie(...cookies);
        }

        const captured = [];
        const responseBodyPromises = [];

        // Use CDP for response body capture since request interception
        // can interfere with page behavior on some sites.
        const client = await page.createCDPSession();
        await client.send('Network.enable');

        // Map requestId -> request data for pairing requests with responses
        const pendingRequests = new Map();

        client.on('Network.requestWillBeSent', (event) => {
            const summary = {
                requestId: event.requestId,
                url: event.request.url,
                method: event.request.method,
                headers: event.request.headers,
                postData: event.request.postData || null,
                resourceType: event.type
            };

            const shouldCapture = filter ? filter(summary) : true;
            if (shouldCapture) {
                pendingRequests.set(event.requestId, summary);
            }
        });

        client.on('Network.responseReceived', async (event) => {
            const reqData = pendingRequests.get(event.requestId);
            if (!reqData) return;

            const entry = {
                request: {
                    url: reqData.url,
                    method: reqData.method,
                    headers: reqData.headers,
                    postData: reqData.postData,
                    resourceType: reqData.resourceType
                },
                response: {
                    status: event.response.status,
                    headers: event.response.headers,
                    mimeType: event.response.mimeType
                }
            };

            if (captureResponse) {
                const p = client.send('Network.getResponseBody', {
                    requestId: event.requestId
                }).then(({ body, base64Encoded }) => {
                    entry.response.body = base64Encoded
                        ? Buffer.from(body, 'base64').toString('utf-8')
                        : body;
                }).catch(() => {
                    entry.response.body = null;
                });
                responseBodyPromises.push(p);
            }

            captured.push(entry);
            pendingRequests.delete(event.requestId);
        });

        try {
            await page.goto(targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout
            }).catch((err) => {
                if (err && err.name === 'TimeoutError') return null;
                throw err;
            });

            // Wait for late-firing requests (XHR, fetch, GraphQL, etc.)
            if (captured.length < maxCaptures) {
                await new Promise((r) => setTimeout(r, waitAfterLoad));
            }

            await Promise.all(responseBodyPromises);
        } finally {
            await client.detach();
            await page.close();
        }

        return captured;
    }
}

module.exports = ApiExtractor;
