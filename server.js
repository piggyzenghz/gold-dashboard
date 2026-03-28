require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const app = express();
const PORT = 3000;

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

app.use(express.static(__dirname));
app.use(express.json());

// ============ 黄金价格 ============

app.get('/api/gold', async (req, res) => {
  try {
    const resp = await fetch('https://api.gold-api.com/price/XAU');
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    const results = await yahooFinance.quote(symbols);
    res.json({ quoteResponse: { result: Array.isArray(results) ? results : [results] } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 新浪 A股实时行情 ============

app.get('/api/sina', async (req, res) => {
  try {
    const codes = req.query.codes || 's_sh000001,s_sh000300';
    const url = `https://hq.sinajs.cn/list=${codes}`;
    const resp = await fetch(url, {
      headers: {
        'Referer': 'https://finance.sina.com.cn',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      }
    });
    const buffer = await resp.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buffer);
    const results = {};
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      const match = line.match(/var hq_str_(.+?)="(.+?)"/);
      if (match) {
        const code = match[1];
        const parts = match[2].split(',');
        results[code] = {
          name: parts[0],
          price: parseFloat(parts[1]),
          change: parseFloat(parts[2]),
          changePercent: parseFloat(parts[3]),
          volume: parts[4],
          turnover: parts[5]
        };
      }
    }
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 新闻 ============

app.get('/api/news', async (req, res) => {
  try {
    const category = req.query.category || 'finance';
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
    res.json(articles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 白银价格 ============

app.get('/api/silver', async (req, res) => {
  try {
    const resp = await fetch('https://api.gold-api.com/price/XAG');
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 汇率 ============

app.get('/api/exchange-rate', async (req, res) => {
  try {
    const result = await yahooFinance.quote('CNY=X');
    res.json({ rate: result.regularMarketPrice, name: 'USD/CNY' });
  } catch (e) {
    res.status(500).json({ error: e.message, rate: 7.25 });
  }
});

// ============ 恐惧贪婪指数 ============

app.get('/api/fear-greed', async (req, res) => {
  try {
    const resp = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
    });
    const data = await resp.json();
    const score = data.fear_and_greed?.score;
    const rating = data.fear_and_greed?.rating;
    const previous = data.fear_and_greed_historical?.previous_close;
    res.json({ score: Math.round(score), rating, previousClose: Math.round(previous) });
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

let macroLiveCache = null;
let macroLiveCacheAt = 0;
const MACRO_LIVE_TTL = 15 * 60 * 1000; // 15分钟缓存

app.get('/api/macro/live', async (req, res) => {
  if (macroLiveCache && Date.now() - macroLiveCacheAt < MACRO_LIVE_TTL) {
    return res.json(macroLiveCache);
  }
  try {
    // G8主要货币汇率 + 关键债券收益率
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
    macroLiveCache = { fx, yields, updatedAt: new Date().toISOString() };
    macroLiveCacheAt = Date.now();
    res.json(macroLiveCache);
  } catch(e) {
    // 如有缓存则返回旧缓存
    if (macroLiveCache) return res.json(macroLiveCache);
    res.status(500).json({ error: e.message });
  }
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

// ============ AI 分析 (MiniMax M2.7) ============

app.post('/api/ai/analyze', async (req, res) => {
  try {
    const { marketData, newsData } = req.body;

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

    const resp = await fetch('https://api.minimax.chat/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MINIMAX_API_KEY}`
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        messages: [
          { role: 'system', content: '你是一位专业的黄金市场分析师，擅长从宏观经济数据和市场联动关系中分析黄金走势。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_completion_tokens: 2048,
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
    const { marketSummary } = req.body;

    // 用管道分隔格式代替 JSON，彻底避免 AI 在描述文字中输出未转义引号导致解析崩溃
    const prompt = `你是专业黄金分析师。根据以下市场数据，给出黄金近期（1-2周）走势的三种情景预测。

市场数据：
${marketSummary}

请严格按以下格式输出三行，每行用 | 分隔，不要有任何其他内容：
BULL|情景标题|概率(整数%)|目标价位区间|80字以内分析
NEUTRAL|情景标题|概率(整数%)|目标价位区间|80字以内分析
BEAR|情景标题|概率(整数%)|目标价位区间|80字以内分析

要求：三行概率之和=100；分析文字不要使用竖线符号"|"。`;

    const resp = await fetch('https://api.minimax.chat/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MINIMAX_API_KEY}` },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        messages: [
          { role: 'system', content: '你是专业黄金分析师，严格按用户要求的格式输出，不添加任何额外文字。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.6,
        max_completion_tokens: 600,
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

// 六大指数
app.get('/api/astock/indices', async (req, res) => {
  try {
    const codes = 's_sh000001,s_sz399001,s_sh000300,s_sz399006,s_sh000688,s_sh000016';
    const url = `https://hq.sinajs.cn/list=${codes}`;
    const resp = await fetch(url, { headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    const buffer = await resp.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buffer);
    const results = {};
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      const match = line.match(/var hq_str_(.+?)="(.+?)"/);
      if (match) {
        const parts = match[2].split(',');
        results[match[1]] = {
          name: parts[0], price: parseFloat(parts[1]),
          change: parseFloat(parts[2]), changePercent: parseFloat(parts[3]),
          volume: parseInt(parts[4]) || 0, turnover: parseFloat(parts[5]) || 0
        };
      }
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 申万行业板块涨跌
app.get('/api/astock/sectors', async (req, res) => {
  try {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50&fields=f2,f3,f4,f12,f14';
    const resp = await fetch(url, { headers: { 'Referer': 'https://finance.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    const data = await resp.json();
    res.json((data.data?.diff || []).map(i => ({ code: i.f12, name: i.f14, changePercent: i.f3, price: i.f2 / 100, change: i.f4 / 100 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 市场统计（涨跌家数、成交额）
app.get('/api/astock/market-stats', async (req, res) => {
  try {
    const url = 'https://push2.eastmoney.com/api/qt/stock/get?ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&secid=1.000001&fields=f117,f163,f164,f165,f166,f167,f168';
    const resp = await fetch(url, { headers: { 'Referer': 'https://quote.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    const data = await resp.json();
    const d = data.data || {};
    const n = v => (typeof v === 'number' ? v : 0);
    res.json({ limitUp: n(d.f163), advance: n(d.f164), decline: n(d.f165), flat: n(d.f166), limitDown: n(d.f167), turnover: n(d.f168) / 1e8 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 北向资金
app.get('/api/astock/northbound', async (req, res) => {
  try {
    const url = 'https://push2.eastmoney.com/api/qt/kamt/get?ut=bd1d9ddb04089700cf9c27f6f7426281&fields=f1,f2,f3,f4,f5,f6,f7,f8';
    const resp = await fetch(url, { headers: { 'Referer': 'https://data.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    const data = await resp.json();
    const sh = (data.data?.f2 || 0) / 1e8;
    const sz = (data.data?.f4 || 0) / 1e8;
    res.json({ sh, sz, total: sh + sz });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 行业资金流向（替代热门股票，24h可用）
app.get('/api/astock/capitalflow', async (req, res) => {
  try {
    const po = req.query.type === 'outflow' ? 0 : 1; // 1=流入降序，0=流出升序
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=12&po=${po}&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f62&fs=m:90+t:2+f:!50&fields=f12,f14,f62,f184,f3`;
    const resp = await fetch(url, { headers: { 'Referer': 'https://data.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    const data = await resp.json();
    const toNum = v => typeof v === 'number' ? v : 0;
    res.json((data.data?.diff || []).map(i => ({
      code: i.f12, name: i.f14,
      netFlow: toNum(i.f62) / 1e8,   // 净流入/出（亿元）
      pct: toNum(i.f184),             // 主力占比(%)
      changePercent: toNum(i.f3)      // 今日涨跌幅
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 涨跌停板（使用龙虎榜数据，收盘后仍可用）
app.get('/api/astock/limit', async (req, res) => {
  try {
    // 获取最新交易日的龙虎榜个股（包含涨跌幅），取前200条
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_PROFILE&columns=ALL&pageNumber=1&pageSize=200&sortTypes=-1,-1&sortColumns=TRADE_DATE,CHANGE_RATE&source=WEB&client=WEB';
    const resp = await fetch(url, { headers: { 'Referer': 'https://data.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    const data = await resp.json();
    const items = data.result?.data || [];
    const map = i => ({ code: i.SECURITY_CODE, name: i.SECURITY_NAME_ABBR, changePercent: i.CHANGE_RATE || 0, netAmt: (i.BILLBOARD_NET_AMT || 0) / 1e8 });
    const limitUp = items.filter(i => (i.CHANGE_RATE || 0) >= 9.9).map(map);
    const limitDown = items.filter(i => (i.CHANGE_RATE || 0) <= -9.9).map(map);
    const tradeDate = items[0]?.TRADE_DATE?.split(' ')[0] || '';
    res.json({ limitUp, limitDown, upCount: limitUp.length, downCount: limitDown.length, date: tradeDate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 龙虎榜
app.get('/api/astock/dragon-tiger', async (req, res) => {
  try {
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BILLBOARD_TRADEALLNEW&columns=ALL&pageNumber=1&pageSize=20&sortTypes=-1,-1&sortColumns=LATEST_TDATE,SECURITY_CODE&source=WEB&client=WEB';
    const resp = await fetch(url, { headers: { 'Referer': 'https://data.eastmoney.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    const data = await resp.json();
    // 去重（同一个股可能多次上榜），只保留每只股的最新记录
    const seen = new Set();
    const items = [];
    for (const i of (data.result?.data || [])) {
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
    res.json(items);
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
    const url = 'https://hq.sinajs.cn/list=' + sinaList;
    const resp = await fetch(url, { headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' } });
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const results = [];
    for (const line of text.trim().split('\n')) {
      const m = line.match(/hq_str_(\w+)="(.+)"/);
      if (!m) continue;
      const code = m[1].replace(/^(sh|sz)/, '');
      const f = m[2].split(',');
      if (!f[3] || !parseFloat(f[3])) continue; // 停牌/无数据
      const price = parseFloat(f[3]);
      const prevClose = parseFloat(f[2]);
      const change = price - prevClose;
      results.push({
        code, name: f[0],
        price, prevClose, change,
        changePercent: prevClose > 0 ? (change / prevClose) * 100 : 0,
        open: parseFloat(f[1]), high: parseFloat(f[4]), low: parseFloat(f[5]),
        volume: Math.round(parseFloat(f[8]) / 100), // 手→股, 再转手
        amount: parseFloat(f[9]),
        time: f[31] || '',
      });
    }
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
      const text = new TextDecoder('gbk').decode(buf);
      const m = text.match(/hq_str_(\w+)="(.+)"/);
      if (m) {
        const f = m[2].split(',');
        if (f[3] && parseFloat(f[3])) {
          const price = parseFloat(f[3]);
          const prevClose = parseFloat(f[2]);
          const change = price - prevClose;
          quote = {
            code, name: f[0], price, prevClose, change,
            changePercent: prevClose > 0 ? (change / prevClose) * 100 : 0,
            open: parseFloat(f[1]), high: parseFloat(f[4]), low: parseFloat(f[5]),
            volume: Math.round(parseFloat(f[8]) / 100),
            amount: parseFloat(f[9]),
            time: f[31] || '',
          };
        }
      }
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
        const sigs = computeSignals(s, 20, 40);
        const total = Object.values(sigs).reduce((a, b) => a + b, 0);
        fundamentals = { ...s, sigs, signal: total, rating: getSignalRating(total) };
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

    const scored = stocks.map(s => {
      const sigs = computeSignals(s, medPe, p75Pe);
      const total = Object.values(sigs).reduce((a, b) => a + b, 0);
      return { ...s, sigs, signal: total, rating: getSignalRating(total) };
    }).sort((a, b) => b.signal - a.signal).slice(0, 20);

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
    const symbols = US_INDICES.map(i => i.symbol);
    const results = await yahooFinance.quote(symbols);
    const arr = Array.isArray(results) ? results : [results];
    const nameMap = Object.fromEntries(US_INDICES.map(i => [i.symbol, i.name]));
    res.json(arr.map(q => ({
      symbol: q.symbol, name: nameMap[q.symbol] || q.symbol,
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent, prevClose: q.regularMarketPreviousClose,
      marketState: q.marketState,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/us/sectors', async (req, res) => {
  try {
    const symbols = US_SECTOR_ETFS.map(s => s.symbol);
    const results = await yahooFinance.quote(symbols);
    const arr = Array.isArray(results) ? results : [results];
    const nameMap = Object.fromEntries(US_SECTOR_ETFS.map(s => [s.symbol, s.name]));
    res.json(arr.map(q => ({
      symbol: q.symbol, name: nameMap[q.symbol] || q.symbol,
      price: q.regularMarketPrice, changePercent: q.regularMarketChangePercent,
    })));
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
            const sigs = computeSignals(s, 25, 50);
            const total = Object.values(sigs).reduce((a, b) => a + b, 0);
            fundamentals = { ...s, sigs, signal: total, rating: getSignalRating(total) };
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
    const data = await resp.json();
    res.json((data.data || []).map(item => {
      const d = item.d;
      const raw = String(d[0] ?? '');
      return { ticker: raw.includes(':') ? raw.split(':')[1] : raw, name: String(d[1] ?? ''), close: d[2], changePct: d[3], volume: d[4], marketCap: d[5] };
    }));
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
    const scored = stocks.map(s => {
      const sigs = computeSignals(s, medPe, p75Pe);
      const total = Object.values(sigs).reduce((a, b) => a + b, 0);
      return { ...s, sigs, signal: total, rating: getSignalRating(total) };
    }).sort((a, b) => b.signal - a.signal).slice(0, 20);
    res.json({ theme: themeKey, nameZh: preset.nameZh, total: data.totalCount || 0, stocks: scored });
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
  } catch(e) {}

  const typeLabel = type === 'morning' ? '📊 盘前日报' : '📈 盘后复盘';
  const prompt = type === 'morning'
    ? `你是一位专业的金融分析师。今天是${dateStr}，现在是${timeStr}，A股即将开盘。请根据以下市场数据，给出一份简洁的盘前分析（200字以内），重点分析黄金走势和对A股的影响，以及今日值得关注的风险点。\n\n市场数据：\n${marketSummary}\n\n请用中文，分析要简洁专业，末尾给出今日操作建议（1-2句话）。`
    : `你是一位专业的金融分析师。今天是${dateStr}，A股已收盘。请根据以下市场数据，给出一份简洁的盘后复盘（200字以内），总结今日市场表现，分析明日走势预判。\n\n市场数据：\n${marketSummary}\n\n请用中文，分析要简洁专业，末尾给出明日布局建议（1-2句话）。`;

  if (!MINIMAX_API_KEY) return null;
  try {
    const aiResp = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'MiniMax-M2',
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

app.listen(PORT, () => {
  console.log(`\n🏆 小猪猪财经看板已启动: http://localhost:${PORT}\n`);
});
