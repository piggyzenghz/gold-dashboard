require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const API_TOKEN = process.env.API_TOKEN || '';

const rateLimit = require('express-rate-limit');

app.set('trust proxy', 1); // Cloudflare 代理
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============ 安全中间件 ============

// 全局速率限制：每 IP 每分钟 120 次
app.use(rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, validate: { xForwardedForHeader: false } }));

// AI / ML / 研究 端点严格限流：每 IP 每分钟 5 次
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: '请求过于频繁，请稍后重试' }, validate: { xForwardedForHeader: false } });
app.use('/api/ai/', aiLimiter);
app.use('/api/ml/', aiLimiter);
app.use('/api/research/generate', aiLimiter);

// Bearer Token 认证：保护写入/删除/AI端点
function requireAuth(req, res, next) {
  if (!API_TOKEN) return next(); // 未配置 token 时跳过（本地开发）
  const auth = req.headers.authorization;
  if (auth === `Bearer ${API_TOKEN}`) return next();
  res.status(401).json({ error: '未授权访问' });
}
app.post('/api/config/:key', requireAuth);
app.post('/api/ai/*', requireAuth);
app.post('/api/ml/*', requireAuth);
app.post('/api/research/*', requireAuth);
app.delete('/api/research/*', requireAuth);
app.post('/api/daily-report/*', requireAuth);
app.post('/api/snapshot/*', requireAuth);

// ============ SQLite 数据层 (⑦缓存 + ⑧配置同步) ============
const Database = require('better-sqlite3');
const { execFile } = require('child_process');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'dashboard.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS market_snapshot (
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(date, type)
  );
`);

// 智能 TTL：交易时段用短缓存，非交易时段用长缓存
function getTTL(short, long) {
  long = long ?? short * 15;
  const now = new Date();
  const cstH = (now.getUTCHours() + 8) % 24;
  const cstMin = now.getUTCMinutes();
  const t = cstH * 100 + cstMin;
  const dow = new Date(now.getTime() + 8 * 3600000).getUTCDay();
  const isWeekday = dow >= 1 && dow <= 5;
  // A股 09:30-11:30 & 13:00-15:00；美股 22:30-翌日04:00
  const trading = isWeekday && ((t >= 930 && t <= 1130) || (t >= 1300 && t <= 1500) || t >= 2230 || t <= 400);
  return trading ? short : long;
}

const _cGet = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?');
const _cSet = db.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');
const _cDel = db.prepare('DELETE FROM cache WHERE key = ?');

function cacheGet(key) {
  const row = _cGet.get(key);
  if (!row) return null;
  if (Date.now() > row.expires_at) { _cDel.run(key); return null; }
  return JSON.parse(row.value);
}
function cacheSet(key, value, ttlSeconds) {
  _cSet.run(key, JSON.stringify(value), Date.now() + ttlSeconds * 1000);
}
async function withCache(key, ttlSeconds, fetchFn) {
  const cached = cacheGet(key);
  if (cached !== null) return cached;
  const data = await fetchFn();
  if (data != null) cacheSet(key, data, ttlSeconds);
  return data;
}

// A股交易时段判定
function cstNow() {
  const now = new Date();
  const h = (now.getUTCHours() + 8) % 24;
  const m = now.getUTCMinutes();
  const dow = new Date(now.getTime() + 8 * 3600000).getUTCDay();
  return { h, m, t: h * 100 + m, dow, isWeekday: dow >= 1 && dow <= 5 };
}
function isAStockOpen() {
  const { t, isWeekday } = cstNow();
  return isWeekday && ((t >= 925 && t <= 1135) || (t >= 1255 && t <= 1505));
}
// 是否在实际交易时段（不含午休）
function isAStockTrading() {
  const { t, isWeekday } = cstNow();
  return isWeekday && ((t >= 930 && t <= 1130) || (t >= 1300 && t <= 1500));
}
// 午休时段（工作日 11:31-12:59）
function isAStockLunchBreak() {
  const { t, isWeekday } = cstNow();
  return isWeekday && t >= 1131 && t <= 1259;
}
// 美股交易时段（CST 22:30-次日04:00，工作日）
function isUSMarketTrading() {
  const { t, isWeekday } = cstNow();
  return isWeekday && (t >= 2230 || t <= 400);
}
// 美股专用缓存：交易时段实时拉取，非交易时段读快照
async function usStockSwr(key, tradingTTL, fetchFn) {
  if (isUSMarketTrading()) {
    return withCache(key, tradingTTL, fetchFn);
  }
  // 非交易时段：优先读快照，其次读过期缓存
  const snapType = key.replace(/:/g, '_');
  const snap = snapshotLoad(snapType);
  if (snap) return snap;
  const { data } = cacheGetStale(key);
  if (data) return data;
  return fetchFn();
}

// stale-while-revalidate: 过期返回旧数据，同时标记需要刷新
function cacheGetStale(key) {
  const row = _cGet.get(key);
  if (!row) return { data: null, stale: false };
  const data = JSON.parse(row.value);
  const stale = Date.now() > row.expires_at;
  return { data, stale };
}
async function swr(key, ttlSeconds, fetchFn) {
  const { data, stale } = cacheGetStale(key);
  if (data !== null && !stale) return data;
  if (data !== null && stale) {
    fetchFn().then(fresh => { if (fresh != null) cacheSet(key, fresh, ttlSeconds); }).catch(() => {});
    return data;
  }
  const fresh = await fetchFn();
  if (fresh != null) cacheSet(key, fresh, ttlSeconds);
  return fresh;
}
// 快照持久化
const _snapGet = db.prepare('SELECT data FROM market_snapshot WHERE type = ? ORDER BY date DESC LIMIT 1');
const _snapGetDate = db.prepare('SELECT data FROM market_snapshot WHERE date = ? AND type = ?');
const _snapSet = db.prepare('INSERT OR REPLACE INTO market_snapshot (date, type, data, updated_at) VALUES (?, ?, ?, ?)');

function snapshotSave(date, type, data) {
  _snapSet.run(date, type, JSON.stringify(data), Date.now());
}
function snapshotLoad(type) {
  const row = _snapGet.get(type);
  return row ? JSON.parse(row.data) : null;
}
function getCSTDateStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().split('T')[0];
}

// A股专用缓存：三时段逻辑（交易/午休/非交易）
async function aStockSwr(key, tradingTTL, fetchFn) {
  // 交易时段：正常缓存+实时拉取
  if (isAStockTrading()) {
    return withCache(key, tradingTTL, fetchFn);
  }
  // 午休时段：返回缓存中上午的数据，不发外部请求
  if (isAStockLunchBreak()) {
    const cached = cacheGet(key);
    if (cached) return cached;
    const { data } = cacheGetStale(key);
    if (data) return data;
    // 午休但无缓存（刚重启），尝试从快照读
    const snap = snapshotLoad(key.replace(/:/g, '_'));
    if (snap) return snap;
    return fetchFn(); // 最后兜底
  }
  // 非交易时段：优先读快照，其次读过期缓存
  const snapType = key.replace(/:/g, '_');
  const snap = snapshotLoad(snapType);
  if (snap) return snap;
  const { data } = cacheGetStale(key);
  if (data) return data;
  return fetchFn(); // 完全无数据时兜底
}

// ============ Sina 行情公共工具 ============
const SINA_HEADERS = { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };

// 获取 Sina 简版行情（s_ 前缀指数），返回 { [code]: {name,price,change,changePercent,volume,turnover} }
async function fetchSinaSimple(codes) {
  const resp = await fetch(`https://hq.sinajs.cn/list=${codes}`, { headers: SINA_HEADERS });
  const text = new TextDecoder('gbk').decode(await resp.arrayBuffer());
  const results = {};
  for (const line of text.split('\n')) {
    const m = line.match(/var hq_str_(.+?)="(.+?)"/);
    if (!m) continue;
    const p = m[2].split(',');
    results[m[1]] = { name: p[0], price: parseFloat(p[1]), change: parseFloat(p[2]), changePercent: parseFloat(p[3]), volume: parseInt(p[4]) || 0, turnover: parseFloat(p[5]) || 0 };
  }
  return results;
}

// 获取 Sina 完整行情（sh/sz 前缀个股），返回数组
async function fetchSinaFull(sinaCodes) {
  const resp = await fetch(`https://hq.sinajs.cn/list=${sinaCodes}`, { headers: SINA_HEADERS });
  const text = new TextDecoder('gbk').decode(await resp.arrayBuffer());
  const results = [];
  for (const line of text.trim().split('\n')) {
    const m = line.match(/hq_str_(\w+)="(.+)"/);
    if (!m) continue;
    const code = m[1].replace(/^(sh|sz)/, '');
    const f = m[2].split(',');
    if (!f[3] || !parseFloat(f[3])) continue;
    const price = parseFloat(f[3]), prevClose = parseFloat(f[2]), change = price - prevClose;
    results.push({ code, name: f[0], price, prevClose, change, changePercent: prevClose > 0 ? (change / prevClose) * 100 : 0, open: parseFloat(f[1]), high: parseFloat(f[4]), low: parseFloat(f[5]), volume: Math.round(parseFloat(f[8]) / 100), amount: parseFloat(f[9]), time: f[31] || '' });
  }
  return results;
}

// ============ 配置同步 API (⑧多设备同步) ============
const CONFIG_ALLOWED_KEYS = new Set(['watchlist', 'usWatchlist', 'cryptoWatchlist', 'alerts', 'theme', 'settings']);

app.get('/api/config/:key', (req, res) => {
  if (!CONFIG_ALLOWED_KEYS.has(req.params.key)) return res.status(400).json({ error: 'invalid key' });
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(req.params.key);
  res.json({ value: row ? JSON.parse(row.value) : null });
});
app.post('/api/config/:key', (req, res) => {
  if (!CONFIG_ALLOWED_KEYS.has(req.params.key)) return res.status(400).json({ error: 'invalid key' });
  const { value } = req.body;
  db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)').run(
    req.params.key, JSON.stringify(value), Date.now()
  );
  res.json({ ok: true });
});

// ============ 黄金价格 ============

