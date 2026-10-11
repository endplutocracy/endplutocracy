// End Plutocracy - server
// No dependencies. Requires Node 18+ (built-in fetch).
// Run: node server.js   ->   http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES) || 30;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Configuration: edit these to change what the site tracks ----------

// Economic indicators come from FRED's public CSV endpoint (no API key needed).
// transform: 'level' = raw value, 'yoy' = year-over-year % change (monthly data),
//            'qoq_annualized' = quarterly growth, annualized.
const INDICATORS = [
  { id: 'UNRATE',   label: 'Unemployment rate',            unit: '%',  transform: 'level' },
  { id: 'CPIAUCSL', label: 'Inflation (CPI, YoY)',         unit: '%',  transform: 'yoy' },
  { id: 'FEDFUNDS', label: 'Federal funds rate',           unit: '%',  transform: 'level' },
  { id: 'DGS10',    label: '10-year Treasury yield',       unit: '%',  transform: 'level' },
  { id: 'T10Y2Y',   label: '10Y minus 2Y yield spread',    unit: 'pp', transform: 'level' },
  { id: 'GDPC1',    label: 'Real GDP growth (annualized)', unit: '%',  transform: 'qoq_annualized' },
];

// Wealth distribution: Federal Reserve Distributional Financial Accounts, via FRED.
// Quarterly. Shares are percent of total household net worth; levels are millions of dollars.
const WEALTH_SERIES = {
  top1:     'WFRBST01134', // Top 1% (99th-100th percentiles) share
  top01:    'WFRBSTP1300', // Top 0.1% share
  next9:    'WFRBSN09161', // 90th-99th percentiles share
  next40:   'WFRBSN40188', // 50th-90th percentiles share
  bottom50: 'WFRBSB50215', // Bottom 50% share
  top1Level:     'WFRBLT01026', // Net worth held by the top 1%
  bottom50Level: 'WFRBLB50107', // Net worth held by the bottom 50%
};

// News: public RSS feeds. Add or remove freely.
const googleNews = (q) =>
  'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:7d') + '&hl=en-US&gl=US&ceid=US:en';

const FEEDS = [
  { name: 'Wealth gap',      url: googleNews('"wealth inequality" OR "wealth gap" OR "income inequality"') },
  { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { name: 'BLS',             url: 'https://www.bls.gov/feed/bls_latest.rss' },
  { name: 'NYT Economy',     url: 'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml' },
  { name: 'BBC Business',    url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
];

// ---------- Merch + checkout settings ----------

// The shop sells one item. Prices are in cents and are ALWAYS taken from here on the
// server, never from the browser, so a visitor cannot change what they pay.
const MERCH = [
  { id: 'sticker', name: 'End Plutocracy sticker', description: 'The logo, for laptops, bottles and lamp posts.', priceCents: 300 },
];

// Checkout runs on Stripe's hosted payment page. Set these as environment variables:
//   STRIPE_SECRET_KEY  your Stripe secret key (sk_live_... or sk_test_...). Required.
//   SITE_URL           your public address, e.g. https://endplutocracy.rip (needed once it is online)
//   SHIPPING_CENTS     flat shipping charged per order, in cents. Default 0 (free shipping).
//   SHIP_COUNTRIES     comma-separated country codes you ship to. Default US.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_API = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const SHIPPING_CENTS = Math.max(0, Math.round(Number(process.env.SHIPPING_CENTS) || 0));
const SHIP_COUNTRIES = (process.env.SHIP_COUNTRIES || 'US').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
const MAX_QUANTITY = 20;

const MAX_NEWS_ITEMS = 50;
const HISTORY_POINTS = 60;

// ---------- Helpers ----------

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EndPlutocracy/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, '') // feeds often escape HTML, so strip again after decoding
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

// Handles RSS (<item>) and Atom (<entry>). Google News titles end in " - Publisher";
// that suffix is split into its own field.
function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    let link = tag(b, 'link');
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1] : '';
    }
    let title = tag(b, 'title');
    let publisher = tag(b, 'source');
    if (publisher && title.endsWith(' - ' + publisher)) {
      title = title.slice(0, -(publisher.length + 3));
    }
    const dateStr = tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'updated') || tag(b, 'published');
    const date = dateStr ? new Date(dateStr) : null;
    return {
      title,
      publisher,
      link,
      summary: publisher ? '' : (tag(b, 'description') || tag(b, 'summary')).slice(0, 220),
      date: date && !isNaN(date) ? date.toISOString() : null,
    };
  }).filter((i) => i.title && i.link);
}

