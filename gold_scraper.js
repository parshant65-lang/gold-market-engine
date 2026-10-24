const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const cheerio = require('cheerio');

// Configuration
const VAULT_PAT = process.env.VAULT_PAT || process.env.GITHUB_TOKEN;
const VAULT_REPO_URL = VAULT_PAT
  ? `https://x-access-token:${VAULT_PAT}@github.com/parshant65-lang/gold-data-vault.git`
  : null;
const VAULT_DIR = path.join('/tmp', 'gold_vault_repo');

const CONCURRENCY = 24; // 24 parallel worker streams for 1 Lakh / 24h throughput
const RUN_DURATION_MS = 5.5 * 60 * 60 * 1000; // 5.5 hours
const HANDOVER_TRIGGER_MS = 5 * 60 * 60 * 1000 + 20 * 60 * 1000; // 5h 20m
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes failsafe sync
const BATCH_SYNC_THRESHOLD = 250; // Sync immediately every 250 articles
const START_TIME = Date.now();

let isShuttingDown = false;
let nextRelayTriggered = false;
let registry = {};
let newArticlesCount = 0;
let totalIngestedSession = 0;
let isSyncing = false;

// High-speed HTTP agents with Keep-Alive
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128, timeout: 15000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, timeout: 15000 });

// User-Agent pool
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fast HTTP Fetch Helper
function fetchPage(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error(`Too many redirects for ${url}`));

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const req = client.get(url, {
      agent,
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          redirectUrl = `${parsedUrl.origin}${redirectUrl}`;
        }
        return fetchPage(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

// Vault Management
function initVault() {
  if (!VAULT_REPO_URL) {
    console.warn('⚠️ VAULT_PAT not set! Running in local testing mode.');
    if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });
    loadRegistry();
    return;
  }

  console.log('🔄 Initializing Private Data Vault clone...');
  if (!fs.existsSync(VAULT_DIR)) {
    execSync(`git clone --depth 1 ${VAULT_REPO_URL} "${VAULT_DIR}"`, { stdio: 'inherit' });
  } else {
    try {
      execSync(`cd "${VAULT_DIR}" && git pull --rebase origin main`, { stdio: 'inherit' });
    } catch (e) {
      console.warn('Pull failed, continuing with existing cache:', e.message);
    }
  }

  execSync(`cd "${VAULT_DIR}" && git config user.name "GoldEngine[bot]" && git config user.email "goldengine-bot@users.noreply.github.com"`);
  loadRegistry();
}

function loadRegistry() {
  const regPath = path.join(VAULT_DIR, 'registry.json');
  if (fs.existsSync(regPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      console.log(`📦 Loaded registry containing ${Object.keys(registry).length} previously processed items.`);
    } catch (e) {
      console.warn('⚠️ Registry parse failed, starting fresh:', e.message);
      registry = {};
    }
  } else {
    registry = {};
  }
}

function saveRegistry() {
  const regPath = path.join(VAULT_DIR, 'registry.json');
  fs.writeFileSync(regPath, JSON.stringify(registry, null, 2), 'utf8');
}

function syncVault(force = false) {
  if (!VAULT_REPO_URL) return;
  if (newArticlesCount === 0 && !force) return;
  if (isSyncing) return;

  isSyncing = true;
  try {
    saveRegistry();
    console.log(`📤 Syncing +${newArticlesCount} items to gold-data-vault (Total session: ${totalIngestedSession + newArticlesCount} | Registry: ${Object.keys(registry).length})...`);
    execSync(`cd "${VAULT_DIR}" && git add -A`);
    const status = execSync(`cd "${VAULT_DIR}" && git status --porcelain`).toString().trim();
    if (!status) {
      console.log('ℹ️ Working tree clean, nothing to commit.');
      isSyncing = false;
      return;
    }

    const timestamp = new Date().toISOString();
    execSync(`cd "${VAULT_DIR}" && git commit -m "Ingest gold intelligence: +${newArticlesCount} items [${timestamp}]"`);
    execSync(`cd "${VAULT_DIR}" && git push origin main`, { stdio: 'inherit' });
    console.log(`✅ Successfully pushed +${newArticlesCount} items to gold-data-vault!`);
    totalIngestedSession += newArticlesCount;
    newArticlesCount = 0;
  } catch (err) {
    console.error('❌ Error syncing to gold-data-vault:', err.message);
  } finally {
    isSyncing = false;
  }
}