app.get('/api/gold', async (req, res) => {
  try {
    const data = await withCache('price:gold', getTTL(60), () =>
      fetch('https://api.gold-api.com/price/XAU').then(r => r.json())
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ Yahoo Finance 图表数据 ============

app.get('/api/chart/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const range = req.query.range || '1d';
    const interval = req.query.interval || '5m';

    const result = await yahooFinance.chart(symbol, {
      period1: getStartDate(range),
      interval: interval
    });

    // 转换为前端需要的格式
    const quotes = result.quotes || [];
    const timestamps = quotes.map(q => q.date);
    const closes = quotes.map(q => q.close);
    const meta = result.meta || {};

    res.json({
      chart: {
        result: [{
          timestamp: timestamps.map(d => Math.floor(new Date(d).getTime() / 1000)),
          indicators: { quote: [{ close: closes }] },
          meta: {
            chartPreviousClose: meta.chartPreviousClose || meta.previousClose,
            regularMarketPrice: meta.regularMarketPrice,
            currency: meta.currency,
            symbol: meta.symbol
          }
        }]
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getStartDate(range) {
  const now = new Date();
  const CST_OFFSET = 8 * 60 * 60 * 1000;

  // CST day index (integer days since epoch, in CST timezone)
  const nowCSTday = Math.floor((now.getTime() + CST_OFFSET) / 86400000);

  // CST midnight (as UTC Date) for a given CST day index
  function cstDayStart(d) { return new Date(d * 86400000 - CST_OFFSET); }

  // Day-of-week in CST for a given CST day index (0=Sun, 6=Sat)
  function cstDOW(d) { return new Date(d * 86400000).getUTCDay(); }

  // Find the most recent weekday on or before dayIdx
  function lastWeekday(d) {
    while (cstDOW(d) === 0 || cstDOW(d) === 6) d--;
    return d;
  }

  switch (range) {
    case '1d': {
      // 最近一个交易日(周一至周五)的 CST 00:00，周末自动退到上周五
      return cstDayStart(lastWeekday(nowCSTday));
    }
    case '5d': {
      // 往前数 5 个交易日(周一至周五)，取第 5 个交易日的 CST 00:00 为起点
      let count = 0, d = nowCSTday;
      while (count < 5) {
        d--;
        if (cstDOW(d) !== 0 && cstDOW(d) !== 6) count++;
      }
      return cstDayStart(d);
    }
    case '1mo': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case '3mo': return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    case '1y': return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    case '5y': return new Date(now.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
    default: return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}

// Yahoo Finance 批量报价
app.get('/api/quotes', async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').filter(Boolean);
    const cKey = `quotes:${symbols.sort().join(',')}`;
    const data = await withCache(cKey, getTTL(60), async () => {
      const results = await yahooFinance.quote(symbols);
      return { quoteResponse: { result: Array.isArray(results) ? results : [results] } };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 新浪 A股实时行情 ============

app.get('/api/sina', async (req, res) => {
  try {
    const codes = req.query.codes || 's_sh000001,s_sh000300';
    const cKey = `sina:${codes}`;
    const cached = cacheGet(cKey);
    if (cached) return res.json(cached);
    const results = await fetchSinaSimple(codes);
    cacheSet(cKey, results, getTTL(30));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 新闻 ============

app.get('/api/news', async (req, res) => {
  try {
    const category = req.query.category || 'finance';
    const cKey = `news:${category}`;
    const cached = cacheGet(cKey);
    if (cached) return res.json(cached);
    const lidMap = { finance: '2516', politics: '2509', world: '2514' };
    const lid = lidMap[category] || '2516';
    const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=${lid}&k=&num=30&page=1&r=${Math.random()}`;
    const resp = await fetch(url, {
      headers: {
        'Referer': 'https://news.sina.com.cn',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      }
    });
    const data = await resp.json();
    const articles = (data.result?.data || []).map(item => ({
      title: item.title,
      url: item.url,
      time: item.ctime,
      source: item.media_name || item.author || '',
      summary: item.summary || ''
    }));
    cacheSet(cKey, articles, 600); // 10分钟缓存
    res.json(articles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ A股新闻 (证券时报) ============

function parseStcnHtml(html) {
  const items = [];
  const seen = new Set();
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRegex.exec(html)) !== null) {
    const block = m[1];
    const linkMatch = /href="(\/article\/detail\/[^"]+)"[^>]*>\s*([^<]{5,120}?)\s*<\/a>/.exec(block);
    if (!linkMatch) continue;
    const url = 'https://www.stcn.com' + linkMatch[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const title = linkMatch[2].trim();
    const infoMatch = /<div class="info[^"]*">([\s\S]*?)<\/div>/.exec(block);
    const infoSpans = infoMatch ? [...infoMatch[1].matchAll(/<span[^>]*>([^<]+)<\/span>/g)].map(s => s[1].trim()) : [];
    const source = infoSpans[0] || '证券时报';
    const time = infoSpans[infoSpans.length - 1] || '';
    const summaryMatch = /<div class="text ellipsis-2">[\s\S]*?<a[^>]*>([^<]{10,}?)<\/a>/.exec(block);
    const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : '';
    items.push({ title, url, source, time, summary });
  }
  return items.slice(0, 20);
}

function parseSinaRoll(json, defaultSource = '新浪财经') {
  const items = [];
  const data = json?.result?.data;
  if (!Array.isArray(data)) return items;
  for (const item of data) {
    const title = (item.title || '').trim();
    const url = (item.url || item.link || '').trim();
    const source = item.media_name || defaultSource;
    const ct = item.create_time;
    const time = ct ? new Date(ct * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    if (title && url) items.push({ title, url, source, time });
  }
  return items;
}

async function fetchSinaRoll(lid, num = 25) {
  try {
    const resp = await fetch(
      `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=${lid}&num=${num}&page=1&r=${Math.random().toFixed(4)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }, signal: AbortSignal.timeout(8000) }
    );
    return parseSinaRoll(await resp.json());
  } catch(e) { return []; }
}

async function fetchEastMoneyKuaixun() {
  try {
    const resp = await fetch(
      'https://np-listapi.eastmoney.com/comm/web/getListInfo?client=web&type=1&mTypeAndCode=0%7C&pageSize=30&pageIndex=1',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.eastmoney.com/', 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) }
    );
    const json = await resp.json();
    const list = json?.data?.list || [];
    return list.map(item => ({
      title: (item.title || item.Title || '').trim(),
      url: item.url || item.ArtUrl || `https://finance.eastmoney.com/a/${item.id}.html`,
      source: item.mediaName || '东方财富',
      time: item.time || ''
    })).filter(a => a.title);
  } catch(e) { return []; }
}

app.get('/api/news/astock', async (req, res) => {
  try {
    const type = req.query.type || 'gs';
    const allowed = ['gs', 'kx', 'yw', 'wm'];
    const t = allowed.includes(type) ? type : 'gs';
    const cKey = `astock-news:${t}`;
    const cached = cacheGet(cKey);
    if (cached) return res.json(cached);

    const seen = new Set();
    const dedup = (arr) => arr.filter(a => {
      const key = (a.title || '').slice(0, 20);
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });

    let articles = [];

    if (t === 'wm') {
      // 外媒涉A股报道
      const wmSources = [
        { name: 'Reuters中国', url: 'https://feeds.reuters.com/reuters/CNbusinessNews' },
        { name: 'SCMP', url: 'https://www.scmp.com/rss/92/feed' },
        { name: 'Caixin', url: 'https://www.caixinglobal.com/rss/feed/' },
        { name: 'FT Asia', url: 'https://www.ft.com/rss/home/asia' },
      ];
      const results = await Promise.all(wmSources.map(s => fetchRSS(s.url, s.name)));
      let raw = results.flat();
      raw.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
      raw = dedup(raw).slice(0, 20);
      const translated = await translateTitles(raw.map(a => a.title));
      raw.forEach((a, i) => { a.titleZh = translated[i] || a.title; a.url = a.link || a.url || '#'; });
      cacheSet(cKey, raw, 600);
      return res.json(raw);
    }

    if (t === 'kx') {
      // 快讯：新浪财经7×24 + 东方财富快讯
      const [sinaItems, emItems] = await Promise.all([
        fetchSinaRoll('2516', 30),
        fetchEastMoneyKuaixun()
      ]);
      articles = dedup([...sinaItems, ...emItems]).slice(0, 40);
    } else {
      // gs/yw：证券时报 + 新浪财经（金融+产经双源）
      try {
        const resp = await fetch(`https://www.stcn.com/article/list.html?type=${t}&page=1`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Referer': `https://www.stcn.com/article/list/${t}.html`, 'X-Requested-With': 'XMLHttpRequest' },
          signal: AbortSignal.timeout(8000)
        });
        const json = await resp.json();
        articles = parseStcnHtml(json.data || '');
      } catch(e) { console.warn('[stcn]', t, e.message); }
      const sinaLids = t === 'yw' ? ['2513', '2514'] : ['2509', '2510'];
      const sinaResults = await Promise.all(sinaLids.map(lid => fetchSinaRoll(lid, 20)));
      articles = dedup([...articles, ...sinaResults.flat()]).slice(0, 30);
    }

    cacheSet(cKey, articles, t === 'kx' ? 180 : 300);
    res.json(articles);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 国际资讯 (RSS) ============

function parseRSSItems(xml, sourceName) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i').exec(block);
      return r ? r[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const link = /<link>(https?:\/\/[^<]+)<\/link>/i.exec(block)?.[1]?.trim()
              || /<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/i.exec(block)?.[1]?.trim() || '';
    const title = get('title');
    const pubDate = get('pubDate');
    const desc = get('description').slice(0, 200);
    if (title && link) items.push({ title, link, pubDate, description: desc, source: sourceName });
  }
  return items.slice(0, 10);
}

async function fetchRSS(url, sourceName) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS/2.0)' },
      signal: AbortSignal.timeout(8000)
    });
    return parseRSSItems(await resp.text(), sourceName);
  } catch(e) { return []; }
}

async function translateTitle(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const data = await resp.json();
    return data[0]?.map(p => p[0]).filter(Boolean).join('') || text;
  } catch(e) { return text; }
}

async function translateTitles(titles) {
  if (!titles.length) return titles;
  // 限流 3 并发，避免 Google Translate 429
  const results = new Array(titles.length);
  for (let i = 0; i < titles.length; i += 3) {
    const batch = titles.slice(i, i + 3).map((t, j) =>
      translateTitle(t).then(r => { results[i + j] = r; })
    );
    await Promise.all(batch);
  }
  return results;
}

const RSS_SOURCES = {
  markets: [
    { name: 'Reuters', url: 'https://feeds.reuters.com/reuters/businessNews' },
    { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  ],
  politics: [
    { name: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/asia/china/rss.xml' },
    { name: 'SCMP', url: 'https://www.scmp.com/rss/4/feed' },
  ],
  world: [
    { name: 'NYT', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
    { name: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  ]
};

app.get('/api/news/intl', async (req, res) => {
  try {
    const category = req.query.category || 'markets';
    const cKey = `intl-news:${category}`;
    const cached = cacheGet(cKey);
    if (cached) return res.json(cached);

    const sources = RSS_SOURCES[category] || RSS_SOURCES.markets;
    const results = await Promise.all(sources.map(s => fetchRSS(s.url, s.name)));
    let articles = results.flat();
    articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    articles = articles.slice(0, 20);

    const titles = articles.map(a => a.title);
    const translated = await translateTitles(titles);
    articles.forEach((a, i) => { a.titleZh = translated[i] || a.title; });

    cacheSet(cKey, articles, 600);
    res.json(articles);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 白银价格 ============

app.get('/api/silver', async (req, res) => {
  try {
    const data = await withCache('price:silver', getTTL(60), () =>
      fetch('https://api.gold-api.com/price/XAG').then(r => r.json())
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 汇率 ============

app.get('/api/exchange-rate', async (req, res) => {
  try {
    const data = await withCache('price:usdcny', getTTL(120), async () => {
      const r = await yahooFinance.quote('CNY=X');
      return { rate: r.regularMarketPrice, name: 'USD/CNY' };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message, rate: 7.25 }); }
});

// ============ 恐惧贪婪指数 ============

app.get('/api/fear-greed', async (req, res) => {
  const cached = cacheGet('fear:greed');
  if (cached) return res.json(cached);
  try {
    const resp = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
    });
    const data = await resp.json();
    const score = data.fear_and_greed?.score;
    const rating = data.fear_and_greed?.rating;
    const previous = data.fear_and_greed_historical?.previous_close;
    const result = { score: Math.round(score), rating, previousClose: Math.round(previous) };
    cacheSet('fear:greed', result, 1800); // 30分钟缓存
    res.json(result);
  } catch (e) {
    // fallback: 用 VIX 估算
    try {
      const vix = await yahooFinance.quote('^VIX');
      const vixVal = vix.regularMarketPrice;
      // VIX > 30 = extreme fear, VIX < 15 = extreme greed
      const score = Math.max(0, Math.min(100, Math.round(100 - (vixVal - 12) * (100 / 28))));
      const rating = score <= 25 ? 'Extreme Fear' : score <= 45 ? 'Fear' : score <= 55 ? 'Neutral' : score <= 75 ? 'Greed' : 'Extreme Greed';
      res.json({ score, rating, source: 'VIX-derived' });
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// ============ 经济日历 ============

app.get('/api/calendar', async (req, res) => {
  // 2026年重要经济事件（已知的固定日程）
  const events = [
    { date: '2026-01-29', event: 'FOMC利率决议', importance: 'high', category: 'fed' },
    { date: '2026-03-19', event: 'FOMC利率决议', importance: 'high', category: 'fed' },
    { date: '2026-05-07', event: 'FOMC利率决议', importance: 'high', category: 'fed' },
    { date: '2026-06-18', event: 'FOMC利率决议', importance: 'high', category: 'fed' },
    { date: '2026-07-30', event: 'FOMC利率决议', importance: 'high', category: 'fed' },
    { date: '2026-09-17', event: 'FOMC利率决议', importance: 'high', category: 'fed' },
    { date: '2026-11-05', event: 'FOMC利率决议', importance: 'high', category: 'fed' },
    { date: '2026-12-17', event: 'FOMC利率决议', importance: 'high', category: 'fed' },
    // 非农 (每月第一个周五)
    { date: '2026-01-02', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-02-06', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-03-06', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-04-03', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-05-01', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-06-05', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-07-02', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-08-07', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-09-04', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-10-02', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-11-06', event: '非农就业数据', importance: 'high', category: 'jobs' },
    { date: '2026-12-04', event: '非农就业数据', importance: 'high', category: 'jobs' },
    // CPI (大约每月10-14日)
    { date: '2026-01-14', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-02-11', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-03-11', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-04-14', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-05-12', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-06-10', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-07-14', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-08-12', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-09-15', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-10-13', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-11-10', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
    { date: '2026-12-10', event: 'CPI通胀数据', importance: 'high', category: 'cpi' },
  ];
  // 返回从今天起未来60天的事件
  const now = new Date();
  const cutoff = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const upcoming = events
    .filter(e => new Date(e.date) >= now && new Date(e.date) <= cutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  res.json(upcoming);
});

// ============ 宏观经济数据 ============

// ============ 宏观实时汇率 & 收益率 ============

app.get('/api/macro/live', async (req, res) => {
  try {
    const data = await withCache('macro:live', 900, async () => {
      const symbols = [
        'EURUSD=X','GBPUSD=X','USDJPY=X','USDCNY=X','AUDUSD=X','USDCAD=X','USDCHF=X','USDKRW=X',
        '^TNX','^FVX','^IRX','^TYX'
      ];
      const quotes = await yahooFinance.quote(symbols);
      const fx = {}, yields = {};
      const fxSymbols = ['EURUSD=X','GBPUSD=X','USDJPY=X','USDCNY=X','AUDUSD=X','USDCAD=X','USDCHF=X','USDKRW=X'];
      const yieldSymbols = ['^TNX','^FVX','^IRX','^TYX'];
      for (const q of (Array.isArray(quotes) ? quotes : [quotes])) {
        const sym = q.symbol;
        const entry = { price: q.regularMarketPrice, changePct: q.regularMarketChangePercent, change: q.regularMarketChange };
        if (fxSymbols.includes(sym)) fx[sym] = entry;
        if (yieldSymbols.includes(sym)) yields[sym] = entry;
      }
      return { fx, yields, updatedAt: new Date().toISOString() };
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/macro', (req, res) => {
  // 主要经济体近4个季度宏观数据 (2025Q1 - 2025Q4)
  // 数据来源：BEA/BLS/Fed/中国统计局/ECB/日本内阁府/各国央行官方发布
  // Q1 2026数据尚未发布，仅展示2025全年4个季度
  const quarters = ['2025Q1','2025Q2','2025Q3','2025Q4'];
  const data = {
    US: {
      name: '美国', flag: '🇺🇸', currency: 'USD',
      indicators: {
        gdp: { name: 'GDP增速(环比年化)', unit: '%', values: [1.4, 3.8, 4.4, 0.7],
          tip: 'GDP环比年化增长率（BEA）\n衡量美国经济整体增速\n>3%：强劲扩张\n2-3%：温和增长\n<1%：接近停滞\n负值：经济萎缩\n对黄金：经济放缓→降息预期→利好金价' },
        cpi: { name: 'CPI通胀(同比)', unit: '%', values: [2.8, 2.6, 2.4, 2.7],
          tip: 'CPI同比通胀率（BLS）\n美联储目标：2%\n>3%：通胀偏高，可能推迟降息\n2-3%：温和可控\n<2%：通缩风险\n对黄金：高通胀→保值需求增→利好金价\n但若导致加息→利空金价' },
        rate: { name: '联邦基金利率', unit: '%', values: [4.50, 4.50, 4.25, 4.25],
          tip: '联邦基金目标利率上限（Fed）\n美联储货币政策核心工具\n利率越高→持有黄金机会成本越大→利空金价\n降息周期→利好金价\n2025年维持高位后开始缓慢下调\nFOMC预计2026年底降至3.4%' },
        unemployment: { name: '失业率', unit: '%', values: [4.0, 4.1, 4.2, 4.5], inverse: true,
          tip: '失业率（BLS）\n<4%：充分就业，经济过热风险\n4-5%：正常区间\n>5%：就业市场走弱\n>6%：经济衰退信号\n对黄金：失业率上升→经济忧虑→避险需求→利好金价' },
        pmi: { name: '制造业PMI(ISM)', unit: '', values: [49.2, 48.7, 47.2, 49.3], threshold: 50,
          tip: 'ISM制造业采购经理指数\n>50：制造业扩张\n=50：荣枯分界线\n<50：制造业收缩\n<45：深度收缩\n对黄金：PMI走弱→经济放缓预期→利好金价' },
        debt: { name: '10Y国债收益率', unit: '%', values: [4.20, 4.40, 3.80, 4.50],
          tip: '美国10年期国债收益率\n全球资产定价锚\n与黄金通常负相关\n收益率上升→资金流向债券→利空金价\n收益率下降→持有黄金机会成本降低→利好金价\n>4.5%：高利率环境，压制金价' }
      }
    },
    CN: {
      name: '中国', flag: '🇨🇳', currency: 'CNY',
      indicators: {
        gdp: { name: 'GDP增速(同比)', unit: '%', values: [5.4, 5.2, 4.8, 4.5],
          tip: 'GDP同比增长率（国家统计局）\n2025全年增速5.0%\n>5%：达到政策目标\n4-5%：增长放缓\n<4%：需要更多政策刺激\n对黄金：中国是全球最大黄金消费国\n经济放缓→央行增持黄金→支撑金价' },
        cpi: { name: 'CPI通胀(同比)', unit: '%', values: [0.1, 0.3, 0.4, 0.2],
          tip: 'CPI同比通胀率（国家统计局）\n>2%：温和通胀\n0-1%：低通胀/通缩边缘\n<0%：通缩（消费疲软）\n中国2025年持续低通胀\n反映内需不足和消费信心偏弱' },
        rate: { name: 'LPR(1年期)', unit: '%', values: [3.45, 3.45, 3.35, 3.10],
          tip: '贷款市场报价利率1年期（央行）\n中国基准贷款利率\n下调→刺激信贷和经济→人民币承压\n人民币贬值→国内金价上涨\n2025年下半年连续下调，反映稳增长需要' },
        unemployment: { name: '城镇调查失业率', unit: '%', values: [5.2, 5.0, 5.1, 5.1], inverse: true,
          tip: '城镇调查失业率（国家统计局）\n<5%：就业良好\n5-5.5%：正常区间\n>5.5%：就业压力加大\n注意：青年失业率远高于整体\n就业压力→消费疲软→经济下行压力' },
        pmi: { name: '制造业PMI', unit: '', values: [50.5, 49.5, 50.2, 50.1], threshold: 50,
          tip: '官方制造业PMI（国家统计局）\n>50：制造业扩张\n=50：荣枯线\n<50：制造业收缩\n2025年在荣枯线附近波动\n反映制造业恢复基础不牢固' },
        m2: { name: 'M2增速(同比)', unit: '%', values: [7.0, 6.7, 6.8, 7.3],
          tip: 'M2广义货币供应同比增速（央行）\n反映货币宽松程度\n>8%：货币较宽松\n6-8%：适度\n<6%：偏紧\nM2增速>GDP增速→流动性充裕\n对黄金：货币宽松→通胀预期→利好金价' }
      }
    },
    EU: {
      name: '欧元区', flag: '🇪🇺', currency: 'EUR',
      indicators: {
        gdp: { name: 'GDP增速(环比)', unit: '%', values: [0.4, 0.3, 0.3, 0.2],
          tip: 'GDP环比增速（Eurostat）\n2025全年增长约1.5%\n>0.5%：较强增长\n0.2-0.5%：温和增长\n<0.2%：增长乏力\n0或负：停滞/衰退\n欧元区增长持续疲软' },
        cpi: { name: 'HICP通胀(同比)', unit: '%', values: [2.2, 2.5, 2.2, 2.0],
          tip: 'HICP调和消费者物价指数（Eurostat）\nECB目标：2%\n>2.5%：通胀偏高\n1.5-2.5%：目标附近\n<1.5%：通胀不足\n2025年底回落至2%目标\n为ECB继续降息打开空间' },
        rate: { name: 'ECB存款利率', unit: '%', values: [2.50, 2.25, 2.00, 2.00],
          tip: 'ECB存款便利利率\n欧央行核心政策利率\n2025年持续降息通道\nQ4维持在2.00%\n降息→欧元承压→美元相对走强→金价承压\n但全球降息潮→整体利好金价' },
        unemployment: { name: '失业率', unit: '%', values: [6.4, 6.4, 6.3, 6.3], inverse: true,
          tip: '欧元区失业率（Eurostat）\n结构性偏高，各国差异大\n德国~3.5%，西班牙>11%\n<6%：历史低位\n6-7%：正常区间\n>8%：就业压力大\n2025年就业市场相对稳定' },
        pmi: { name: '制造业PMI', unit: '', values: [46.1, 45.8, 46.1, 47.2], threshold: 50,
          tip: '制造业PMI（S&P Global/HCOB）\n欧元区制造业持续收缩\n长期低于50荣枯线\n主要拖累：德国制造业疲软\n能源成本高企+竞争力下降\n对金价：欧洲经济疲软→避险需求' },
        debt: { name: '德国10Y国债', unit: '%', values: [2.30, 2.45, 2.15, 2.35],
          tip: '德国10年期国债收益率\n欧洲无风险利率基准\n与美债利差影响欧元汇率\n收益率上升→欧元走强\n对黄金：欧债收益率下降→\n全球低利率环境→利好金价' }
      }
    },
    JP: {
      name: '日本', flag: '🇯🇵', currency: 'JPY',
      indicators: {
        gdp: { name: 'GDP增速(环比年化)', unit: '%', values: [-0.7, 2.2, 1.2, 0.6],
          tip: 'GDP环比年化增长率（内阁府）\n日本经济波动较大\nQ1负增长后逐步恢复\n>2%：较强增长\n0-2%：低增长常态\n<0%：技术性衰退风险\n日元贬值支撑出口但抑制消费' },
        cpi: { name: 'CPI通胀(同比)', unit: '%', values: [2.7, 2.8, 2.5, 2.3],
          tip: 'CPI同比通胀率（总务省）\nBOJ目标：2%\n日本摆脱通缩进入通胀时代\n>2%：超过BOJ目标\n持续通胀为BOJ加息提供依据\n对黄金：日元加息→日元升值→\n减少日元套利交易→金价波动' },
        rate: { name: 'BOJ政策利率', unit: '%', values: [0.50, 0.50, 0.50, 0.50],
          tip: 'BOJ无担保隔夜拆借利率\n2024年3月结束负利率\n2025年初加至0.5%后观望\n日本利率虽低但在历史高位\n加息→日元走强→资金回流日本\n全球流动性收紧→金价短期承压' },
        unemployment: { name: '失业率', unit: '%', values: [2.4, 2.5, 2.5, 2.4], inverse: true,
          tip: '完全失业率（总务省）\n日本劳动力市场极度紧张\n<3%：充分就业（人口老龄化）\n3-4%：正常\n>4%：异常偏高\n劳动力短缺推动工资上涨\n工资涨→消费→通胀→BOJ加息依据' },
        pmi: { name: '制造业PMI', unit: '', values: [49.6, 49.0, 49.7, 49.6], threshold: 50,
          tip: '制造业PMI（Jibun Bank/S&P Global）\n日本制造业长期在荣枯线附近\n>50：扩张\n<50：收缩\n受汽车产业和半导体周期影响大\n日元贬值提振出口竞争力' },
        tankan: { name: '短观指数(大型制造)', unit: '', values: [12, 13, 14, 14],
          tip: '日银短观调查·大型制造业DI\nBOJ最重要的景气指标之一\n>0：乐观企业多于悲观\n>15：景气较好\n<0：悲观占主导\n对BOJ政策有重要参考价值\n短观走强→加息预期→日元升值' }
      }
    }
  };
  res.json({ quarters, economies: data, updated: '2026-03-26' });
});

// ============ 宏观驱动因子 & ETF ============

app.get('/api/macro/drivers', async (req, res) => {
  try {
    const data = await withCache('macro:drivers', 300, async () => {
      const quotes = await yahooFinance.quote(['^VIX', '^TNX', 'DX-Y.NYB', 'HG=F', 'GC=F']);
      const q = {};
      quotes.forEach(r => { q[r.symbol] = r; });

      const CPI = 2.7; // 最新 CPI 同比（需定期更新）
      const vixVal  = q['^VIX']?.regularMarketPrice       || 20;
      const tnxVal  = q['^TNX']?.regularMarketPrice        || 4.3;
      const dxyChgPct = q['DX-Y.NYB']?.regularMarketChangePercent || 0;
      const dxyVal  = q['DX-Y.NYB']?.regularMarketPrice    || 103;
      const copperVal = q['HG=F']?.regularMarketPrice      || 4.5;
      const goldVal = q['GC=F']?.regularMarketPrice        || 3100;

      const realRate = parseFloat((tnxVal - CPI).toFixed(2));
      const copperGoldRatio = parseFloat((copperVal / goldVal * 1000).toFixed(4));

      // 子分数 0-100，越高 = 对金价越利好（避险越强）
      const vixScore      = Math.min(100, Math.max(0, (vixVal - 12) / 30 * 100));
      const realRateScore = Math.min(100, Math.max(0, (2.5 - realRate) / 4 * 100));
      const dxyScore      = Math.min(100, Math.max(0, 50 - dxyChgPct * 15));
      const composite     = Math.round(vixScore * 0.4 + realRateScore * 0.35 + dxyScore * 0.25);

      let sentiment, sentimentColor;
      if (composite >= 75) { sentiment = '极度避险'; sentimentColor = '#ff3d57'; }
      else if (composite >= 58) { sentiment = '避险升温'; sentimentColor = '#ff9500'; }
      else if (composite >= 42) { sentiment = '中性震荡'; sentimentColor = '#f0b90b'; }
      else if (composite >= 25) { sentiment = '风险偏好'; sentimentColor = '#4caf50'; }
      else { sentiment = '强风险偏好'; sentimentColor = '#00c853'; }

      return {
        vix:       { value: vixVal, change: q['^VIX']?.regularMarketChange, changePct: q['^VIX']?.regularMarketChangePercent },
        realRate:  { value: realRate, nominalYield: tnxVal, cpi: CPI },
        dxy:       { value: dxyVal, change: q['DX-Y.NYB']?.regularMarketChange, changePct: dxyChgPct },
        copperGold:{ value: copperGoldRatio, copper: copperVal, gold: goldVal },
        fearGreed: { composite, sentiment, sentimentColor,
          subs: { vixScore: Math.round(vixScore), realRateScore: Math.round(realRateScore), dxyScore: Math.round(dxyScore) }
        }
      };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/macro/etf', async (req, res) => {
  try {
    const data = await withCache('macro:etf', 300, async () => {
      const quotes = await yahooFinance.quote(['GLD', 'IAU']);
      return quotes.map(r => ({
        symbol: r.symbol,
        price:     r.regularMarketPrice,
        change:    r.regularMarketChange,
        changePct: r.regularMarketChangePercent,
        volume:    r.regularMarketVolume,
        high52:    r.fiftyTwoWeekHigh,
        low52:     r.fiftyTwoWeekLow,
        marketCap: r.marketCap
      }));
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AI 分析 (DeepSeek) ============

// 清洗用户输入：截断长度、移除潜在注入指令
function sanitizeAIInput(s, maxLen = 4000) {
  if (typeof s !== 'string') return '';
  return s.slice(0, maxLen).replace(/\b(ignore|disregard|forget|override)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi, '[FILTERED]');
}

app.post('/api/ai/analyze', async (req, res) => {
  try {
    const marketData = sanitizeAIInput(req.body.marketData);
    const newsData = sanitizeAIInput(req.body.newsData);

    let prompt = `你是一位资深的黄金市场分析师。请根据以下实时市场数据，分析当前黄金价格走势，并给出你的专业判断。

当前市场数据：
${marketData}

`;
    if (newsData) {
      prompt += `近期相关新闻：
${newsData}

`;
    }
    prompt += `请从以下几个角度分析：
1. 黄金价格当前走势判断（看涨/看跌/震荡）
2. 影响因素分析（美元、原油、地缘政治等）
3. 与其他市场的关联性分析
4. 短期操作建议

请用中文回答，简洁专业，控制在500字以内。`;

    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是一位专业的黄金市场分析师，擅长从宏观经济数据和市场联动关系中分析黄金走势。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 2048,
        stream: false
      })
    });

    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content || '分析暂时不可用';
    // 去除 <think>...</think> 标签
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    res.json({ analysis: content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ AI 情景预测 ============

app.post('/api/ai/scenario', async (req, res) => {
  try {
    const marketSummary = sanitizeAIInput(req.body.marketSummary);

    // 用管道分隔格式代替 JSON，彻底避免 AI 在描述文字中输出未转义引号导致解析崩溃
    const prompt = `你是专业黄金分析师。根据以下市场数据，给出黄金近期（1-2周）走势的三种情景预测。

市场数据：
${marketSummary}

请严格按以下格式输出三行，每行用 | 分隔，不要有任何其他内容：
BULL|情景标题|概率(整数%)|目标价位区间|80字以内分析
NEUTRAL|情景标题|概率(整数%)|目标价位区间|80字以内分析
BEAR|情景标题|概率(整数%)|目标价位区间|80字以内分析

要求：三行概率之和=100；分析文字不要使用竖线符号"|"。`;

    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是专业黄金分析师，严格按用户要求的格式输出，不添加任何额外文字。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.6,
        max_tokens: 600,
        stream: false
      })
    });
    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content || '';
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

    // 解析管道分隔格式
    const lines = content.split('\n').map(l => l.trim()).filter(l => l);
    const typeMap = { BULL: 'bull', NEUTRAL: 'neutral', BEAR: 'bear' };
    const scenarios = {};
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 5) continue;
      const key = typeMap[parts[0].toUpperCase()];
      if (!key) continue;
      scenarios[key] = {
        title: parts[1].trim(),
        probability: parseInt(parts[2]) || 0,
        target: parts[3].trim(),
        desc: parts[4].trim()
      };
    }
    if (!scenarios.bull && !scenarios.neutral && !scenarios.bear) {
      return res.status(500).json({ error: '无法解析AI输出', raw: content.slice(0, 300) });
    }
    res.json({ scenarios });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ A股数据 ============

// A股分时走势（东方财富 trends2 接口，替代 Yahoo Finance 的不稳定数据）
app.get('/api/astock/trends', async (req, res) => {
  try {
    const secid = req.query.secid || '1.000001'; // 默认上证指数
    const data = await aStockSwr(`astock:trends:${secid}`, 5, async () => {
      const url = `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=fa5fd1943c7b386f172d6893dbbd4dc0&iscr=0`;
      const resp = await fetch(url, { headers: { 'Referer': 'https://quote.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, redirect: 'follow' });
      const d = await resp.json();
      const trends = d.data?.trends || [];
      const preClose = d.data?.preClose || 0;
      // 格式: "2026-03-30 09:30,开盘,最高,最低,收盘,成交量,成交额,均价"
      const timestamps = [], prices = [];
      for (const t of trends) {
        const parts = t.split(',');
        timestamps.push(parts[0]);
        prices.push(parseFloat(parts[4])); // 收盘价
      }
      return { timestamps, prices, preClose };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 六大指数
app.get('/api/astock/indices', async (req, res) => {
  try {
    const cached = cacheGet('astock:indices');
    if (cached) return res.json(cached);
    const results = await fetchSinaSimple('s_sh000001,s_sz399001,s_sh000300,s_sz399006,s_sh000688,s_sh000016');
    cacheSet('astock:indices', results, getTTL(30));
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 申万行业板块涨跌
// 申万行业历史资金流向（主力净流入累计）
const SECTOR_FLOW_TTL = 900; // 15分钟（秒）
const SECTORS_CFG = [
  { code: 'BK1201', name: '电子' },
  { code: 'BK1207', name: '计算机' },
  { code: 'BK1216', name: '医药生物' },
  { code: 'BK1283', name: '银行' },
  { code: 'BK1203', name: '非银金融' },
  { code: 'BK0438', name: '食品饮料' },
  { code: 'BK1200', name: '电力设备' },
  { code: 'BK1202', name: '房地产' },
  { code: 'BK0478', name: '有色金属' },
  { code: 'BK0437', name: '煤炭' },
];
app.get('/api/astock/sector-flow-history', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 252);
  try {
    const data = await withCache(`sectorflow:${days}`, SECTOR_FLOW_TTL, async () => {
      const hdrs = { 'Referer': 'https://data.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const fetchOne = async s => {
        const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&secid=90.${s.code}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&ut=7eea3edcaed734bea9cbfc24409ed989`;
        const resp = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(10000) });
        const data = await resp.json();
        const klines = (data.data?.klines || []).slice(-days);
        let cum = 0;
        const dates = [], values = [];
        for (const k of klines) {
          const p = k.split(',');
          cum += parseFloat(p[1] || 0) / 1e8;
          dates.push(p[0]);
          values.push(parseFloat(cum.toFixed(2)));
        }
        return { code: s.code, name: s.name, dates, values };
      };
      const all = [];
      for (let i = 0; i < SECTORS_CFG.length; i += 4) {
        const batch = SECTORS_CFG.slice(i, i + 4);
        const res2 = await Promise.allSettled(batch.map(fetchOne));
        all.push(...res2);
        if (i + 4 < SECTORS_CFG.length) await delay(300);
      }
      const sectors = all.filter(r => r.status === 'fulfilled' && r.value.dates.length > 0).map(r => r.value);
      const dates = sectors.reduce((a, b) => a.dates.length >= b.dates.length ? a : b, { dates: [] }).dates;
      return { dates, sectors };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/astock/sectors', async (req, res) => {
  try {
    const data = await aStockSwr('astock:sectors', 30, async () => {
      const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50&fields=f2,f3,f4,f12,f14';
      const resp = await fetch(url, { headers: { 'Referer': 'https://finance.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
      const d = await resp.json();
      return (d.data?.diff || []).map(i => ({ code: i.f12, name: i.f14, changePercent: i.f3, price: i.f2 / 100, change: i.f4 / 100 }));
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 板块强度计算 ============
function calcStrength(stocks) {
  let lu = 0, ld = 0, str = 0, wk = 0, sub = 0, swk = 0;
  for (const s of stocks) {
    const p = s.changePercent || 0;
    if (p >= 9.9) lu++;
    else if (p <= -9.9) ld++;
    else if (p > 8) str++;
    else if (p < -8) wk++;
    else if (p > 5) sub++;
    else if (p < -5) swk++;
  }
  let d1 = Math.max(-10, Math.min(10, lu * 0.5 + ld * (-2)));
  let d2 = Math.max(-5, Math.min(2.5, str * 0.5 + wk * (-0.8 * (wk === 1 ? 0.5 : 1))));
  let d3 = Math.max(-5, Math.min(2.5, sub * 0.5 + swk * (-0.6 * (swk === 1 ? 0.5 : 1))));
  const total = Math.max(-10, Math.min(10, +(d1 + d2 + d3).toFixed(1)));
  const [label, icon] = total >= 7 ? ['极热','🔥'] : total >= 4 ? ['较热','⚡'] : total >= 1 ? ['偏热','📈'] : total >= -1 ? ['中性','➖'] : total >= -4 ? ['偏冷','📉'] : total >= -7 ? ['较冷','❄️'] : ['极冷','💀'];
  return { strength: total, label, icon, breakdown: { limitUp: lu, limitDown: ld, strong: str, weak: wk, subStrong: sub, subWeak: swk, dim1: +d1.toFixed(1), dim2: +d2.toFixed(1), dim3: +d3.toFixed(1) } };
}
const EM_HDR = { 'Referer': 'https://finance.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };

// 单板块强度（带成分股明细）
app.get('/api/astock/sector-strength/:code', async (req, res) => {
  try {
    const code = req.params.code.replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
    const data = await aStockSwr('str:' + code, 30, async () => {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=300&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=b:${code}+f:!50&fields=f2,f3,f4,f12,f14`;
      const resp = await fetch(url, { headers: EM_HDR, signal: AbortSignal.timeout(10000) });
      const d = await resp.json();
      const stocks = (d.data?.diff || []).map(i => ({ code: i.f12, name: i.f14, price: i.f2 / 100, changePercent: i.f3 }));
      const result = calcStrength(stocks);
      result.code = code;
      result.totalStocks = stocks.length;
      result.stocks = stocks;
      return result;
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 全板块强度排行
app.get('/api/astock/sector-strength', async (req, res) => {
  try {
    const data = await aStockSwr('str:all', 30, async () => {
      const secUrl = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50&fields=f2,f3,f4,f12,f14';
      const secResp = await fetch(secUrl, { headers: EM_HDR, signal: AbortSignal.timeout(8000) });
      const secData = await secResp.json();
      const sectors = (secData.data?.diff || []).map(i => ({ code: i.f12, name: i.f14, changePercent: i.f3 }));
      const results = await Promise.allSettled(sectors.map(async sec => {
        const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=300&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=b:${sec.code}+f:!50&fields=f3`;
        const resp = await fetch(url, { headers: EM_HDR, signal: AbortSignal.timeout(10000) });
        const d = await resp.json();
        const stocks = (d.data?.diff || []).map(i => ({ changePercent: i.f3 }));
        const s = calcStrength(stocks);
        return { code: sec.code, name: sec.name, changePercent: sec.changePercent, ...s, totalStocks: stocks.length };
      }));
      return results.filter(r => r.status === 'fulfilled').map(r => r.value).sort((a, b) => b.strength - a.strength);
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 板块搜索（用东方财富suggest API，支持模糊匹配）
app.get('/api/astock/sector-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(q) + '&type=14&token=D43BF722C8E33BDC906FB84D85E326&count=15';
    const resp = await fetch(url, { headers: EM_HDR, signal: AbortSignal.timeout(8000) });
    const data = await resp.json();
    const items = (data.QuotationCodeTable?.Data || [])
      .filter(i => i.Classify === 'BK' && i.Code?.startsWith('BK'))
      .map(i => ({ code: i.Code, name: i.Name }));
    res.json(items);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 市场统计（涨跌家数、成交额）
app.get('/api/astock/market-stats', async (req, res) => {
  try {
    const data = await aStockSwr('astock:market-stats', 10, async () => {
      const emHdr = { 'Referer': 'https://quote.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
      // 用 ulist.np 一次请求获取沪深两市涨跌家数 + stock/get 获取成交额和涨停数
      const [adR, shR, szR, luR, ldR] = await Promise.all([
        // 沪市A股(1.000002) + 深市综指(0.399107) 的涨跌平家数
        fetch('https://push2.eastmoney.com/api/qt/ulist.np/get?ut=bd1d9ddb04089700cf9c27f6f7426281&fields=f104,f105,f106&secids=1.000002,0.399107', { headers: emHdr, redirect: 'follow' }).then(r => r.json()).catch(() => ({})),
        // 沪深成交额
        fetch('https://push2.eastmoney.com/api/qt/stock/get?ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&secid=1.000001&fields=f48', { headers: emHdr, redirect: 'follow' }).then(r => r.json()).catch(() => ({})),
        fetch('https://push2.eastmoney.com/api/qt/stock/get?ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&secid=0.399001&fields=f48', { headers: emHdr, redirect: 'follow' }).then(r => r.json()).catch(() => ({})),
        // 涨停/跌停：从clist排序取前100即可覆盖
        fetch('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f3', { headers: emHdr, redirect: 'follow' }).then(r => r.json()).catch(() => ({})),
        fetch('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=0&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f3', { headers: emHdr, redirect: 'follow' }).then(r => r.json()).catch(() => ({})),
      ]);
      // 涨跌家数（沪+深合并）
      const n = v => (typeof v === 'number' ? v : 0);
      const diffs = adR.data?.diff || [];
      let advance = 0, decline = 0, flat = 0;
      for (const d of diffs) { advance += n(d.f104); decline += n(d.f105); flat += n(d.f106); }
      // 涨停/跌停计数
      const limitUp = (luR.data?.diff || []).filter(s => typeof s.f3 === 'number' && s.f3 >= 9.9).length;
      const limitDown = (ldR.data?.diff || []).filter(s => typeof s.f3 === 'number' && s.f3 <= -9.9).length;
      // 成交额
      const shTurnover = (typeof shR.data?.f48 === 'number' ? shR.data.f48 : 0) / 1e8;
      const szTurnover = (typeof szR.data?.f48 === 'number' ? szR.data.f48 : 0) / 1e8;
      return { limitUp, advance, decline, flat, limitDown, turnover: Math.round((shTurnover + szTurnover) * 100) / 100 };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 北向资金（使用 kamt.rtmin 分钟级接口，kamt/get 已失效）
app.get('/api/astock/northbound', async (req, res) => {
  try {
    const data = await aStockSwr('astock:northbound', 10, async () => {
      const url = 'https://push2.eastmoney.com/api/qt/kamt.rtmin/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56&ut=b2884a393a59ad64002292a3e90d46a5';
      const resp = await fetch(url, { headers: { 'Referer': 'https://data.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, redirect: 'follow' });
      const d = await resp.json();
      // s2n: 北向资金分钟数据，格式 "HH:MM,沪净,沪余额,深净,深余额,合计净"
      const s2n = d.data?.s2n || [];
      let sh = 0, sz = 0;
      // 取最后一条有效数据（非"-"）
      for (let i = s2n.length - 1; i >= 0; i--) {
        const parts = s2n[i].split(',');
        if (parts[1] && parts[1] !== '-') {
          sh = parseFloat(parts[1]) / 1e4; // 万→亿
          sz = parseFloat(parts[3]) / 1e4;
          break;
        }
      }
      return { sh: Math.round(sh * 100) / 100, sz: Math.round(sz * 100) / 100, total: Math.round((sh + sz) * 100) / 100 };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 行业资金流向（替代热门股票，24h可用）
app.get('/api/astock/capitalflow', async (req, res) => {
  try {
    const po = req.query.type === 'outflow' ? 0 : 1;
    const data = await aStockSwr(`astock:capitalflow:${po}`, 30, async () => {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=12&po=${po}&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f62&fs=m:90+t:2+f:!50&fields=f12,f14,f62,f184,f3`;
      const resp = await fetch(url, { headers: { 'Referer': 'https://data.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
      const d = await resp.json();
      const toNum = v => typeof v === 'number' ? v : 0;
      return (d.data?.diff || []).map(i => ({
        code: i.f12, name: i.f14,
        netFlow: toNum(i.f62) / 1e8,
        pct: toNum(i.f184),
        changePercent: toNum(i.f3)
      }));
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 涨跌停板（盘中用 clist 实时数据，盘后用龙虎榜历史数据）
app.get('/api/astock/limit', async (req, res) => {
  try {
    const data = await aStockSwr('astock:limit', 15, async () => {
      const emHdr = { 'Referer': 'https://quote.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
      if (isAStockOpen()) {
        // 盘中：从 clist 获取实时涨跌停个股
        const base = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f3,f12,f14,f62';
        const [upR, dnR] = await Promise.all([
          fetch(base + '&po=1', { headers: emHdr, redirect: 'follow' }).then(r => r.json()).catch(() => ({})),
          fetch(base + '&po=0', { headers: emHdr, redirect: 'follow' }).then(r => r.json()).catch(() => ({})),
        ]);
        const mapItem = s => ({ code: s.f12, name: s.f14, changePercent: s.f3, netAmt: (typeof s.f62 === 'number' ? s.f62 : 0) / 1e8 });
        const limitUp = (upR.data?.diff || []).filter(s => typeof s.f3 === 'number' && s.f3 >= 9.9).map(mapItem);
        const limitDown = (dnR.data?.diff || []).filter(s => typeof s.f3 === 'number' && s.f3 <= -9.9).map(mapItem);
        const today = new Date(Date.now() + 8 * 3600000).toISOString().split('T')[0];
        return { limitUp, limitDown, upCount: limitUp.length, downCount: limitDown.length, date: today };
      }
      // 盘后：从龙虎榜获取历史数据
      const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_PROFILE&columns=ALL&pageNumber=1&pageSize=200&sortTypes=-1,-1&sortColumns=TRADE_DATE,CHANGE_RATE&source=WEB&client=WEB';
      const resp = await fetch(url, { headers: { 'Referer': 'https://data.eastmoney.com', ...emHdr }, redirect: 'follow' });
      const d = await resp.json();
      const items = d.result?.data || [];
      const map = i => ({ code: i.SECURITY_CODE, name: i.SECURITY_NAME_ABBR, changePercent: i.CHANGE_RATE || 0, netAmt: (i.BILLBOARD_NET_AMT || 0) / 1e8 });
      const limitUp = items.filter(i => (i.CHANGE_RATE || 0) >= 9.9).map(map);
      const limitDown = items.filter(i => (i.CHANGE_RATE || 0) <= -9.9).map(map);
      return { limitUp, limitDown, upCount: limitUp.length, downCount: limitDown.length, date: items[0]?.TRADE_DATE?.split(' ')[0] || '' };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 龙虎榜
app.get('/api/astock/dragon-tiger', async (req, res) => {
  try {
    const data = await aStockSwr('astock:dragon-tiger', 60, async () => {
      const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BILLBOARD_TRADEALLNEW&columns=ALL&pageNumber=1&pageSize=20&sortTypes=-1,-1&sortColumns=LATEST_TDATE,SECURITY_CODE&source=WEB&client=WEB';
      const resp = await fetch(url, { headers: { 'Referer': 'https://data.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
      const d = await resp.json();
      const seen = new Set();
      const items = [];
      for (const i of (d.result?.data || [])) {
        if (!seen.has(i.SECURITY_CODE)) {
          seen.add(i.SECURITY_CODE);
          items.push({
            code: i.SECURITY_CODE, name: i.SECURITY_NAME_ABBR,
            date: (i.LATEST_TDATE || '').split(' ')[0],
            changeRate: i.CHANGE_RATE || 0, closePrice: i.CLOSE_PRICE || 0,
            netBuy: (i.BILLBOARD_NET_BUY || 0) / 1e8,
            buyAmt: (i.BILLBOARD_BUY_AMT || 0) / 1e8,
            dealAmt: (i.BILLBOARD_DEAL_AMT || 0) / 1e8,
            times: i.BILLBOARD_TIMES || 1
          });
        }
        if (items.length >= 10) break;
      }
      return items;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 股票名称搜索（Eastmoney Suggest）============

app.get('/api/astock/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(q) + '&type=14&token=D43BF722C8E33BDC906FB84D85E326&count=8';
    const resp = await fetch(url, { headers: { 'Referer': 'https://www.eastmoney.com', 'User-Agent': 'Mozilla/5.0' } });
    const data = await resp.json();
    const items = (data.QuotationCodeTable?.Data || [])
      .filter(i => i.Classify === 'AStock' && /^\d{6}$/.test(i.Code))
      .slice(0, 8)
      .map(i => ({ code: i.Code, name: i.Name, market: i.SecurityTypeName }));
    res.json(items);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ 自选股实时行情（Sina Finance）============

function sinaPrefix(code) {
  const c = String(code).padStart(6, '0');
  if (c.startsWith('6') || c.startsWith('5')) return 'sh';
  return 'sz';
}

app.get('/api/astock/quote', async (req, res) => {
  try {
    const codes = (req.query.codes || '').split(',').map(s => s.trim()).filter(s => /^\d{6}$/.test(s)).slice(0, 50);
    if (!codes.length) return res.json([]);
    const sinaList = codes.map(c => sinaPrefix(c) + c).join(',');
    const results = await fetchSinaFull(sinaList);
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ A股个股详情 ============
app.get('/api/astock/detail/:code', async (req, res) => {
  try {
    const code = String(req.params.code).replace(/\D/g, '').padStart(6, '0');
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'invalid code' });
    const prefix = sinaPrefix(code);
    const exchange = prefix === 'sh' ? 'SSE' : 'SZSE';
    const yahooSymbol = code + (prefix === 'sh' ? '.SS' : '.SZ');
    const tvTicker = exchange + ':' + code;

    const [sinaRes, tvRes] = await Promise.allSettled([
      fetch('https://hq.sinajs.cn/list=' + prefix + code, {
        headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' }
      }),
      fetch('https://scanner.tradingview.com/china/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        body: JSON.stringify({ symbols: { tickers: [tvTicker] }, columns: ['name','description','close','change','market_cap_basic','price_earnings_ttm','total_revenue_yoy_growth_ttm','gross_margin_ttm','free_cash_flow_margin_ttm','RSI','ADX','SMA50','SMA200','price_52_week_high','price_52_week_low','dividend_yield_recent'] })
      })
    ]);

    let quote = null;
    if (sinaRes.status === 'fulfilled' && sinaRes.value.ok) {
      const buf = await sinaRes.value.arrayBuffer();
      // 复用 fetchSinaFull 的解析逻辑（手动解码已获取的 buffer）
      const text = new TextDecoder('gbk').decode(buf);
      const parsed = [];
      for (const line of text.trim().split('\n')) {
        const m = line.match(/hq_str_(\w+)="(.+)"/);
        if (!m) continue;
        const cd = m[1].replace(/^(sh|sz)/, ''), f = m[2].split(',');
        if (!f[3] || !parseFloat(f[3])) continue;
        const price = parseFloat(f[3]), prevClose = parseFloat(f[2]), chg = price - prevClose;
        parsed.push({ code: cd, name: f[0], price, prevClose, change: chg, changePercent: prevClose > 0 ? (chg / prevClose) * 100 : 0, open: parseFloat(f[1]), high: parseFloat(f[4]), low: parseFloat(f[5]), volume: Math.round(parseFloat(f[8]) / 100), amount: parseFloat(f[9]), time: f[31] || '' });
      }
      quote = parsed[0] || null;
    }

    let fundamentals = null;
    if (tvRes.status === 'fulfilled' && tvRes.value.ok) {
      const tvData = await tvRes.value.json();
      const item = (tvData.data || [])[0];
      if (item) {
        const d = item.d;
        const s = {
          close: d[2], pe: d[5],
          marketCap: d[4],
          revGrowth: d[6] != null ? d[6] / 100 : null,
          grossMargin: d[7] != null ? d[7] / 100 : null,
          fcfMargin: d[8] != null ? d[8] / 100 : null,
          rsi: d[9], adx: d[10], sma50: d[11], sma200: d[12],
          high52w: d[13], low52w: d[14],
          dividendYield: d[15],
        };
        fundamentals = scoreStock(s, 20, 40);
      }
    }

    res.json({ code, yahooSymbol, exchange, quote, fundamentals });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ A股主题选股（TradingView数据源）============

const TV_FIELDS = [
  'name', 'description', 'close', 'change',
  'market_cap_basic', 'price_earnings_ttm',
  'total_revenue_yoy_growth_ttm', 'gross_margin_ttm', 'free_cash_flow_margin_ttm',
  'RSI', 'ADX', 'SMA50', 'SMA200', 'price_52_week_high', 'price_52_week_low'
];

const ASTOCK_THEMES = {
  'ai-computing': {
    nameZh: 'AI算力',
    filters: [
      { left: 'market_cap_basic', operation: 'greater', right: 2e10 },
      { left: 'sector', operation: 'in_range', right: ['Electronic Technology', 'Technology Services'] },
      { left: 'total_revenue_yoy_growth_ttm', operation: 'greater', right: 15 },
    ]
  },
  'new-energy': {
    nameZh: '新能源车',
    filters: [
      { left: 'market_cap_basic', operation: 'greater', right: 1e10 },
      { left: 'sector', operation: 'in_range', right: ['Producer Manufacturing', 'Electronic Technology'] },
      { left: 'total_revenue_yoy_growth_ttm', operation: 'greater', right: 10 },
    ]
  },
  'consumer': {
    nameZh: '消费白马',
    filters: [
      { left: 'market_cap_basic', operation: 'greater', right: 5e10 },
      { left: 'sector', operation: 'in_range', right: ['Consumer Non-Durables', 'Consumer Durables'] },
      { left: 'gross_margin_ttm', operation: 'greater', right: 30 },
    ]
  },
  'high-dividend': {
    nameZh: '高股息',
    filters: [
      { left: 'market_cap_basic', operation: 'greater', right: 5e10 },
      { left: 'sector', operation: 'in_range', right: ['Finance', 'Utilities', 'Energy Minerals'] },
      { left: 'dividend_yield_recent', operation: 'greater', right: 3 },
    ]
  },
  'semiconductor': {
    nameZh: '半导体',
    filters: [
      { left: 'market_cap_basic', operation: 'greater', right: 1e10 },
      { left: 'sector', operation: 'in_range', right: ['Electronic Technology'] },
      { left: 'total_revenue_yoy_growth_ttm', operation: 'greater', right: 10 },
    ]
  },
};

function calcMedian(arr) {
  const v = arr.filter(x => x != null && x > 0).sort((a,b) => a-b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m-1] + v[m]) / 2;
}
function calcP75(arr) {
  const v = arr.filter(x => x != null && x > 0).sort((a,b) => a-b);
  if (!v.length) return 0;
  const i = 0.75 * (v.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
}

function computeSignals(s, medPe, p75Pe) {
  const sigs = { val: 0, growth: 0, margin: 0, trend: 0, momentum: 0, pattern: 0 };
  // Valuation
  if (s.pe != null && medPe > 0) {
    if (s.pe < medPe * 0.8) sigs.val = 1;
    else if (s.pe > p75Pe) sigs.val = -1;
  }
  // Growth (revGrowth already normalized to decimal)
  if (s.revGrowth != null) {
    if (s.revGrowth > 0.15) sigs.growth = 1;
    else if (s.revGrowth < 0.05) sigs.growth = -1;
  }
  // Margins
  if (s.grossMargin != null) {
    if (s.grossMargin < 0.2 || (s.fcfMargin != null && s.fcfMargin < 0)) sigs.margin = -1;
    else if (s.grossMargin > 0.4 && (s.fcfMargin == null || s.fcfMargin > 0)) sigs.margin = 1;
  }
  // Trend (SMA)
  if (s.close != null && s.sma200 != null) {
    if (s.close < s.sma200) sigs.trend = -1;
    else if (s.sma50 != null && s.close > s.sma200 && s.sma50 > s.sma200) sigs.trend = 1;
  }
  // Momentum (RSI)
  if (s.rsi != null) {
    if (s.rsi >= 35 && s.rsi <= 55) sigs.momentum = 1;
    else if (s.rsi > 70 && s.close != null && s.high52w > 0 && s.close / s.high52w > 0.95) sigs.momentum = -1;
  }
  // Pattern (ADX)
  if (s.adx != null) {
    if (s.adx < 15) sigs.pattern = -1;
    else if (s.adx > 25 && s.close != null && s.high52w > 0 && s.close / s.high52w > 0.9) sigs.pattern = 1;
  }
  return sigs;
}

function getSignalRating(total) {
  if (total >= 4) return '强烈买入';
  if (total >= 2) return '买入';
  if (total >= 0) return '持有';
  if (total >= -2) return '卖出';
  return '强烈卖出';
}

function scoreStock(s, medPe, p75Pe) {
  const sigs = computeSignals(s, medPe, p75Pe);
  const signal = Object.values(sigs).reduce((a, b) => a + b, 0);
  return { ...s, sigs, signal, rating: getSignalRating(signal) };
}

app.get('/api/astock/screen', async (req, res) => {
  try {
    const themeKey = req.query.theme || 'ai-computing';
    const preset = ASTOCK_THEMES[themeKey];
    if (!preset) return res.status(400).json({ error: 'unknown theme' });

    const resp = await fetch('https://scanner.tradingview.com/china/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        markets: ['china'],
        symbols: { query: { types: [] }, tickers: [] },
        options: { lang: 'zh' },
        columns: TV_FIELDS,
        filter: preset.filters,
        sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
        range: [0, 30],
      }),
    });

    if (!resp.ok) throw new Error(`TradingView ${resp.status}`);
    const data = await resp.json();

    const stocks = (data.data || []).map(item => {
      const d = item.d;
      const nameRaw = String(d[0] ?? '');
      const ticker = nameRaw.includes(':') ? nameRaw.split(':')[1] : nameRaw;
      return {
        ticker,
        name: String(d[1] ?? ticker),
        close: d[2],
        changePct: d[3],
        marketCap: d[4],
        pe: d[5],
        revGrowth: d[6] != null ? d[6] / 100 : null,
        grossMargin: d[7] != null ? d[7] / 100 : null,
        fcfMargin: d[8] != null ? d[8] / 100 : null,
        rsi: d[9],
        adx: d[10],
        sma50: d[11],
        sma200: d[12],
        high52w: d[13],
        low52w: d[14],
      };
    });

    const medPe = calcMedian(stocks.map(s => s.pe));
    const p75Pe = calcP75(stocks.map(s => s.pe));

    const scored = stocks.map(s => scoreStock(s, medPe, p75Pe)).sort((a, b) => b.signal - a.signal).slice(0, 20);

    res.json({ theme: themeKey, nameZh: preset.nameZh, total: data.totalCount || 0, stocks: scored });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ 美股 ============

const US_INDICES = [
  { symbol: '^GSPC', name: '标普500' },
  { symbol: '^DJI',  name: '道琼斯' },
  { symbol: '^IXIC', name: '纳斯达克' },
  { symbol: '^NDX',  name: 'NDX 100' },
  { symbol: '^RUT',  name: '罗素2000' },
  { symbol: '^VIX',  name: 'VIX恐慌' },
];

const US_SECTOR_ETFS = [
  { symbol: 'XLK',  name: '科技' },   { symbol: 'XLF',  name: '金融' },
  { symbol: 'XLE',  name: '能源' },   { symbol: 'XLV',  name: '医疗' },
  { symbol: 'XLC',  name: '通信' },   { symbol: 'XLI',  name: '工业' },
  { symbol: 'XLP',  name: '日消' },   { symbol: 'XLY',  name: '可选消费' },
  { symbol: 'XLB',  name: '材料' },   { symbol: 'XLRE', name: '房地产' },
  { symbol: 'XLU',  name: '公用事业' },
];

const US_THEMES = {
  'mag7':       { nameZh: 'AI巨头',  filters: [{ left: 'market_cap_basic', operation: 'greater', right: 5e11 }, { left: 'sector', operation: 'in_range', right: ['Electronic Technology','Technology Services','Retail Trade'] }] },
  'semis':      { nameZh: '半导体',  filters: [{ left: 'market_cap_basic', operation: 'greater', right: 5e9 }, { left: 'sector', operation: 'in_range', right: ['Electronic Technology'] }] },
  'healthcare': { nameZh: '医疗健康', filters: [{ left: 'market_cap_basic', operation: 'greater', right: 1e10 }, { left: 'sector', operation: 'in_range', right: ['Health Technology','Health Services'] }] },
  'finance':    { nameZh: '金融银行', filters: [{ left: 'market_cap_basic', operation: 'greater', right: 5e10 }, { left: 'sector', operation: 'in_range', right: ['Finance'] }] },
  'energy':     { nameZh: '传统能源', filters: [{ left: 'market_cap_basic', operation: 'greater', right: 1e10 }, { left: 'sector', operation: 'in_range', right: ['Energy Minerals','Process Industries'] }] },
};

app.get('/api/us/indices', async (req, res) => {
  try {
    const data = await usStockSwr('us:indices', 15, async () => {
      const symbols = US_INDICES.map(i => i.symbol);
      const results = await yahooFinance.quote(symbols);
      const arr = Array.isArray(results) ? results : [results];
      const nameMap = Object.fromEntries(US_INDICES.map(i => [i.symbol, i.name]));
      return arr.map(q => ({
        symbol: q.symbol, name: nameMap[q.symbol] || q.symbol,
        price: q.regularMarketPrice, change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent, prevClose: q.regularMarketPreviousClose,
        marketState: q.marketState,
      }));
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ticker — 行情滚动条聚合（A股指数 + 大宗商品 + 美股指数）
app.get('/api/ticker', async (req, res) => {
  const YH_ITEMS = [
    { symbol: 'GC=F',    name: '黄金',   market: 'gl' },
    { symbol: 'SI=F',    name: '白银',   market: 'gl' },
    { symbol: 'CL=F',    name: '原油',   market: 'gl' },
    { symbol: 'BTC-USD', name: '比特币', market: 'gl' },
    { symbol: '^GSPC',   name: '标普500', market: 'us' },
    { symbol: '^DJI',    name: '道琼斯', market: 'us' },
    { symbol: '^IXIC',   name: '纳斯达克', market: 'us' },
    { symbol: '^VIX',    name: 'VIX',   market: 'us' },
  ];
  const CN_INDICES = [
    { code: 'sh000001', name: '上证指数' },
    { code: 'sz399001', name: '深成指数' },
    { code: 'sh000300', name: '沪深300' },
    { code: 'sz399006', name: '创业板' },
  ];
  try {
    const [yhRes, sinaRes] = await Promise.allSettled([
      yahooFinance.quote(YH_ITEMS.map(i => i.symbol)),
      fetch('https://hq.sinajs.cn/list=' + CN_INDICES.map(i => i.code).join(','), {
        headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' }
      }).then(r => r.arrayBuffer()).then(buf => new TextDecoder('gbk').decode(buf))
    ]);

    const items = [];
    // A股指数（优先放前面）
    if (sinaRes.status === 'fulfilled') {
      const nameMap = Object.fromEntries(CN_INDICES.map(i => [i.code, i.name]));
      for (const line of sinaRes.value.trim().split('\n')) {
        const m = line.match(/hq_str_(\w+)="(.+)"/);
        if (!m) continue;
        const f = m[2].split(',');
        const price = parseFloat(f[3]);
        const prevClose = parseFloat(f[2]);
        if (!price) continue;
        const chg = price - prevClose;
        items.push({ name: nameMap[m[1]] || m[1], price: price.toFixed(2), change: chg, changePct: prevClose > 0 ? chg / prevClose * 100 : 0, market: 'cn' });
      }
    }
    // 大宗 + 美股指数
    if (yhRes.status === 'fulfilled') {
      const arr = Array.isArray(yhRes.value) ? yhRes.value : [yhRes.value];
      const nameMap = Object.fromEntries(YH_ITEMS.map(i => [i.symbol, { name: i.name, market: i.market }]));
      arr.forEach(q => {
        if (!q || q.regularMarketPrice == null) return;
        const meta = nameMap[q.symbol] || { name: q.symbol, market: 'gl' };
        items.push({ name: meta.name, price: q.regularMarketPrice.toFixed(2), change: q.regularMarketChange || 0, changePct: q.regularMarketChangePercent || 0, market: meta.market });
      });
    }
    res.json(items);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/us/sectors', async (req, res) => {
  try {
    const data = await usStockSwr('us:sectors', 30, async () => {
      const symbols = US_SECTOR_ETFS.map(s => s.symbol);
      const results = await yahooFinance.quote(symbols);
      const arr = Array.isArray(results) ? results : [results];
      const nameMap = Object.fromEntries(US_SECTOR_ETFS.map(s => [s.symbol, s.name]));
      return arr.map(q => ({
        symbol: q.symbol, name: nameMap[q.symbol] || q.symbol,
        price: q.regularMarketPrice, changePercent: q.regularMarketChangePercent,
      }));
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/us/quote', async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(s => s && /^[A-Z0-9\^\.\-]{1,12}$/.test(s)).slice(0, 30);
    if (!symbols.length) return res.json([]);
    const results = await yahooFinance.quote(symbols);
    const arr = Array.isArray(results) ? results : [results];
    res.json(arr.filter(q => q && q.regularMarketPrice != null).map(q => ({
      symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent,
      open: q.regularMarketOpen, high: q.regularMarketDayHigh,
      low: q.regularMarketDayLow, prevClose: q.regularMarketPreviousClose,
      volume: q.regularMarketVolume, marketCap: q.marketCap,
      marketState: q.marketState,
      preMarketPrice: q.preMarketPrice || null,
      preMarketChange: q.preMarketChangePercent || null,
      postMarketPrice: q.postMarketPrice || null,
      postMarketChange: q.postMarketChangePercent || null,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/us/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const results = await yahooFinance.search(q, { quotesCount: 8, newsCount: 0 });
    res.json((results.quotes || [])
      .filter(r => ['EQUITY','ETF','INDEX'].includes(r.quoteType))
      .slice(0, 8)
      .map(r => ({ symbol: r.symbol, name: r.longname || r.shortname || r.symbol, type: r.quoteType, exchange: r.exchDisp || r.exchange || '' })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function toTVExchange(exchangeName) {
  const e = String(exchangeName || '').toLowerCase();
  if (e.includes('nasdaq')) return 'NASDAQ';
  if (e.includes('arca') || e.includes('pcx') || e.includes('amex') || e.includes('nysearca')) return 'AMEX';
  if (e.includes('nyse')) return 'NYSE';
  return 'NASDAQ';
}

app.get('/api/us/detail/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase().replace(/[^A-Z0-9\.\^\-]/g, '').slice(0, 12);
    if (!symbol) return res.status(400).json({ error: 'invalid symbol' });
    const isIndex = symbol.startsWith('^');

    // Step 1: fetch Yahoo Finance quote first to get exchange info
    let quote = null;
    let tvTicker = null;
    try {
      const q = await yahooFinance.quote(symbol);
      if (q) {
        quote = {
          symbol: q.symbol, name: q.shortName || q.longName || symbol,
          price: q.regularMarketPrice, change: q.regularMarketChange,
          changePercent: q.regularMarketChangePercent,
          open: q.regularMarketOpen, high: q.regularMarketDayHigh,
          low: q.regularMarketDayLow, prevClose: q.regularMarketPreviousClose,
          volume: q.regularMarketVolume, marketCap: q.marketCap,
          high52w: q.fiftyTwoWeekHigh, low52w: q.fiftyTwoWeekLow,
          dividendYield: q.trailingAnnualDividendYield ? q.trailingAnnualDividendYield * 100 : null,
          marketState: q.marketState, exchange: q.fullExchangeName || '',
          preMarketPrice: q.preMarketPrice || null,
          preMarketChange: q.preMarketChangePercent || null,
          postMarketPrice: q.postMarketPrice || null,
          postMarketChange: q.postMarketChangePercent || null,
          time: q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) + ' ET' : '',
          sma50: q.fiftyDayAverage || null,
          sma200: q.twoHundredDayAverage || null,
        };
        if (!isIndex) {
          const tvEx = toTVExchange(q.fullExchangeName || q.exchange || '');
          tvTicker = tvEx + ':' + symbol;
        }
      }
    } catch(e) { /* quote fetch failed */ }

    // Step 2: fetch TradingView with correct exchange-prefixed ticker
    let fundamentals = null;
    if (!isIndex && tvTicker) {
      try {
        const tvRes = await fetch('https://scanner.tradingview.com/america/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          body: JSON.stringify({ symbols: { tickers: [tvTicker] }, columns: ['name','description','close','change','market_cap_basic','price_earnings_ttm','total_revenue_yoy_growth_ttm','gross_margin_ttm','free_cash_flow_margin_ttm','RSI','ADX','SMA50','SMA200','price_52_week_high','price_52_week_low','dividend_yield_recent'] })
        });
        if (tvRes.ok) {
          const tvData = await tvRes.json();
          const item = (tvData.data || [])[0];
          if (item) {
            const d = item.d;
            const s = {
              close: d[2], pe: d[5], marketCap: d[4],
              revGrowth: d[6] != null ? d[6]/100 : null,
              grossMargin: d[7] != null ? d[7]/100 : null,
              fcfMargin: d[8] != null ? d[8]/100 : null,
              rsi: d[9], adx: d[10], sma50: d[11], sma200: d[12],
              high52w: d[13], low52w: d[14], dividendYield: d[15]
            };
            if (s.sma50 == null && quote) s.sma50 = quote.sma50;
            if (s.sma200 == null && quote) s.sma200 = quote.sma200;
            fundamentals = scoreStock(s, 25, 50);
          }
        }
      } catch(e) { /* TV fetch failed */ }
    }

    // Step 3: fallback to Yahoo quoteSummary for indices or when TradingView failed
    if (!fundamentals && quote) {
      try {
        const summary = await yahooFinance.quoteSummary(symbol, { modules: ['defaultKeyStatistics', 'financialData'] });
        const ks = summary.defaultKeyStatistics || {};
        const fd = summary.financialData || {};
        const s = {
          close: quote.price, pe: ks.forwardPE || ks.trailingPE || null,
          marketCap: quote.marketCap,
          revGrowth: fd.revenueGrowth != null ? fd.revenueGrowth : null,
          grossMargin: fd.grossMargins != null ? fd.grossMargins : null,
          fcfMargin: fd.freeCashflow && fd.totalRevenue ? fd.freeCashflow / fd.totalRevenue : null,
          rsi: null, adx: null,
          sma50: quote.sma50, sma200: quote.sma200,
          high52w: quote.high52w, low52w: quote.low52w,
          dividendYield: quote.dividendYield
        };
        const sigs = computeSignals(s, 25, 50);
        const total = Object.values(sigs).reduce((a, b) => a + b, 0);
        fundamentals = { ...s, sigs, signal: total, rating: getSignalRating(total) };
      } catch(e) { /* quoteSummary failed */ }
    }

    res.json({ symbol, quote, fundamentals });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ETF 成分股（持仓 + 实时行情）
app.get('/api/us/etf-holdings/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase().replace(/[^A-Z0-9\.\-]/g, '').slice(0, 12);
    if (!symbol) return res.status(400).json({ error: 'invalid symbol' });
    const summary = await yahooFinance.quoteSummary(symbol, { modules: ['topHoldings'] });
    const holdings = (summary.topHoldings?.holdings || []).slice(0, 10);
    if (!holdings.length) return res.json([]);
    // 批量拉实时行情
    const syms = holdings.map(h => h.symbol).filter(Boolean);
    const quotes = await yahooFinance.quote(syms);
    const qArr = Array.isArray(quotes) ? quotes : [quotes];
    const qMap = Object.fromEntries(qArr.map(q => [q.symbol, q]));
    res.json(holdings.map(h => {
      const q = qMap[h.symbol] || {};
      return {
        symbol: h.symbol,
        name: h.holdingName || q.shortName || h.symbol,
        weight: h.holdingPercent ? +(h.holdingPercent * 100).toFixed(2) : null,
        price: q.regularMarketPrice || null,
        changePercent: q.regularMarketChangePercent || null,
      };
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/us/movers', async (req, res) => {
  try {
    const type = req.query.type || 'gainers';
    const data = await usStockSwr(`us:movers:${type}`, 30, async () => {
      const isActive = type === 'active';
      const isLosers = type === 'losers';
      const body = {
        markets: ['america'],
        symbols: { query: { types: ['stock'] }, tickers: [] },
        options: { lang: 'en' },
        columns: ['name','description','close','change','volume','market_cap_basic'],
        filter: [
          { left: 'market_cap_basic', operation: 'greater', right: isActive ? 5e9 : 1e9 },
          { left: 'volume', operation: 'greater', right: isActive ? 5e6 : 5e5 },
          ...(!isActive && !isLosers ? [{ left: 'change', operation: 'greater', right: 1.5 }] : []),
          ...(!isActive && isLosers  ? [{ left: 'change', operation: 'less', right: -1.5 }] : []),
        ],
        sort: { sortBy: isActive ? 'volume' : 'change', sortOrder: isLosers ? 'asc' : 'desc' },
        range: [0, 10],
      };
      const resp = await fetch('https://scanner.tradingview.com/america/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error('TV ' + resp.status);
      const d = await resp.json();
      return (d.data || []).map(item => {
        const v = item.d;
        const raw = String(v[0] ?? '');
        return { ticker: raw.includes(':') ? raw.split(':')[1] : raw, name: String(v[1] ?? ''), close: v[2], changePct: v[3], volume: v[4], marketCap: v[5] };
      });
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/us/screen', async (req, res) => {
  try {
    const themeKey = req.query.theme || 'mag7';
    const preset = US_THEMES[themeKey];
    if (!preset) return res.status(400).json({ error: 'unknown theme' });
    const resp = await fetch('https://scanner.tradingview.com/america/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      body: JSON.stringify({
        markets: ['america'],
        symbols: { query: { types: [] }, tickers: [] },
        options: { lang: 'en' },
        columns: TV_FIELDS,
        filter: preset.filters,
        sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
        range: [0, 30],
      }),
    });
    if (!resp.ok) throw new Error('TV ' + resp.status);
    const data = await resp.json();
    const stocks = (data.data || []).map(item => {
      const d = item.d;
      const raw = String(d[0] ?? '');
      const ticker = raw.includes(':') ? raw.split(':')[1] : raw;
      return { ticker, name: String(d[1] ?? ticker), close: d[2], changePct: d[3], marketCap: d[4], pe: d[5],
        revGrowth: d[6] != null ? d[6]/100 : null, grossMargin: d[7] != null ? d[7]/100 : null,
        fcfMargin: d[8] != null ? d[8]/100 : null,
        rsi: d[9], adx: d[10], sma50: d[11], sma200: d[12], high52w: d[13], low52w: d[14] };
    });
    const medPe = calcMedian(stocks.map(s => s.pe));
    const p75Pe = calcP75(stocks.map(s => s.pe));
    const scored = stocks.map(s => scoreStock(s, medPe, p75Pe)).sort((a, b) => b.signal - a.signal).slice(0, 20);
    res.json({ theme: themeKey, nameZh: preset.nameZh, total: data.totalCount || 0, stocks: scored });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 个股技术指标：K线/MA/布林带/RSI/MACD
app.get('/api/stock/technical', async (req, res) => {
  const symbol = (req.query.symbol || '').replace(/[^A-Z0-9.^=\-]/gi, '').slice(0, 20);
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const cKey = 'tech:' + symbol;
  const cached = cacheGet(cKey);
  if (cached) return res.json(cached);
  try {
    const result = await yahooFinance.chart(symbol, {
      period1: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      interval: '1d'
    });
    const raw = (result.quotes || []).filter(q => q.close != null && q.open != null);
    const dates = raw.map(q => new Date(q.date).toISOString().slice(0, 10));
    const opens = raw.map(q => +q.open.toFixed(3));
    const highs = raw.map(q => +q.high.toFixed(3));
    const lows = raw.map(q => +q.low.toFixed(3));
    const closes = raw.map(q => +q.close.toFixed(3));
    const volumes = raw.map(q => q.volume || 0);

    function sma(arr, p) {
      return arr.map((_, i) => {
        if (i < p - 1) return null;
        return +(arr.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p).toFixed(3);
      });
    }
    function emaCalc(arr, p) {
      const k = 2 / (p + 1), out = new Array(arr.length).fill(null);
      let seed = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
      out[p - 1] = +seed.toFixed(4);
      for (let i = p; i < arr.length; i++) { seed = arr[i] * k + seed * (1 - k); out[i] = +seed.toFixed(4); }
      return out;
    }

    const ma20 = sma(closes, 20), ma50 = sma(closes, 50), ma200 = sma(closes, 200);
    const bb_mid = ma20;
    // Bollinger Bands — 单遍计算 upper/lower
    const bb_upper = new Array(closes.length).fill(null);
    const bb_lower = new Array(closes.length).fill(null);
    for (let i = 19; i < closes.length; i++) {
      const s = closes.slice(i - 19, i + 1);
      const m = s.reduce((a, b) => a + b, 0) / 20;
      const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
      bb_upper[i] = +(m + 2 * sd).toFixed(3);
      bb_lower[i] = +(m - 2 * sd).toFixed(3);
    }

    // RSI(14)
    const rsi = (() => {
      const out = new Array(closes.length).fill(null);
      let ag = 0, al = 0;
      for (let i = 1; i <= 14; i++) { const d = closes[i]-closes[i-1]; d>0?ag+=d:al-=d; }
      ag /= 14; al /= 14;
      out[14] = al === 0 ? 100 : +(100 - 100/(1+ag/al)).toFixed(2);
      for (let i = 15; i < closes.length; i++) {
        const d = closes[i]-closes[i-1], g = d>0?d:0, l = d<0?-d:0;
        ag = (ag*13+g)/14; al = (al*13+l)/14;
        out[i] = al === 0 ? 100 : +(100 - 100/(1+ag/al)).toFixed(2);
      }
      return out;
    })();

    // MACD(12,26,9)
    const ema12 = emaCalc(closes, 12), ema26 = emaCalc(closes, 26);
    const macdLine = ema12.map((v,i) => v!=null&&ema26[i]!=null ? +(v-ema26[i]).toFixed(4) : null);
    const validIdx = macdLine.findIndex(v => v !== null);
    const signalRaw = emaCalc(macdLine.slice(validIdx), 9);
    const signal = new Array(validIdx).fill(null).concat(signalRaw);
    const histogram = macdLine.map((v,i) => v!=null&&signal[i]!=null ? +(v-signal[i]).toFixed(4) : null);

    const data = { dates, opens, highs, lows, closes, volumes, ma20, ma50, ma200, bb_upper, bb_mid, bb_lower, rsi, macdLine, signal, histogram };
    cacheSet(cKey, data, 1800);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// A股板块详情：多周期收益 + K线 + 成分股
app.get('/api/astock/sector-detail/:code', async (req, res) => {
  try {
    const code = req.params.code.replace(/[^A-Z0-9]/gi, '').slice(0, 10);
    if (!code) return res.status(400).json({ error: 'invalid code' });

    const em = { headers: { 'Referer': 'https://finance.eastmoney.com', 'User-Agent': 'Mozilla/5.0' } };

    // beg = 100 calendar days ago ≈ 65+ trading days
    const begDate = new Date(Date.now() - 100 * 24 * 3600 * 1000);
    const beg = begDate.getFullYear() * 10000 + (begDate.getMonth()+1) * 100 + begDate.getDate();
    const klineParams = `fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&beg=${beg}&end=20500101`;
    // 并行拉：板块K线(65日) + 沪深300K线(65日) + 板块成分股
    const [klineR, hs300R, stocksR] = await Promise.allSettled([
      fetch(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.${code}&${klineParams}`, em),
      fetch(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300&${klineParams}`, em),
      fetch(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=15&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=b:${code}+f:!50&fields=f2,f3,f4,f12,f14,f6`, em)
    ]);

    // 解析板块K线
    let kline = [];
    if (klineR.status === 'fulfilled' && klineR.value.ok) {
      const d = await klineR.value.json();
      kline = (d.data?.klines || []).map(l => {
        const p = l.split(',');
        return { date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4], volume: +p[5] };
      });
    }

    // 解析沪深300K线
    let hs300 = [];
    if (hs300R.status === 'fulfilled' && hs300R.value.ok) {
      const d = await hs300R.value.json();
      hs300 = (d.data?.klines || []).map(l => { const p = l.split(','); return { date: p[0], close: +p[2] }; });
    }

    // 计算多周期收益率（用K线收盘价）
    function calcReturn(arr, days) {
      if (arr.length < 2) return null;
      const last = arr[arr.length - 1].close;
      const idx = Math.max(0, arr.length - 1 - days);
      const base = arr[idx].close;
      return base > 0 ? ((last / base - 1) * 100) : null;
    }
    const periods = [1, 5, 20, 60];
    const sectorReturns = {};
    const benchReturns = {};
    for (const d of periods) {
      sectorReturns[d + 'D'] = calcReturn(kline, d);
      benchReturns[d + 'D'] = calcReturn(hs300, d);
    }

    // 解析成分股
    let stocks = [];
    if (stocksR.status === 'fulfilled' && stocksR.value.ok) {
      const d = await stocksR.value.json();
      stocks = (d.data?.diff || []).map(s => ({
        code: s.f12, name: s.f14,
        price: s.f2 / 100, change: s.f4 / 100,
        changePercent: s.f3,
        turnover: s.f6 > 0 ? (s.f6 / 1e8).toFixed(1) : null
      }));
    }

    // 当前价和今日涨幅（取K线最后一根）
    const last = kline[kline.length - 1] || {};
    const prev = kline[kline.length - 2] || {};
    const price = last.close || 0;
    const changePercent = prev.close > 0 ? ((last.close / prev.close - 1) * 100) : null;

    res.json({ code, price, changePercent, kline, sectorReturns, benchReturns, stocks });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ AI 日报 ============

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch(e) { console.error('Telegram push failed:', e.message); }
}

async function generateDailyReport(type) {
  // 收集市场数据
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', { month:'2-digit', day:'2-digit', weekday:'short' });
  const timeStr = now.toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', hour12:false });

  let marketSummary = '';
  try {
    const [goldR, sinaR, fearR, rateR] = await Promise.allSettled([
      fetch('https://api.gold-api.com/price/XAU').then(r=>r.json()),
      fetch('https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f12,f14&secids=1.000001,0.399001,1.000300,0.399006&ut=bd1d9ddb04089700cf9c27f6f7426281', { headers:{ 'Referer':'https://finance.eastmoney.com' } }).then(r=>r.json()),
      fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata').then(r=>r.json()),
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDCNY=X?range=1d&interval=1d').then(r=>r.json())
    ]);

    const gold = goldR.status==='fulfilled' ? goldR.value : null;
    const sina = sinaR.status==='fulfilled' ? (sinaR.value?.data?.diff||[]) : [];
    const fear = fearR.status==='fulfilled' ? fearR.value?.fear_and_greed : null;
    const rate = rateR.status==='fulfilled' ? rateR.value?.chart?.result?.[0]?.meta?.regularMarketPrice : null;

    if (gold?.price) marketSummary += `• 黄金: $${gold.price.toFixed(2)}/盎司\n`;
    if (rate) marketSummary += `• 美元/人民币: ${rate.toFixed(4)}\n`;
    if (fear?.score != null) marketSummary += `• 恐惧贪婪指数: ${Math.round(fear.score)} (${fear.rating})\n`;
    sina.forEach(s => {
      const name = {'000001':'上证','399001':'深成','000300':'沪深300','399006':'创业板'}[String(s.f12)] || s.f14;
      const pct = (s.f3||0);
      if (s.f12 && ['000001','000300'].includes(String(s.f12))) {
        marketSummary += `• ${s.f14}: ${(s.f2/100).toFixed(2)} (${pct>0?'+':''}${pct.toFixed(2)}%)\n`;
      }
    });
  } catch(e) { console.warn('[DailyReport] 市场数据采集失败:', e.message); }

  const typeLabel = type === 'morning' ? '📊 盘前日报' : '📈 盘后复盘';
  const prompt = type === 'morning'
    ? `你是一位专业的金融分析师。今天是${dateStr}，现在是${timeStr}，A股即将开盘。请根据以下市场数据，给出一份简洁的盘前分析（200字以内），重点分析黄金走势和对A股的影响，以及今日值得关注的风险点。\n\n市场数据：\n${marketSummary}\n\n请用中文，分析要简洁专业，末尾给出今日操作建议（1-2句话）。`
    : `你是一位专业的金融分析师。今天是${dateStr}，A股已收盘。请根据以下市场数据，给出一份简洁的盘后复盘（200字以内），总结今日市场表现，分析明日走势预判。\n\n市场数据：\n${marketSummary}\n\n请用中文，分析要简洁专业，末尾给出明日布局建议（1-2句话）。`;

  if (!DEEPSEEK_API_KEY) return null;
  try {
    const aiResp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 500
      })
    });
    const aiData = await aiResp.json();
    const content = aiData?.choices?.[0]?.message?.content || '';
    return { type, dateStr, timeStr, marketSummary, content };
  } catch(e) { console.error('AI report error:', e.message); return null; }
}

app.post('/api/daily-report/generate', async (req, res) => {
  try {
    const type = req.body?.type || 'morning';
    const report = await generateDailyReport(type);
    if (!report) return res.status(500).json({ error: 'AI 生成失败' });
    // 推送 Telegram
    const typeLabel = type === 'morning' ? '📊 盘前日报' : '📈 盘后复盘';
    const msg = `<b>${typeLabel} ${report.dateStr} ${report.timeStr}</b>\n\n<b>市场数据</b>\n${report.marketSummary}\n<b>AI 分析</b>\n${report.content}`;
    await sendTelegram(msg);
    res.json({ success: true, report });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 定时任务：工作日 9:00 盘前、16:00 盘后（中国时间 UTC+8）
cron.schedule('0 1 * * 1-5', async () => { // UTC 1:00 = CST 9:00 Mon-Fri
  console.log('Running morning report...');
  const report = await generateDailyReport('morning');
  if (report) {
    const msg = `<b>📊 盘前日报 ${report.dateStr} 09:00</b>\n\n<b>市场数据</b>\n${report.marketSummary}\n<b>AI 分析</b>\n${report.content}`;
    await sendTelegram(msg);
  }
}, { timezone: 'Asia/Shanghai' });

cron.schedule('0 8 * * 1-5', async () => { // UTC 8:00 = CST 16:00 Mon-Fri
  console.log('Running afternoon report...');
  const report = await generateDailyReport('afternoon');
  if (report) {
    const msg = `<b>📈 盘后复盘 ${report.dateStr} 16:00</b>\n\n<b>市场数据</b>\n${report.marketSummary}\n<b>AI 分析</b>\n${report.content}`;
    await sendTelegram(msg);
  }
}, { timezone: 'Asia/Shanghai' });

// ============ ML 量化预测 (⑨) ============
app.post('/api/ml/predict', (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: '需要股票代码' });
  const scriptPath = path.join(__dirname, 'ml_predict.py');
  execFile('/usr/bin/python3', [scriptPath, symbol], { timeout: 60000, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[ML]', err.message, stderr?.slice(0, 300));
      return res.status(500).json({ error: err.message });
    }
    try {
      res.json(JSON.parse(stdout.trim()));
    } catch(e) {
      res.status(500).json({ error: 'Python 输出解析失败', raw: stdout.slice(0, 200) });
    }
  });
});

// ============ 深度研究报告 ============

// 初始化 research_reports 表
db.exec(`
  CREATE TABLE IF NOT EXISTS research_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    name TEXT,
    market TEXT,
    created_at INTEGER,
    data_json TEXT,
    ai_json TEXT
  );
`);

// DeepSeek 也用于深度研究报告（reasoner 模型质量更好）
const PYTHON_BIN = '/usr/bin/python3';
const RESEARCH_PY = path.join(__dirname, 'research_data.py');

// POST /api/research/generate
app.post('/api/research/generate', async (req, res) => {
  const { symbol, market } = req.body;
  if (!symbol || !market) return res.status(400).json({ error: '缺少 symbol 或 market 参数' });

  try {
    // Step 1: 运行 Python 采集数据
    const dataJson = await new Promise((resolve, reject) => {
      execFile(PYTHON_BIN, [RESEARCH_PY, symbol.trim(), market.trim()], {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Python执行失败: ${err.message}`));
        try {
          const d = JSON.parse(stdout.trim());
          if (d.error && !d.name) return reject(new Error(d.error));
          resolve(d);
        } catch(e) {
          reject(new Error('Python输出解析失败: ' + stdout.slice(0, 300)));
        }
      });
    });

    // Step 2: 调用 AI 生成分析
    const dataStr = JSON.stringify(dataJson).slice(0, 8000);
    const prompt = `你是专业股票分析师。以下是一只股票的完整数据，请基于数据生成一份深度研究分析报告。

股票数据：
${dataStr}

请严格按以下JSON格式返回，不要有任何其他内容，不要有markdown代码块标记：
{
  "summary": "执行摘要，约200字，概述公司基本面、技术面和投资逻辑",
  "rating": "推荐",
  "rating_score": 4,
  "company_overview": "公司概述，约150字，介绍主营业务、市场地位、核心竞争力",
  "competitive_analysis": "竞争格局分析，约150字，分析行业竞争格局、公司竞争优势和劣势",
  "risks": ["风险点1（约30字）", "风险点2（约30字）", "风险点3（约30字）", "风险点4（约30字）"],
  "risk_matrix": [
    {"factor": "风险因素1", "probability": "中", "impact": "高"},
    {"factor": "风险因素2", "probability": "低", "impact": "中"},
    {"factor": "风险因素3", "probability": "高", "impact": "中"},
    {"factor": "风险因素4", "probability": "低", "impact": "高"}
  ],
  "target_price": 0.0,
  "position_advice": "建议配置5%-10%仓位，分批建仓",
  "risk_reward_ratio": 2.0,
  "conclusion": "综合结论，约100字"
}

rating必须是以下之一：强力推荐、推荐、中性、减持、强力减持
rating_score：强力推荐=5，推荐=4，中性=3，减持=2，强力减持=1
target_price：基于当前价格和基本面给出合理目标价（数字）
risk_reward_ratio：风险收益比（如2.5表示潜在收益是风险的2.5倍）`;

    const aiResp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是专业股票分析师，严格按JSON格式输出，不添加任何额外文字和markdown代码块。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 3000,
        response_format: { type: 'json_object' }
      })
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      throw new Error(`AI API错误: ${aiResp.status} ${errText.slice(0, 200)}`);
    }

    const aiData = await aiResp.json();
    let aiContent = aiData.choices?.[0]?.message?.content || '';
    // 清理可能的 markdown 代码块
    aiContent = aiContent.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    // 清理 think 标签
    aiContent = aiContent.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    // 提取 JSON
    const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI返回内容无法解析为JSON');
    const aiJson = JSON.parse(jsonMatch[0]);

    // Step 3: 存入 SQLite
    const now = Date.now();
    const stmt = db.prepare('INSERT INTO research_reports (symbol, name, market, created_at, data_json, ai_json) VALUES (?, ?, ?, ?, ?, ?)');
    const insertResult = stmt.run(
      dataJson.symbol || symbol,
      dataJson.name || symbol,
      market,
      now,
      JSON.stringify(dataJson),
      JSON.stringify(aiJson)
    );

    res.json({
      id: insertResult.lastInsertRowid,
      symbol: dataJson.symbol || symbol,
      name: dataJson.name || symbol,
      market,
      created_at: now,
      data: dataJson,
      ai: aiJson
    });

  } catch (e) {
    console.error('[Research] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/research/list
app.get('/api/research/list', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, symbol, name, market, created_at FROM research_reports ORDER BY created_at DESC LIMIT 50').all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/research/:id
app.get('/api/research/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM research_reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '报告不存在' });
    res.json({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      market: row.market,
      created_at: row.created_at,
      data: JSON.parse(row.data_json),
      ai: JSON.parse(row.ai_json)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/research/:id
app.delete('/api/research/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM research_reports WHERE id = ?').run(req.params.id);
    res.json({ ok: true, deleted: info.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 加密货币 ============

app.get('/api/crypto/market', async (req, res) => {
  try {
    const ttl = getTTL(60, 300);
    const data = await withCache('crypto:market', ttl, async () => {
      const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h,7d';
      const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('CoinGecko ' + r.status);
      return await r.json();
    });
    res.json(data || []);
  } catch(e) {
    console.error('[Crypto Market]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/crypto/global', async (req, res) => {
  try {
    const ttl = getTTL(120, 600);
    const data = await withCache('crypto:global', ttl, async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/global', { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('CoinGecko global ' + r.status);
      return (await r.json()).data;
    });
    res.json(data || {});
  } catch(e) {
    console.error('[Crypto Global]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/crypto/fng', async (req, res) => {
  try {
    const data = await withCache('crypto:fng', 3600, async () => {
      const r = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('FNG ' + r.status);
      const j = await r.json();
      return j.data?.[0] || null;
    });
    res.json(data || { value: '50', value_classification: 'Neutral' });
  } catch(e) {
    res.json({ value: '50', value_classification: 'Neutral' });
  }
});

// 快照状态查询
app.get('/api/snapshot/status', (req, res) => {
  const rows = db.prepare('SELECT date, type, updated_at FROM market_snapshot ORDER BY date DESC, type').all();
  const dates = {};
  for (const r of rows) {
    if (!dates[r.date]) dates[r.date] = {};
    dates[r.date][r.type] = r.updated_at;
  }
  res.json({
    latestDate: rows[0]?.date || null,
    totalSnapshots: rows.length,
    isTrading: isAStockTrading(),
    isLunchBreak: isAStockLunchBreak(),
    isOpen: isAStockOpen(),
    dates
  });
});

// 手动触发快照保存
app.post('/api/snapshot/save', async (req, res) => {
  const date = getCSTDateStr();
  const types = [
    { key: 'astock_indices', url: '/api/astock/indices' },
    { key: 'astock_market-stats', url: '/api/astock/market-stats' },
    { key: 'astock_sectors', url: '/api/astock/sectors' },
    { key: 'astock_limit', url: '/api/astock/limit' },
    { key: 'astock_northbound', url: '/api/astock/northbound' },
    { key: 'astock_capitalflow_1', url: '/api/astock/capitalflow?type=inflow' },
    { key: 'astock_capitalflow_0', url: '/api/astock/capitalflow?type=outflow' },
    { key: 'astock_trends_1.000001', url: '/api/astock/trends?secid=1.000001' },
    { key: 'astock_trends_0.399001', url: '/api/astock/trends?secid=0.399001' },
    { key: 'astock_trends_1.000300', url: '/api/astock/trends?secid=1.000300' },
    { key: 'astock_trends_0.399006', url: '/api/astock/trends?secid=0.399006' },
    { key: 'us_indices', url: '/api/us/indices' },
    { key: 'us_sectors', url: '/api/us/sectors' },
    { key: 'us_movers_gainers', url: '/api/us/movers?type=gainers' },
    { key: 'us_movers_losers', url: '/api/us/movers?type=losers' },
    { key: 'us_movers_active', url: '/api/us/movers?type=active' },
  ];
  let saved = 0;
  for (const t of types) {
    try {
      const data = await fetch('http://localhost:3000' + t.url).then(r => r.json());
      if (data) { snapshotSave(date, t.key, data); saved++; }
    } catch(e) { console.warn('[Snapshot]', t.key, e.message); }
  }
  res.json({ date, saved, total: types.length });
});

// ============ 数据预热 Cron ============
// 收盘快照保存 (15:05 CST = 07:05 UTC)
cron.schedule('5 7 * * 1-5', async () => {
  console.log('[Snapshot] Saving end-of-day snapshots...');
  const date = getCSTDateStr();
  const snapshotTypes = [
    { key: 'astock_indices', fn: () => fetch('http://localhost:3000/api/astock/indices').then(r => r.json()) },
    { key: 'astock_market-stats', fn: () => fetch('http://localhost:3000/api/astock/market-stats').then(r => r.json()) },
    { key: 'astock_sectors', fn: () => fetch('http://localhost:3000/api/astock/sectors').then(r => r.json()) },
    { key: 'astock_limit', fn: () => fetch('http://localhost:3000/api/astock/limit').then(r => r.json()) },
    { key: 'astock_northbound', fn: () => fetch('http://localhost:3000/api/astock/northbound').then(r => r.json()) },
    { key: 'astock_capitalflow_1', fn: () => fetch('http://localhost:3000/api/astock/capitalflow?type=inflow').then(r => r.json()) },
    { key: 'astock_capitalflow_0', fn: () => fetch('http://localhost:3000/api/astock/capitalflow?type=outflow').then(r => r.json()) },
    { key: 'astock_trends_1.000001', fn: () => fetch('http://localhost:3000/api/astock/trends?secid=1.000001').then(r => r.json()) },
    { key: 'astock_trends_0.399001', fn: () => fetch('http://localhost:3000/api/astock/trends?secid=0.399001').then(r => r.json()) },
    { key: 'astock_trends_1.000300', fn: () => fetch('http://localhost:3000/api/astock/trends?secid=1.000300').then(r => r.json()) },
    { key: 'astock_trends_0.399006', fn: () => fetch('http://localhost:3000/api/astock/trends?secid=0.399006').then(r => r.json()) },
  ];
  let saved = 0;
  for (const s of snapshotTypes) {
    try {
      const data = await s.fn();
      if (data) { snapshotSave(date, s.key, data); saved++; }
    } catch(e) { console.warn('[Snapshot]', s.key, e.message); }
  }
  console.log('[Snapshot] Done:', saved + '/' + snapshotTypes.length);
}, { timezone: 'Asia/Shanghai' });

// 美股收盘快照保存 (04:05 CST = 20:05 UTC)
cron.schedule('5 20 * * 1-5', async () => {
  console.log('[US Snapshot] Saving...');
  const date = getCSTDateStr();
  const types = [
    { key: 'us_indices', fn: () => fetch('http://localhost:3000/api/us/indices').then(r => r.json()) },
    { key: 'us_sectors', fn: () => fetch('http://localhost:3000/api/us/sectors').then(r => r.json()) },
    { key: 'us_movers_gainers', fn: () => fetch('http://localhost:3000/api/us/movers?type=gainers').then(r => r.json()) },
    { key: 'us_movers_losers', fn: () => fetch('http://localhost:3000/api/us/movers?type=losers').then(r => r.json()) },
    { key: 'us_movers_active', fn: () => fetch('http://localhost:3000/api/us/movers?type=active').then(r => r.json()) },
  ];
  let saved = 0;
  for (const s of types) {
    try {
      const data = await s.fn();
      if (data) { snapshotSave(date, s.key, data); saved++; }
    } catch(e) { console.warn('[US Snapshot]', s.key, e.message); }
  }
  console.log('[US Snapshot] Done:', saved + '/' + types.length);
}, { timezone: 'Asia/Shanghai' });

// SQLite 过期缓存清理（每小时）
const _cacheCleanup = db.prepare('DELETE FROM cache WHERE expires_at < ?');
cron.schedule('17 * * * *', () => {
  const deleted = _cacheCleanup.run(Date.now());
  if (deleted.changes > 0) console.log(`[Cache cleanup] 清理 ${deleted.changes} 条过期记录`);
});

// 每交易日 08:55 CST 提前预热核心数据 (UTC 00:55)
cron.schedule('55 0 * * 1-5', async () => {
  console.log('[Pre-warm] Starting...');
  try {
    await Promise.allSettled([
      withCache('price:gold', 300, () => fetch('https://api.gold-api.com/price/XAU').then(r => r.json())),
      withCache('price:silver', 300, () => fetch('https://api.gold-api.com/price/XAG').then(r => r.json())),
      withCache('quotes:' + ['^GSPC','^IXIC','^VIX','GC=F','SI=F','CL=F','DX-Y.NYB'].sort().join(','), 120, async () => {
        const r = await yahooFinance.quote(['^GSPC','^IXIC','^VIX','GC=F','SI=F','CL=F','DX-Y.NYB']);
        return { quoteResponse: { result: Array.isArray(r) ? r : [r] } };
      }),
    ]);
    console.log('[Pre-warm] Done');
  } catch(e) { console.error('[Pre-warm] Error:', e.message); }
}, { timezone: 'Asia/Shanghai' });

const server = app.listen(PORT, () => {
  console.log(`\n🏆 小猪猪财经看板已启动: http://localhost:${PORT}\n`);
});

// 优雅退出：关闭 HTTP + SQLite
function gracefulShutdown(signal) {
  console.log(`\n[${signal}] 正在关闭...`);
  server.close(() => {
    db.close();
    console.log('SQLite 连接已关闭，进程退出');
    process.exit(0);
  });
  setTimeout(() => { db.close(); process.exit(1); }, 5000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