function parseCsvSeries(csv) {
  const rows = csv.trim().split(/\r?\n/).slice(1);
  const out = [];
  for (const row of rows) {
    const [date, raw] = row.split(',');
    const value = parseFloat(raw);
    if (date && Number.isFinite(value)) out.push({ date, value });
  }
  return out;
}

function applyTransform(points, transform) {
  if (transform === 'yoy') {
    return points.slice(12).map((p, i) => ({
      date: p.date,
      value: (p.value / points[i].value - 1) * 100,
    }));
  }
  if (transform === 'qoq_annualized') {
    return points.slice(1).map((p, i) => ({
      date: p.date,
      value: (Math.pow(p.value / points[i].value, 4) - 1) * 100,
    }));
  }
  return points;
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

const fredCsv = (id) => fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);

async function loadIndicator(cfg) {
  const series = applyTransform(parseCsvSeries(await fredCsv(cfg.id)), cfg.transform);
  if (series.length < 2) throw new Error(`Not enough data for ${cfg.id}`);
  const latest = series[series.length - 1];
  const prev = series[series.length - 2];
  return {
    id: cfg.id,
    label: cfg.label,
    unit: cfg.unit,
    latest: round(latest.value),
    date: latest.date,
    change: round(latest.value - prev.value),
    history: series.slice(-HISTORY_POINTS).map((p) => ({ date: p.date, value: round(p.value) })),
    link: `https://fred.stlouisfed.org/series/${cfg.id}`,
  };
}

// Builds the wealth-gap summary from the raw quarterly series.
function buildWealth(raw) {
  const last = (s) => s[s.length - 1];
  const first = (s) => s[0];
  const group = (key, label, households) => ({
    key, label, households,
    share: round(last(raw[key]).value, 1),
    firstShare: round(first(raw[key]).value, 1),
    firstDate: first(raw[key]).date,
  });
  const top1Level = last(raw.top1Level).value;       // millions of dollars
  const bottom50Level = last(raw.bottom50Level).value;
  return {
    asOf: last(raw.top1).date,
    groups: [
      group('top1',     'Top 1%',                 1),
      group('next9',    'Next 9% (90th–99th)',    9),
      group('next40',   'Next 40% (50th–90th)',   40),
      group('bottom50', 'Bottom 50%',             50),
    ],
    top01: { share: round(last(raw.top01).value, 1), firstShare: round(first(raw.top01).value, 1), firstDate: first(raw.top01).date },
    top1Trillions: round(top1Level / 1e6, 1),
    bottom50Trillions: round(bottom50Level / 1e6, 1),
    ratio: round(top1Level / bottom50Level, 1),
    trend: {
      top1: raw.top1.map((p) => ({ date: p.date, value: round(p.value, 2) })),
      bottom50: raw.bottom50.map((p) => ({ date: p.date, value: round(p.value, 2) })),
    },
    link: 'https://fred.stlouisfed.org/series/' + WEALTH_SERIES.top1,
  };
}

async function loadWealth() {
  const keys = Object.keys(WEALTH_SERIES);
  const results = await Promise.all(keys.map(async (k) => {
    const s = parseCsvSeries(await fredCsv(WEALTH_SERIES[k]));
    if (s.length < 2) throw new Error(`Not enough data for ${WEALTH_SERIES[k]}`);
    return [k, s];
  }));
  return buildWealth(Object.fromEntries(results));
}

// ---------- Cache + scheduled refresh ----------

const cache = { updatedAt: null, wealth: null, indicators: [], news: [], merch: MERCH, shippingCents: SHIPPING_CENTS, errors: [] };

