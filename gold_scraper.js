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

const RUN_DURATION_MS = 5.5 * 60 * 60 * 1000; // 5.5 hours
const HANDOVER_TRIGGER_MS = 5 * 60 * 60 * 1000 + 20 * 60 * 1000; // 5h 20m
const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const START_TIME = Date.now();

let isShuttingDown = false;
let nextRelayTriggered = false;
let registry = {};
let newArticlesCount = 0;

// User-Agent pool
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// HTTP Fetch Helper with automatic redirect and retry
function fetchPage(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error(`Too many redirects for ${url}`));
    
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.get(url, {
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
    console.warn('⚠️ VAULT_PAT not set! Running in local testing mode (no remote sync).');
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

  // Ensure git identity
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
  if (newArticlesCount === 0 && !force) {
    console.log('ℹ️ No new articles since last sync. Skipping vault push.');
    return;
  }

  try {
    saveRegistry();
    console.log(`📤 Syncing ${newArticlesCount} new articles to gold-data-vault...`);
    execSync(`cd "${VAULT_DIR}" && git add -A`);
    const status = execSync(`cd "${VAULT_DIR}" && git status --porcelain`).toString().trim();
    if (!status) {
      console.log('ℹ️ Working tree clean, nothing to commit.');
      return;
    }

    const timestamp = new Date().toISOString();
    execSync(`cd "${VAULT_DIR}" && git commit -m "Ingest gold intelligence: +${newArticlesCount} items [${timestamp}]"`);
    execSync(`cd "${VAULT_DIR}" && git push origin main`, { stdio: 'inherit' });
    console.log(`✅ Successfully synced +${newArticlesCount} items to gold-data-vault!`);
    newArticlesCount = 0;
  } catch (err) {
    console.error('❌ Error syncing to gold-data-vault:', err.message);
  }
}

// Storage Helper: Saves an article into Data/[Source]/[YYYY]/[MM]/[DD].json
function storeArticle(sourceSlug, article) {
  const hash = crypto.createHash('sha256').update(article.url || article.id).digest('hex');
  if (registry[hash]) {
    return false; // Already stored
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
  return true;
}

// -------------------------------------------------------------
// SOURCE 1: Kitco News Scraper
// -------------------------------------------------------------
async function scrapeKitco() {
  console.log('🔍 [Kitco News] Scanning latest gold articles...');
  const hubs = [
    'https://www.kitco.com/news',
    'https://www.kitco.com/news/category/commodities/gold',
    'https://www.kitco.com/news/category/mining'
  ];

  const articleUrls = new Set();
  for (const hub of hubs) {
    try {
      const html = await fetchPage(hub);
      const $ = cheerio.load(html);
      $('a[href*="/news/article/"]').each((_, el) => {
        let href = $(el).attr('href');
        if (href) {
          if (href.startsWith('/')) href = 'https://www.kitco.com' + href;
          // Filter out hash or query params
          href = href.split('?')[0].split('#')[0];
          articleUrls.add(href);
        }
      });
      await sleep(1000);
    } catch (err) {
      console.warn(`[Kitco] Hub scan error (${hub}):`, err.message);
    }
  }

  console.log(`[Kitco] Discovered ${articleUrls.size} candidate article URLs.`);
  let count = 0;
  for (const url of articleUrls) {
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    if (registry[hash]) continue;

    try {
      await sleep(600);
      const artHtml = await fetchPage(url);
      const $ = cheerio.load(artHtml);
      const title = $('h1').first().text().trim();
      if (!title) continue;

      $('script, style, nav, footer, header, .promowidget').remove();
      const paragraphs = [];
      $('article p, div[class*="article-body"] p, div[class*="content"] p, main p').each((_, p) => {
        const txt = $(p).text().replace(/\s+/g, ' ').trim();
        if (txt.length > 25 && !txt.includes('Kitco NEWS has a diverse team of journalists')) {
          paragraphs.push(txt);
        }
      });

      if (paragraphs.length === 0) continue;

      // Extract publication date from URL if available (/news/article/YYYY-MM-DD/...)
      const match = url.match(/\/news\/article\/(\d{4}-\d{2}-\d{2})\//);
      let pubDate = match ? match[1] : null;

      const article = {
        title,
        url,
        source: 'Kitco News',
        category: 'Gold / Commodities',
        published_at: pubDate,
        content: paragraphs.join('\n\n'),
        word_count: paragraphs.join(' ').split(/\s+/).length,
        tags: ['Gold', 'Kitco', 'Precious Metals', 'Commodities']
      };

      if (storeArticle('Kitco_News', article)) {
        count++;
        console.log(`  ✨ [Kitco] Saved: "${title.slice(0, 60)}..."`);
      }
    } catch (err) {
      console.warn(`[Kitco] Error scraping ${url}:`, err.message);
    }
  }
  console.log(`[Kitco News] Finished cycle. Ingested ${count} new articles.`);
}

// -------------------------------------------------------------
// SOURCE 2: BullionVault Scraper
// -------------------------------------------------------------
async function scrapeBullionVault() {
  console.log('🔍 [BullionVault] Scanning gold news and market insights...');
  const hubs = [
    'https://www.bullionvault.com/gold-news/',
    'https://www.bullionvault.com/gold-news/gold-price-news',
    'https://www.bullionvault.com/gold-news/market-fundamentals',
    'https://www.bullionvault.com/gold-news/opinion-analysis'
  ];

  const articleUrls = new Set();
  for (const hub of hubs) {
    try {
      const html = await fetchPage(hub);
      const $ = cheerio.load(html);
      $('a[href*="/gold-news/"]').each((_, el) => {
        let href = $(el).attr('href');
        if (href) {
          if (href.startsWith('/')) href = 'https://www.bullionvault.com' + href;
          href = href.split('?')[0].split('#')[0];
          // Filter out landing categories
          if (!href.endsWith('/gold-news/') && !href.endsWith('/gold-price-news') && !href.endsWith('/opinion-analysis') && !href.endsWith('/market-fundamentals') && !href.endsWith('/infographics')) {
            articleUrls.add(href);
          }
        }
      });
      await sleep(1000);
    } catch (err) {
      console.warn(`[BullionVault] Hub scan error (${hub}):`, err.message);
    }
  }

  console.log(`[BullionVault] Discovered ${articleUrls.size} candidate article URLs.`);
  let count = 0;
  for (const url of articleUrls) {
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    if (registry[hash]) continue;

    try {
      await sleep(600);
      const artHtml = await fetchPage(url);
      const $ = cheerio.load(artHtml);
      const title = $('h1').first().text().trim();
      if (!title || title.toLowerCase() === 'gold price news') continue;

      const dateStr = $('.submitted').first().text().trim();
      $('script, style, nav, footer, header').remove();

      const paragraphs = [];
      $('.content p, article p, .node-article p').each((_, p) => {
        const txt = $(p).text().replace(/\s+/g, ' ').trim();
        if (txt.length > 25 && !txt.includes('All rights reserved')) {
          paragraphs.push(txt);
        }
      });

      if (paragraphs.length === 0) continue;

      const article = {
        title,
        url,
        source: 'BullionVault',
        category: 'Physical Gold / London Bullion',
        published_at: dateStr || null,
        content: paragraphs.join('\n\n'),
        word_count: paragraphs.join(' ').split(/\s+/).length,
        tags: ['Gold', 'BullionVault', 'LBMA', 'Bullion']
      };

      if (storeArticle('BullionVault', article)) {
        count++;
        console.log(`  ✨ [BullionVault] Saved: "${title.slice(0, 60)}..."`);
      }
    } catch (err) {
      console.warn(`[BullionVault] Error scraping ${url}:`, err.message);
    }
  }
  console.log(`[BullionVault] Finished cycle. Ingested ${count} new articles.`);
}

// -------------------------------------------------------------
// SOURCE 3: Economic Times (Gold & Precious Metals)
// -------------------------------------------------------------
async function scrapeEconomicTimes() {
  console.log('🔍 [Economic Times] Scanning commodities gold articles...');
  const hub = 'https://economictimes.indiatimes.com/markets/commodities/news';
  const articleUrls = new Set();

  try {
    const html = await fetchPage(hub);
    const $ = cheerio.load(html);
    $('a[href*="/articleshow/"]').each((_, el) => {
      let href = $(el).attr('href');
      const text = $(el).text().toLowerCase();
      if (href) {
        if (href.startsWith('/')) href = 'https://economictimes.indiatimes.com' + href;
        href = href.split('?')[0].split('#')[0];
        // Focus strictly on Gold & Precious metals / MCX
        if (/gold|silver|bullion|precious|mcx/.test(href.toLowerCase()) || /gold|silver|bullion|precious/.test(text)) {
          articleUrls.add(href);
        }
      }
    });
  } catch (err) {
    console.warn('[Economic Times] Hub scan error:', err.message);
  }

  console.log(`[Economic Times] Discovered ${articleUrls.size} candidate Gold articles.`);
  let count = 0;
  for (const url of articleUrls) {
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    if (registry[hash]) continue;

    try {
      await sleep(600);
      const artHtml = await fetchPage(url);
      const $ = cheerio.load(artHtml);
      const title = $('h1.artTitle, h1').first().text().trim();
      if (!title) continue;

      $('.artText').find('script, style, .promowidget, .embed_code, .stock_widget, table').remove();
      const content = $('.artText').text().replace(/\s+/g, ' ').trim();
      if (content.length < 50) continue;

      const dateStr = $('.dt_block, .publish_date, time').first().text().trim();

      const article = {
        title,
        url,
        source: 'The Economic Times (Gold)',
        category: 'Domestic & MCX Gold',
        published_at: dateStr || null,
        content,
        word_count: content.split(/\s+/).length,
        tags: ['Gold', 'Economic Times', 'MCX', 'India Gold Rates']
      };

      if (storeArticle('Economic_Times_Gold', article)) {
        count++;
        console.log(`  ✨ [Economic Times] Saved: "${title.slice(0, 60)}..."`);
      }
    } catch (err) {
      console.warn(`[Economic Times] Error scraping ${url}:`, err.message);
    }
  }
  console.log(`[Economic Times] Finished cycle. Ingested ${count} new articles.`);
}

// -------------------------------------------------------------
// SOURCE 4: Business Standard (Commodities & Gold)
// -------------------------------------------------------------
async function scrapeBusinessStandard() {
  console.log('🔍 [Business Standard] Scanning commodities gold articles...');
  const hub = 'https://www.business-standard.com/markets/commodities';
  const articleUrls = new Set();

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
          articleUrls.add(href);
        }
      }
    });
  } catch (err) {
    console.warn('[Business Standard] Hub scan error:', err.message);
  }

  console.log(`[Business Standard] Discovered ${articleUrls.size} candidate Gold articles.`);
  let count = 0;
  for (const url of articleUrls) {
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    if (registry[hash]) continue;

    try {
      await sleep(600);
      const artHtml = await fetchPage(url);
      const $ = cheerio.load(artHtml);
      const title = $('h1').first().text().trim();
      if (!title) continue;

      const dateStr = $('div[data-updatedtime]').attr('data-updatedtime') || $('.meta-info').first().text().trim();
      $('script, style, nav, footer, header').remove();

      const paragraphs = [];
      $('.storydetail p, article p').each((_, p) => {
        const txt = $(p).text().replace(/\s+/g, ' ').trim();
        if (txt.length > 25 && !txt.includes('First Published:')) {
          paragraphs.push(txt);
        }
      });

      if (paragraphs.length === 0) continue;

      const article = {
        title,
        url,
        source: 'Business Standard (Gold)',
        category: 'Commodities & Gold Markets',
        published_at: dateStr || null,
        content: paragraphs.join('\n\n'),
        word_count: paragraphs.join(' ').split(/\s+/).length,
        tags: ['Gold', 'Business Standard', 'Bullion', 'MCX']
      };

      if (storeArticle('Business_Standard_Gold', article)) {
        count++;
        console.log(`  ✨ [Business Standard] Saved: "${title.slice(0, 60)}..."`);
      }
    } catch (err) {
      console.warn(`[Business Standard] Error scraping ${url}:`, err.message);
    }
  }
  console.log(`[Business Standard] Finished cycle. Ingested ${count} new articles.`);
}