// Storage Helper
function storeArticle(sourceSlug, article) {
  const hash = crypto.createHash('sha256').update(article.url || article.id).digest('hex');
  if (registry[hash]) {
    return false;
  }

  let dateObj = new Date();
  if (article.published_at) {
    const parsed = new Date(article.published_at);
    if (!isNaN(parsed.getTime())) dateObj = parsed;
  }

  const yyyy = dateObj.getUTCFullYear().toString();
  const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getUTCDate()).padStart(2, '0');

  const dir = path.join(VAULT_DIR, 'Data', sourceSlug, yyyy, mm);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${dd}.json`);
  let dayArticles = [];
  if (fs.existsSync(filePath)) {
    try {
      dayArticles = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      dayArticles = [];
    }
  }

  article.id = hash;
  article.scraped_at = new Date().toISOString();
  dayArticles.push(article);
  fs.writeFileSync(filePath, JSON.stringify(dayArticles, null, 2), 'utf8');

  registry[hash] = {
    title: article.title,
    date: `${yyyy}-${mm}-${dd}`,
    source: sourceSlug
  };
  newArticlesCount++;

  if (newArticlesCount >= BATCH_SYNC_THRESHOLD) {
    syncVault(false);
  }

  return true;
}

// -------------------------------------------------------------
// SITEMAP & DEEP ARCHIVE HARVESTING
// -------------------------------------------------------------

// 1. Kitco Sitemaps Harvester (64,000+ Articles)
async function harvestKitcoSitemaps() {
  const items = [];
  const sitemaps = [
    'https://www.kitco.com/static-sitemaps/news.xml',
    'https://www.kitco.com/static-sitemaps/opinions.xml',
    'https://www.kitco.com/static-sitemaps/off-the-wire.xml'
  ];

  console.log('📜 [Harvester] Ingesting Kitco XML Sitemaps (64,000+ candidate articles)...');
  for (const sm of sitemaps) {
    try {
      const xml = await fetchPage(sm);
      const matches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
      let count = 0;
      for (const m of matches) {
        const u = m.replace(/<\/?loc>/g, '').trim();
        const hash = crypto.createHash('sha256').update(u).digest('hex');
        if (!registry[hash]) {
          items.push({ url: u, sourceSlug: 'Kitco_News' });
          count++;
        }
      }
      console.log(`  ✓ Ingested ${matches.length} total URLs from ${path.basename(sm)} (${count} new)`);
    } catch (e) {
      console.warn(`[Kitco Sitemap Error]: ${sm}: ${e.message}`);
    }
  }

  // Also include live news hubs
  const liveHubs = [
    'https://www.kitco.com/news',
    'https://www.kitco.com/news/category/commodities/gold',
    'https://www.kitco.com/news/category/mining'
  ];
  for (const hub of liveHubs) {
    try {
      const html = await fetchPage(hub);
      const $ = cheerio.load(html);
      $('a[href*="/news/article/"]').each((_, el) => {
        let href = $(el).attr('href');
        if (href) {
          if (href.startsWith('/')) href = 'https://www.kitco.com' + href;
          href = href.split('?')[0].split('#')[0];
          const hash = crypto.createHash('sha256').update(href).digest('hex');
          if (!registry[hash]) {
            items.push({ url: href, sourceSlug: 'Kitco_News' });
          }
        }
      });
    } catch (e) {}
  }
  return items;
}

// 2. BullionVault Deep Archives Harvester (30 Months, 2024-2026)
async function harvestBullionVaultArchives() {
  const items = [];
  const archiveHubs = new Set([
    'https://www.bullionvault.com/gold-news/',
    'https://www.bullionvault.com/gold-news/gold-price-news',
    'https://www.bullionvault.com/gold-news/market-fundamentals',
    'https://www.bullionvault.com/gold-news/opinion-analysis',
    'https://www.bullionvault.com/gold-news/news'
  ]);

  try {
    const archHtml = await fetchPage('https://www.bullionvault.com/gold-news/archive');
    const matches = archHtml.match(/https:\/\/www\.bullionvault\.com\/gold-news\/archive\/[0-9]+/g) || [];
    for (const m of matches) archiveHubs.add(m);
  } catch (e) {
    console.warn(`[BullionVault Archive List Error]: ${e.message}`);
  }

  console.log(`🏛️ [Harvester] Scanning ${archiveHubs.size} BullionVault monthly archives & categories...`);
  for (const hub of archiveHubs) {
    try {
      const html = await fetchPage(hub);
      const $ = cheerio.load(html);
      $('a[href*="/gold-news/"]').each((_, el) => {
        let href = $(el).attr('href');
        if (href) {
          if (href.startsWith('/')) href = 'https://www.bullionvault.com' + href;
          href = href.split('?')[0].split('#')[0];
          if (!href.endsWith('/gold-news') && !href.endsWith('/gold-news/') && !href.includes('/archive') && !href.endsWith('/gold-price-news') && !href.endsWith('/opinion-analysis') && !href.endsWith('/market-fundamentals') && !href.endsWith('/infographics') && !href.endsWith('/news') && !href.endsWith('/history') && !href.endsWith('/gold_books')) {
            const hash = crypto.createHash('sha256').update(href).digest('hex');
            if (!registry[hash]) {
              items.push({ url: href, sourceSlug: 'BullionVault' });
            }
          }
        }
      });
    } catch (e) {}
  }
  return items;
}

// 3. Economic Times Deep Commodities Pagination Harvester (Pages 1-100)
async function harvestEconomicTimes() {
  const items = [];
  console.log('📈 [Harvester] Ingesting Economic Times Commodities News (Pages 1–100)...');
  
  const pages = [
    'https://economictimes.indiatimes.com/markets/commodities/news',
    'https://economictimes.indiatimes.com/markets/commodities/gold-rate'
  ];
  for (let p = 2; p <= 100; p++) {
    pages.push(`https://economictimes.indiatimes.com/markets/commodities/news/articlelist/msid-50991753,page-${p}.cms`);
  }

  // Crawl pages concurrently in chunks of 10
  for (let i = 0; i < pages.length; i += 10) {
    const chunk = pages.slice(i, i + 10);
    await Promise.all(chunk.map(async (pageUrl) => {
      try {
        const html = await fetchPage(pageUrl);
        const $ = cheerio.load(html);
        $('a[href*="/articleshow/"]').each((_, el) => {
          let href = $(el).attr('href');
          const text = $(el).text().toLowerCase();
          if (href) {
            if (href.startsWith('/')) href = 'https://economictimes.indiatimes.com' + href;
            href = href.split('?')[0].split('#')[0];
            if (/gold|silver|bullion|precious|mcx/.test(href.toLowerCase()) || /gold|silver|bullion|precious|mcx/.test(text)) {
              const hash = crypto.createHash('sha256').update(href).digest('hex');
              if (!registry[hash]) {
                items.push({ url: href, sourceSlug: 'Economic_Times_Gold' });
              }
            }
          }
        });
      } catch (e) {}
    }));
  }
  return items;
}

