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

    async init() {
        console.log('starting browser...');

        const puppeteerConfig = {
            headless: true,
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
        // if (!this.bearerToken || Date.now() > this.tokenExpiry) {
        //     const success = await this.getToken();
        //     if (!success) {
        //         console.error('❌ Could not get token');
        //         return null;
        //     }
        // }

        try { 
            const response = await fetch('https://guc-spclient.spotify.com/presence-view/v1/buddylist', {
                headers: {
                    'Authorization': `Bearer ${this.bearerToken}`,
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                }
            });

            if (response.ok) {
                return await response.json();

            }

        } catch (error) {
            console.error('API call error:', error.message);
            return null;
        }
    
    }
    
}

module.exports = ApiExtractor;
