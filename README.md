# 小猪猪财经看板

> 个人全市场实时监控面板，覆盖黄金/大宗商品、宏观经济、A股、美股，支持 AI 资讯分析、个股技术图表、自选股管理等功能。

**当前版本：v1.7.1**

---

## 功能模块

### 行情总览
- 黄金 / 白银 / WTI 原油 / 美元指数 / 标普500 / 纳斯达克 / 日经225 / 上证指数 实时报价
- 市场恐惧贪婪指数仪表盘
- 金银比仪表盘
- 多资产 K 线对比图（支持 1D / 1W / 1M / 3M / 1Y / 5Y）
- 黄金历史价格区间分析

### 宏观经济
- 美国 / 中国 / 欧元区 / 日本 主要宏观指标（GDP / CPI / 利率 / 失业率 / PMI）
- 实时汇率 & 国债收益率面板
- **黄金核心驱动因子**：实际利率 / VIX / 美元指数 / 铜金比
- **黄金避险情绪指数**：弧形仪表盘 + 三维子指标（VIX / 实际利率 / 美元动量）
- **黄金 ETF 持仓动向**：GLD / IAU 实时 AUM、52 周位置
- **全球央行黄金储备**：前 10 央行持仓排行（世界黄金协会数据）

### AI 资讯
- 每日黄金市场 AI 综合分析（MiniMax M2.7 驱动）
- 宏观情景推演：衰退 / 滞胀 / 软着陆 / 地缘危机 四大场景下金价走势分析
- 黄金综合评分雷达（趋势 / 动量 / 情绪 / 避险 / 估值 / 技术 六维）+ 进度条详情
- 全球财经热点新闻聚合（金融 / 政治 / 国际）

### A 股
- 六大指数实时行情（上证 / 深成 / 沪深300 / 创业板 / 科创50 / 上证50）
- 热门板块热力图（点击查看板块详情）
  - 多周期收益（1D / 5D / 20D / 60D）vs 沪深300超额收益
  - 板块 K 线走势
  - 板块成分股涨幅排行
- 自选股（本地存储，支持搜索添加，实时刷新）
- 涨停板雷达（实时涨停股 + 原因标签）
- 龙虎榜（机构/游资资金流向）
- 主题选股（TradingView 6 维量化信号：估值/成长/利润/趋势/动量/形态）
- 北向资金实时净流入
- 市场宽度指标（涨跌家数、涨停数）
- 申万行业资金流向排行

### 美股
- 六大指数（SPY / QQQ / DIA / IWM / VIX / TNX）实时行情
- SPDR 11 个行业 ETF 热力图（点击查看 ETF 详情 + 前10大持仓）
- 自选股（支持搜索任意美股代码）
- 涨跌幅榜 / 成交额榜（实时）
- 主题选股（科技 / 能源 / 金融 / 医疗 / 消费等）

### 个股详情面板（A股 & 美股通用）
- 实时价格、OHLCV
- 历史 K 线（5日内 / 月 / 季 / 年 / 5年）
- **技术分析图表**（右侧面板）：K 线 + MA20/50/200 + 成交量、布林带(20,2)、RSI(14)、MACD(12,26,9)
- 基本面指标（PE / PB / 市值 / 营收 / 净利润 / ROE / 毛利率）
- 同业对比
- 6 维量化信号评分
- 一键添加/移出自选股

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 前端 | 原生 HTML + CSS + JS，ECharts 6 |
| 后端 | Node.js 18+ + Express |
| 数据库 | better-sqlite3（本地缓存 + 配置同步） |
| 数据源 | Yahoo Finance（美股/黄金/宏观）/ 东方财富 API（A股）/ Sina 财经（A股实时）/ TradingView Scanner |
| AI | MiniMax M2.7（资讯分析）|

---

## 本地部署

```bash
git clone https://github.com/piggyzenghz/gold-dashboard.git
cd gold-dashboard
npm install
node server.js
# 浏览器访问 http://localhost:3000
```

---

## NAS / 服务器部署

```bash
git clone https://github.com/piggyzenghz/gold-dashboard.git
cd gold-dashboard
npm install
nohup node server.js > server.log 2>&1 &
```

**推荐用 PM2 常驻：**

```bash
npm install -g pm2
pm2 start server.js --name gold-dashboard
pm2 save && pm2 startup
```

**更新：**

```bash
cd gold-dashboard && git pull && pm2 restart gold-dashboard
```

---

## 环境要求

- Node.js 18+
- 端口 3000（可在 `server.js` 顶部修改 `PORT`）
- 需要能访问外网（Yahoo Finance、TradingView Scanner 等）