// 4. GoldSeek Harvester
async function harvestGoldSeek() {
  const items = [];
  try {
    const html = await fetchPage('http://news.goldseek.com/');
    const matches = html.match(/http:\/\/news\.goldseek\.com\/[^"]*\.php/g) || [];
    for (const u of matches) {
      const hash = crypto.createHash('sha256').update(u).digest('hex');
      if (!registry[hash]) {
        items.push({ url: u, sourceSlug: 'GoldSeek' });
      }
    }
  } catch (e) {}
  return items;
}

// 5. Business Standard Harvester
async function harvestBusinessStandard() {
  const items = [];
  const hubs = [
    'https://www.business-standard.com/markets/commodities',
    'https://www.business-standard.com/markets/news'
  ];
  for (const hub of hubs) {
    try {
      const html = await fetchPage(hub);
      const $ = cheerio.load(html);
      $('a[href*=".html"]').each((_, el) => {
        let href = $(el).attr('href');
        const text = $(el).text().toLowerCase();
        if (href) {
          if (href.startsWith('/')) href = 'https://www.business-standard.com' + href;
          href = href.split('?')[0].split('#')[0];
          if (/gold|silver|bullion|precious/.test(href.toLowerCase()) || /gold|silver|bullion|precious/.test(text)) {
            const hash = crypto.createHash('sha256').update(href).digest('hex');
            if (!registry[hash]) {
              items.push({ url: href, sourceSlug: 'Business_Standard_Gold' });
            }
          }
        }
      });
    } catch (e) {}
  }
  return items;
}

// 6. GoodReturns Spot Rates Harvester
async function harvestGoodReturns() {
  const items = [];
  const pages = [
    'https://www.goodreturns.in/gold-rates/',
    'https://www.goodreturns.in/gold-rates/delhi.html',
    'https://www.goodreturns.in/gold-rates/mumbai.html',
    'https://www.goodreturns.in/gold-rates/chennai.html',
    'https://www.goodreturns.in/gold-rates/bangalore.html',
    'https://www.goodreturns.in/gold-rates/kolkata.html',
    'https://www.goodreturns.in/gold-rates/hyderabad.html',
    'https://www.goodreturns.in/gold-rates/ahmedabad.html'
  ];
  for (const page of pages) {
    items.push({ url: page, sourceSlug: 'GoodReturns_Gold' });
  }
  return items;
}

// -------------------------------------------------------------
// DEDICATED PARSERS
// -------------------------------------------------------------

function parseKitco(html, url) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim();
  if (!title) return null;

  $('script, style, nav, footer, header, .promowidget').remove();
  const paragraphs = [];
  $('article p, div[class*="article-body"] p, div[class*="content"] p, main p').each((_, p) => {
    const txt = $(p).text().replace(/\s+/g, ' ').trim();
    if (txt.length > 25 && !txt.includes('Kitco NEWS has a diverse team of journalists')) {
      paragraphs.push(txt);
    }
  });

  if (paragraphs.length === 0) return null;

  const match = url.match(/\/news\/article\/(\d{4}-\d{2}-\d{2})\//);
  let pubDate = match ? match[1] : null;

  return {
    title,
    url,
    source: 'Kitco News',
    category: 'Gold / Commodities',
    published_at: pubDate,
    content: paragraphs.join('\n\n'),
    word_count: paragraphs.join(' ').split(/\s+/).length,
    tags: ['Gold', 'Kitco', 'Precious Metals', 'Commodities']
  };
}

function parseBullionVault(html, url) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim();
  if (!title || title.toLowerCase() === 'gold price news') return null;

  const dateStr = $('.submitted').first().text().trim();
  $('script, style, nav, footer, header').remove();

  const paragraphs = [];
  $('.content p, article p, .node-article p').each((_, p) => {
    const txt = $(p).text().replace(/\s+/g, ' ').trim();
    if (txt.length > 25 && !txt.includes('All rights reserved')) {
      paragraphs.push(txt);
    }
  });

  if (paragraphs.length === 0) return null;

  return {
    title,
    url,
    source: 'BullionVault',
    category: 'Physical Gold / London Bullion',
    published_at: dateStr || null,
    content: paragraphs.join('\n\n'),
    word_count: paragraphs.join(' ').split(/\s+/).length,
    tags: ['Gold', 'BullionVault', 'LBMA', 'Bullion']
  };
}

function parseEconomicTimes(html, url) {
  const $ = cheerio.load(html);
  const title = $('h1.artTitle, h1').first().text().trim();
  if (!title) return null;

  $('.artText').find('script, style, .promowidget, .embed_code, .stock_widget, table').remove();
  const content = $('.artText').text().replace(/\s+/g, ' ').trim();
  if (content.length < 50) return null;

  const dateStr = $('.dt_block, .publish_date, time').first().text().trim();

  return {
    title,
    url,
    source: 'The Economic Times (Gold)',
    category: 'Domestic & MCX Gold',
    published_at: dateStr || null,
    content,
    word_count: content.split(/\s+/).length,
    tags: ['Gold', 'Economic Times', 'MCX', 'India Gold Rates']
  };
}

function parseGoldSeek(html, url) {
  const $ = cheerio.load(html);
  const title = $('h1, title').first().text().replace(/\s+/g, ' ').trim();
  if (!title) return null;

  $('script, style, nav, footer, header').remove();
  const paragraphs = [];
  $('p, td.main').each((_, p) => {
    const txt = $(p).text().replace(/\s+/g, ' ').trim();
    if (txt.length > 30 && !txt.includes('disclaimer') && !txt.includes('Copyright')) {
      paragraphs.push(txt);
    }
  });

  if (paragraphs.length === 0) return null;

  return {
    title,
    url,
    source: 'GoldSeek',
    category: 'Precious Metals Commentary',
    published_at: null,
    content: paragraphs.join('\n\n'),
    word_count: paragraphs.join(' ').split(/\s+/).length,
    tags: ['Gold', 'GoldSeek', 'Bullion']
  };
}

function parseBusinessStandard(html, url) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim();
  if (!title) return null;

  const dateStr = $('div[data-updatedtime]').attr('data-updatedtime') || $('.meta-info').first().text().trim();
  $('script, style, nav, footer, header').remove();

  const paragraphs = [];
  $('.storydetail p, article p').each((_, p) => {
    const txt = $(p).text().replace(/\s+/g, ' ').trim();
    if (txt.length > 25 && !txt.includes('First Published:')) {
      paragraphs.push(txt);
    }
  });

  if (paragraphs.length === 0) return null;

  return {
    title,
    url,
    source: 'Business Standard (Gold)',
    category: 'Commodities & Gold Markets',
    published_at: dateStr || null,
    content: paragraphs.join('\n\n'),
    word_count: paragraphs.join(' ').split(/\s+/).length,
    tags: ['Gold', 'Business Standard', 'Bullion', 'MCX']
  };
}

