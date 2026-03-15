//
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

class ApiExtractor {
    constructor() {
        this.browser = null;
        this.TargetCookie = null;
        this.TargetCookieValue = null;
        this.TargetDomain = null;

        this.authPage = null;
        this.bearerToken = null;
        this.tokenExpiry = null;
        // this.init();
    }

    async init(executablePath = null) {
        console.log('starting browser...');

        const puppeteerConfig = {
            headless: true,
            ...(executablePath ? { executablePath } : {}),
            args: [
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
                '--disable-gpu'
            ]
        };

        this.browser = await puppeteer.launch(puppeteerConfig);

        this.page = await this.browser.newPage();
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        console.log('Browser initialized');
    }

    async getBearer(timeoutMs = 15000) {
        console.log('Getting fresh Bearer token...');

        if (!this.browser) {
            throw new Error('Browser not initialized. Call init() first.');
        }

        const tokenPage = await this.browser.newPage();
        await tokenPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
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

    // CookieName is what the cookie is named in the devtools value is the value from dev tools and domain is the domain of the cookie
    async setAuth(cookieName, domain, cookieValue) {
        console.log('Setting auth cookie and attempting token capture...');
        try {
            const { tokenPromise } = await this.getBearer();

            await this.authPage.setCookie({
                name: cookieName,
                value: cookieValue,
                domain: '.spotify.com'
            });

            const navigationPromise = this.authPage.goto('https://open.spotify.com/', {
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
        try {
            const response = await fetch(url || 'https://guc-spclient.spotify.com/presence-view/v1/buddylist', {
                headers: {
                    'Authorization': `Bearer ${this.bearerToken}`,
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    ...options.headers
                },
                ...options
            });

            if (response.ok) {
                return await response.json();
            }

        } catch (error) {
            console.error('API call error:', error.message);
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
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

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
                    // Response body may not be available (e.g. redirects)
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

            // Wait for any pending response body fetches
            await Promise.all(responseBodyPromises);
        } finally {
            await client.detach();
            await page.close();
        }

        return captured;
    }
    
}

module.exports = ApiExtractor;