// -------------------------------------------------------------
// SOURCE 5: GoodReturns India Spot Rates & Gold Insights
// -------------------------------------------------------------
async function scrapeGoodReturns() {
  console.log('🔍 [GoodReturns] Scanning India city-wise daily gold rates...');
  const url = 'https://www.goodreturns.in/gold-rates/';
  try {
    const html = await fetchPage(url);
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

    if (cityRates.length > 0) {
      const todayStr = new Date().toISOString().split('T')[0];
      const rateArticle = {
        id: `goodreturns-gold-rate-${todayStr}`,
        url: `${url}#${todayStr}`,
        title: `${title} (${todayStr})`,
        source: 'GoodReturns (Gold Rates)',
        category: 'India Spot 24K & 22K Rates',
        published_at: todayStr,
        rates_data: cityRates,
        content: `Official domestic gold rates snapshot for ${todayStr}. Included cities and slabs: ${cityRates.map(r => `${r.city_or_unit}: 22K=${r.rate_22k}, 24K=${r.rate_24k}`).join('; ')}`,
        tags: ['India Gold Rates', '24K Gold', '22K Gold', 'GoodReturns']
      };

      if (storeArticle('GoodReturns_Gold', rateArticle)) {
        console.log(`  ✨ [GoodReturns] Recorded daily domestic rates snapshot (${cityRates.length} city/weight slabs).`);
      }
    }
  } catch (err) {
    console.warn('[GoodReturns] Scraping error:', err.message);
  }
}