function parseGoodReturns(html, url) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim() || 'Gold Rate Today in India';

  const cityRates = [];
  $('table tr').each((_, tr) => {
    const tds = $(tr).find('td').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
    if (tds.length >= 3 && tds[0] && (tds[1].includes('₹') || tds[1].replace(/[^0-9]/g, '').length >= 4)) {
      cityRates.push({
        city_or_unit: tds[0],
        rate_22k: tds[1],
        rate_24k: tds[2] || tds[1]
      });
    }
  });

  if (cityRates.length === 0) return null;

  const todayStr = new Date().toISOString().split('T')[0];
  const pageSlug = url.split('/').pop().replace('.html', '') || 'india';

  return {
    id: `goodreturns-gold-rate-${pageSlug}-${todayStr}`,
    url: `${url}#${todayStr}`,
    title: `${title} - ${pageSlug.toUpperCase()} (${todayStr})`,
    source: 'GoodReturns (Gold Rates)',
    category: 'India Spot 24K & 22K Rates',
    published_at: todayStr,
    rates_data: cityRates,
    content: `Official domestic gold rates for ${pageSlug.toUpperCase()} on ${todayStr}. Rates: ${cityRates.map(r => `${r.city_or_unit}: 22K=${r.rate_22k}, 24K=${r.rate_24k}`).join('; ')}`,
    tags: ['India Gold Rates', '24K Gold', '22K Gold', 'GoodReturns']
  };
}