async function refresh() {
  const errors = [];

  const [wealthRes, ...indResults] = await Promise.allSettled([
    loadWealth(),
    ...INDICATORS.map(loadIndicator),
  ]);

  let wealth = cache.wealth;
  if (wealthRes.status === 'fulfilled') wealth = wealthRes.value;
  else errors.push(`Wealth data: ${wealthRes.reason.message}`);

  const indicators = [];
  indResults.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      indicators.push(r.value);
    } else {
      errors.push(`${INDICATORS[i].id}: ${r.reason.message}`);
      const old = cache.indicators.find((x) => x.id === INDICATORS[i].id);
      if (old) indicators.push(old); // keep stale data rather than dropping the card
    }
  });

  const feedResults = await Promise.allSettled(
    FEEDS.map(async (f) => parseFeed(await fetchText(f.url)).slice(0, 20).map((i) => ({ ...i, source: f.name })))
  );
  let news = [];
  feedResults.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      news = news.concat(r.value);
    } else {
      errors.push(`${FEEDS[i].name}: ${r.reason.message}`);
      news = news.concat(cache.news.filter((n) => n.source === FEEDS[i].name));
    }
  });
  news.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  cache.wealth = wealth;
  cache.indicators = indicators;
  cache.news = news.slice(0, MAX_NEWS_ITEMS);
  cache.errors = errors;
  cache.updatedAt = new Date().toISOString();
  console.log(`[${cache.updatedAt}] refreshed: wealth ${wealth ? 'ok' : 'missing'}, ${indicators.length} indicators, ${cache.news.length} headlines, ${errors.length} errors`);
  errors.forEach((e) => console.warn('  ! ' + e));
}

// ---------- Checkout (Stripe hosted payment page) ----------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return; // stop collecting; the handler replies 413 and closes the connection
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        const err = new Error('Request too large');
        err.code = 'TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function createCheckoutSession(item, quantity, origin) {
  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('success_url', origin + '/?checkout=success#merch');
  p.set('cancel_url', origin + '/?checkout=cancelled#merch');
  p.set('line_items[0][quantity]', String(quantity));
  p.set('line_items[0][price_data][currency]', 'usd');
  p.set('line_items[0][price_data][unit_amount]', String(item.priceCents));
  p.set('line_items[0][price_data][product_data][name]', item.name);
  if (item.description) p.set('line_items[0][price_data][product_data][description]', item.description);
  p.set('metadata[item_id]', item.id);
  SHIP_COUNTRIES.forEach((c, i) => p.set(`shipping_address_collection[allowed_countries][${i}]`, c));
  if (SHIPPING_CENTS > 0) {
    p.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    p.set('shipping_options[0][shipping_rate_data][display_name]', 'Standard shipping');
    p.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(SHIPPING_CENTS));
    p.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'usd');
  }

  const res = await fetch(STRIPE_API + '/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.url) {
    throw new Error((json.error && json.error.message) || `Stripe returned HTTP ${res.status}`);
  }
  return json.url;
}

async function handleCheckout(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Use POST.' });
  }
  if (!STRIPE_KEY) {
    return sendJson(res, 503, { error: 'Checkout is not set up yet. Please check back soon.' });
  }
  let body;
  try { body = await readJson(req); }
  catch (e) {
    if (e.code === 'TOO_LARGE') {
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
      return sendJson(res, 413, { error: 'Request too large.' });
    }
    return sendJson(res, 400, { error: 'Bad request.' });
  }

  const item = MERCH.find((m) => m.id === body.id);
  const quantity = Number(body.quantity);
  if (!item) return sendJson(res, 400, { error: 'Unknown item.' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return sendJson(res, 400, { error: `Quantity must be a whole number from 1 to ${MAX_QUANTITY}.` });
  }

  try {
    const origin = SITE_URL || `http://${req.headers.host}`;
    const url = await createCheckoutSession(item, quantity, origin);
    sendJson(res, 200, { url });
  } catch (e) {
    console.error('Checkout error:', e.message);
    sendJson(res, 502, { error: 'We could not start checkout. Please try again in a moment.' });
  }
}

// ---------- HTTP server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(cache));
  }

  if (url.pathname === '/api/checkout') return handleCheckout(req, res);

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`End Plutocracy running at http://localhost:${PORT} (refreshing every ${REFRESH_MINUTES} min)`);
    console.log(STRIPE_KEY ? 'Checkout: Stripe key found, checkout is on.' : 'Checkout: no STRIPE_SECRET_KEY set, the Buy button will say checkout is not set up yet.');
    refresh().catch((e) => console.error('Initial refresh failed:', e));
    setInterval(() => refresh().catch((e) => console.error('Refresh failed:', e)), REFRESH_MINUTES * 60 * 1000);
  });
}

module.exports = { parseFeed, parseCsvSeries, applyTransform, buildWealth, MERCH };
