/**
 * FastPDF — k6 baseline load test
 *
 * Usage:
 *   k6 run -e BASE_URL=http://localhost:2626 -e AUTH_PASSWORD=yourpassword load-test/baseline.js
 *
 * Use HTML fixtures from a folder:
 *   k6 run -e BASE_URL=http://localhost:2626 -e AUTH_PASSWORD=yourpassword \
 *     -e HTML_FIXTURES_DIR=./scripts/html \
 *     -e HTML_FIXTURE_FILES=apex-report-finance.html,apex-report-operations.html,apex-report-sales.html \
 *     load-test/baseline.js
 *
 * Outputs a JSON summary when run with:
 *   k6 run --out json=load-test/runs/$(date +%Y%m%d-%H%M%S).json ...
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { getHeaderValue, loadHtmlTemplates, materializeHtml } from './shared.js';

const renderDuration = new Trend('pdf_render_duration', true);
const renderErrors = new Counter('pdf_render_errors');
const renderSuccess = new Rate('pdf_render_success_rate');

const status200Rate = new Rate('status_200_rate');
const status429Rate = new Rate('status_429_rate');
const status5xxRate = new Rate('status_5xx_rate');

const rateLimitedCount = new Counter('rate_limited_count');
const serverErrorCount = new Counter('server_error_count');
const status200Count = new Counter('status_200_count');
const status400Count = new Counter('status_400_count');
const status401Count = new Counter('status_401_count');
const status403Count = new Counter('status_403_count');
const status404Count = new Counter('status_404_count');
const status413Count = new Counter('status_413_count');
const status429Count = new Counter('status_429_count');
const status500Count = new Counter('status_500_count');
const status502Count = new Counter('status_502_count');
const status503Count = new Counter('status_503_count');
const status504Count = new Counter('status_504_count');
const statusOtherCount = new Counter('status_other_count');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:2627';
const PASSWORD = __ENV.AUTH_PASSWORD;
const HTML_FIXTURES_DIR = (__ENV.HTML_FIXTURES_DIR || '').trim();
const HTML_FIXTURE_FILES = (__ENV.HTML_FIXTURE_FILES || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

let non200SamplesLogged = 0;

if (!PASSWORD) {
    throw new Error('AUTH_PASSWORD env var is required. Pass with -e AUTH_PASSWORD=...');
}

const HTML_FIXTURE = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>Load Test Invoice</title></head>
  <body style="font-family: sans-serif; padding: 40px;">
    <h1>Invoice #VU_PLACEHOLDER</h1>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
      <thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
      <tbody>
        <tr><td>Widget A</td><td>2</td><td>$10.00</td></tr>
        <tr><td>Widget B</td><td>5</td><td>$4.50</td></tr>
        <tr><td>Widget C</td><td>1</td><td>$99.00</td></tr>
      </tbody>
    </table>
    <p style="margin-top:20px">Total: $141.50</p>
  </body>
</html>`;

const HTML_TEMPLATES = loadHtmlTemplates(HTML_FIXTURE, HTML_FIXTURE_FILES, HTML_FIXTURES_DIR);

if (HTML_FIXTURE_FILES.length > 0) {
    console.log(`Loaded ${HTML_TEMPLATES.length} HTML fixture(s) for baseline run.`);
}

export const options = {
    scenarios: {
        // baseline: {
        //     executor: 'ramping-vus',
        //     startVUs: 1,
        //     stages: [
        //         { duration: '30s', target: 3 },
        //         { duration: '1m', target: 5 },
        //         { duration: '30s', target: 0 },
        //     ],
        // },
        // individual: {
        //     executor: 'constant-vus',
        //     vus: 1,
        //     duration: '1s',
        // },
        burst: {
            executor: 'constant-vus',
            vus: 100,
            duration: '1s',
        }
    },
    thresholds: {
        pdf_render_duration: ['p(95)<15000'],
        pdf_render_success_rate: ['rate>0.99'],
        http_req_failed: ['rate<0.01'],
        status_429_rate: ['rate<0.02'],
        status_5xx_rate: ['rate<0.01'],
    },
};

export function setup() {
    const res = http.post(
        `${BASE_URL}/authenticate`,
        JSON.stringify({ password: PASSWORD }),
        { headers: { 'Content-Type': 'application/json' } },
    );
    check(res, { 'setup: auth 200': (r) => r.status === 200 });
    const token = res.json('token');
    if (!token) throw new Error(`Authentication failed — status ${res.status}: ${res.body}`);
    return { token };
}

export default function (data) {
    const marker = String(__VU * 1000 + __ITER);
    const template = HTML_TEMPLATES[(__VU + __ITER) % HTML_TEMPLATES.length];
    const html = materializeHtml(template, marker);
    const start = Date.now();

    const res = http.post(
        `${BASE_URL}/pdf-render`,
        JSON.stringify({ html, filename: `test-vu${__VU}-iter${__ITER}` }),
        {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${data.token}`,
            },
            responseType: 'text',
            timeout: '60s',
        },
    );

    renderDuration.add(Date.now() - start);

    const is200 = res.status === 200;
    const is429 = res.status === 429;
    const is5xx = res.status >= 500 && res.status < 600;

    status200Rate.add(is200 ? 1 : 0);
    status429Rate.add(is429 ? 1 : 0);
    status5xxRate.add(is5xx ? 1 : 0);

    switch (res.status) {
        case 200:
            status200Count.add(1);
            break;
        case 400:
            status400Count.add(1);
            break;
        case 401:
            status401Count.add(1);
            break;
        case 403:
            status403Count.add(1);
            break;
        case 404:
            status404Count.add(1);
            break;
        case 413:
            status413Count.add(1);
            break;
        case 429:
            status429Count.add(1);
            break;
        case 500:
            status500Count.add(1);
            break;
        case 502:
            status502Count.add(1);
            break;
        case 503:
            status503Count.add(1);
            break;
        case 504:
            status504Count.add(1);
            break;
        default:
            statusOtherCount.add(1);
            break;
    }

    if (is429) rateLimitedCount.add(1);
    if (is5xx) serverErrorCount.add(1);

    if (!is200 && __VU === 1 && non200SamplesLogged < 10) {
        const requestId = getHeaderValue(res.headers, 'x-request-id') || 'n/a';
        const body = typeof res.body === 'string' ? res.body.slice(0, 500) : '[non-text response body]';
        non200SamplesLogged += 1;
        console.error(`NON200_SAMPLE #${non200SamplesLogged} status=${res.status} requestId=${requestId} body=${body}`);
    }

    const ok = check(res, {
        'render: status 200': (r) => r.status === 200,
        'render: content-type pdf (for 200)': (r) =>
            r.status !== 200 || getHeaderValue(r.headers, 'content-type').includes('application/pdf'),
        'render: x-request-id present': (r) => !!getHeaderValue(r.headers, 'x-request-id'),
    });

    renderSuccess.add(is200 ? 1 : 0);
    if (!ok) renderErrors.add(1);

    sleep(1);
}