// -------------------------------------------------------------
// HIGH-SPEED 24-WORKER CONCURRENT INGESTION ENGINE
// -------------------------------------------------------------

async function processQueue(queue) {
  const total = queue.length;
  console.log(`\n🚀 Launching 24-Worker Parallel Extraction Engine for ${total} URLs...`);

  let processedCount = 0;
  let successCount = 0;
  const startTime = Date.now();

  async function worker(workerId) {
    while (queue.length > 0 && !isShuttingDown) {
      const item = queue.shift();
      if (!item) break;

      const hash = crypto.createHash('sha256').update(item.url).digest('hex');
      if (registry[hash]) continue;

      try {
        const html = await fetchPage(item.url);
        let article = null;

        if (item.sourceSlug === 'Kitco_News') {
          article = parseKitco(html, item.url);
        } else if (item.sourceSlug === 'BullionVault') {
          article = parseBullionVault(html, item.url);
        } else if (item.sourceSlug === 'Economic_Times_Gold') {
          article = parseEconomicTimes(html, item.url);
        } else if (item.sourceSlug === 'GoldSeek') {
          article = parseGoldSeek(html, item.url);
        } else if (item.sourceSlug === 'Business_Standard_Gold') {
          article = parseBusinessStandard(html, item.url);
        } else if (item.sourceSlug === 'GoodReturns_Gold') {
          article = parseGoodReturns(html, item.url);
        }

        if (article) {
          if (storeArticle(item.sourceSlug, article)) {
            successCount++;
            if (successCount % 50 === 0) {
              const rate = (successCount / ((Date.now() - startTime) / 60000)).toFixed(1);
              console.log(`  ⚡ Ingested: ${successCount} articles | Speed: ${rate} articles/min | Remaining: ${queue.length}`);
            }
          }
        }
      } catch (err) {
        // Skip individual failure
      }

      processedCount++;
      // High-throughput polite delay: 40ms per worker
      await sleep(40);
    }
  }

  // Launch 24 concurrent workers
  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const durationMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`🏁 Queue Drained: Ingested ${successCount} items in ${durationMin} min!`);
}