// -------------------------------------------------------------
// Autonomous Continuous Relay & GitHub API Trigger
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
  console.log(`\n🛑 Received ${signal || 'shutdown signal'}. Commencing graceful sync & termination...`);
  syncVault(true);
  console.log('🏁 Graceful shutdown complete. Process exiting.');
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// -------------------------------------------------------------
// Main Autonomous Loop
// -------------------------------------------------------------
async function main() {
  console.log('====================================================');
  console.log('🏆 24x7 Gold & Bullion Scraping Pipeline Starting...');
  console.log(`🕒 Start Time: ${new Date().toISOString()}`);
  console.log('====================================================');

  initVault();

  // Periodic vault sync every 15 minutes
  const syncTimer = setInterval(() => {
    syncVault(false);
  }, SYNC_INTERVAL_MS);

  while (!isShuttingDown) {
    const elapsed = Date.now() - START_TIME;

    // Check if handover time reached (5h 20m)
    if (elapsed >= HANDOVER_TRIGGER_MS && !nextRelayTriggered) {
      await triggerNextRelay();
    }

    // Check if full run duration reached (5.5 hours)
    if (elapsed >= RUN_DURATION_MS) {
      console.log('⏰ 5.5 Hours target duration reached. Handing over to next relay.');
      break;
    }

    try {
      await scrapeKitco();
      await scrapeBullionVault();
      await scrapeEconomicTimes();
      await scrapeBusinessStandard();
      await scrapeGoodReturns();
    } catch (err) {
      console.error('❌ Cycle error:', err.message);
    }

    console.log(`💤 Cycle completed. Sleeping 3 minutes before next discovery sweep... (Elapsed: ${Math.round(elapsed / 60000)}m / 330m)`);
    await sleep(3 * 60 * 1000);
  }

  clearInterval(syncTimer);
  await handleShutdown('Relay Complete');
}

main().catch(err => {
  console.error('Fatal runner error:', err);
  handleShutdown('Fatal Error');
});