// -------------------------------------------------------------
// RELAY DISPATCH & SHUTDOWN
// -------------------------------------------------------------

async function triggerNextRelay() {
  if (nextRelayTriggered) return;
  nextRelayTriggered = true;
  console.log('🚀 Triggering next GitHub Actions 5.5-hour relay...');

  if (!VAULT_PAT) {
    console.log('ℹ️ Local mode: Next relay dispatch simulated.');
    return;
  }

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/parshant65-lang/gold-market-engine/actions/workflows/gold_scraper.yml/dispatches',
      method: 'POST',
      headers: {
        'User-Agent': 'GoldEngine-Relay/1.0',
        'Authorization': `Bearer ${VAULT_PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    }, (res) => {
      console.log(`GitHub API dispatch response code: ${res.statusCode}`);
      resolve();
    });

    req.on('error', (e) => {
      console.error('Failed to dispatch next relay:', e.message);
      resolve();
    });

    req.write(JSON.stringify({ ref: 'main' }));
    req.end();
  });
}

async function handleShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 Received ${signal || 'shutdown signal'}. Commencing final vault sync & termination...`);
  syncVault(true);
  console.log('🏁 Graceful shutdown complete. Process exiting.');
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// -------------------------------------------------------------
// MAIN AUTONOMOUS PIPELINE
// -------------------------------------------------------------

async function main() {
  console.log('========================================================================');
  console.log(`🏆 1 Lakh/24h Gold Intelligence Pipeline Starting (${CONCURRENCY} Parallel Streams)...`);
  console.log(`🕒 Start Time: ${new Date().toISOString()}`);
  console.log('========================================================================');

  initVault();

  // Periodic vault sync every 5 minutes
  const syncTimer = setInterval(() => {
    syncVault(false);
  }, SYNC_INTERVAL_MS);

  while (!isShuttingDown) {
    const elapsed = Date.now() - START_TIME;

    if (elapsed >= HANDOVER_TRIGGER_MS && !nextRelayTriggered) {
      await triggerNextRelay();
    }

    if (elapsed >= RUN_DURATION_MS) {
      console.log('⏰ 5.5 Hours target duration reached. Handing over to next relay.');
      break;
    }

    try {
      console.log('\n🕷️ Ingesting full universe of Gold archives, sitemaps, and feeds...');
      const queue = [];

      const [kitcoItems, bvItems, etItems, gsItems, bsItems, grItems] = await Promise.all([
        harvestKitcoSitemaps(),
        harvestBullionVaultArchives(),
        harvestEconomicTimes(),
        harvestGoldSeek(),
        harvestBusinessStandard(),
        harvestGoodReturns()
      ]);

      const seen = new Set();
      for (const item of [...kitcoItems, ...bvItems, ...etItems, ...gsItems, ...bsItems, ...grItems]) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          queue.push(item);
        }
      }

      console.log(`🎯 Harvester ready! Total unvisited URLs in queue: ${queue.length}`);

      if (queue.length > 0) {
        await processQueue(queue);
        syncVault(false);
      } else {
        console.log('ℹ️ All sources are up-to-date.');
      }
    } catch (err) {
      console.error('❌ Cycle error:', err.message);
    }

    console.log(`💤 Sleeping 3 minutes before next discovery sweep... (Elapsed: ${Math.round(elapsed / 60000)}m / 330m)`);
    await sleep(3 * 60 * 1000);
  }

  clearInterval(syncTimer);
  await handleShutdown('Relay Complete');
}

main().catch(err => {
  console.error('Fatal runner error:', err);
  handleShutdown('Fatal Error');
});
