#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
research_data.py - 股票深度研究数据采集脚本
用法: python research_data.py <symbol> <market>
market: cn (A股) 或 us (美股)
输出: JSON to stdout
"""

import sys
import json
import traceback
from datetime import datetime, timedelta

import pandas as pd
import numpy as np

def safe(fn, default=None):
    try:
        v = fn()
        if v is None:
            return default
        if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
            return default
        return v
    except:
        return default

def calc_ma(series, period):
    return safe(lambda: round(float(series.rolling(period).mean().iloc[-1]), 4))

def calc_rsi(series, period=14):
    try:
        delta = series.diff()
        gain = delta.clip(lower=0).rolling(period).mean()
        loss = (-delta.clip(upper=0)).rolling(period).mean()
        rs = gain / loss.replace(0, np.nan)
        rsi = 100 - (100 / (1 + rs))
        v = float(rsi.iloc[-1])
        return round(v, 2) if not (np.isnan(v) or np.isinf(v)) else None
    except:
        return None

def calc_macd(series):
    try:
        ema12 = series.ewm(span=12, adjust=False).mean()
        ema26 = series.ewm(span=26, adjust=False).mean()
        macd = ema12 - ema26
        signal = macd.ewm(span=9, adjust=False).mean()
        histogram = macd - signal
        return {
            'macd': round(float(macd.iloc[-1]), 4),
            'signal': round(float(signal.iloc[-1]), 4),
            'histogram': round(float(histogram.iloc[-1]), 4)
        }
    except:
        return {'macd': None, 'signal': None, 'histogram': None}

def calc_bollinger(series, period=20):
    try:
        ma = series.rolling(period).mean()
        std = series.rolling(period).std()
        upper = ma + 2 * std
        lower = ma - 2 * std
        return {
            'upper': round(float(upper.iloc[-1]), 4),
            'middle': round(float(ma.iloc[-1]), 4),
            'lower': round(float(lower.iloc[-1]), 4)
        }
    except:
        return {'upper': None, 'middle': None, 'lower': None}

def calc_support_resistance(df):
    try:
        closes = df['close'].dropna()
        recent = closes.tail(60)
        low = round(float(recent.min()), 2)
        high = round(float(recent.max()), 2)
        q25 = round(float(recent.quantile(0.25)), 2)
        q75 = round(float(recent.quantile(0.75)), 2)
        return {'support1': low, 'support2': q25, 'resistance1': q75, 'resistance2': high}
    except:
        return {'support1': None, 'support2': None, 'resistance1': None, 'resistance2': None}

def fetch_cn(symbol):
    import akshare as ak

    result = {
        'symbol': symbol,
        'market': 'cn',
        'name': None,
        'industry': None,
        'basic_info': {},
        'financials': [],
        'balance': [],
        'indicators': {},
        'monthly_price': [],
        'tech_indicators': {},
        'support_resistance': {},
        'peers': [],
        'peers_data': []
    }

    # 基本信息
    try:
        info_df = ak.stock_individual_info_em(symbol=symbol)
        info = dict(zip(info_df.iloc[:, 0], info_df.iloc[:, 1]))
        result['name'] = str(info.get('股票简称', info.get('名称', symbol)))
        result['industry'] = str(info.get('行业', ''))
        result['basic_info'] = {k: str(v) for k, v in info.items()}
    except:
        result['name'] = symbol
        result['industry'] = ''

    # 利润表 (近5年)
    try:
        profit_df = ak.stock_profit_sheet_by_report_em(symbol=symbol)
        profit_df = profit_df.sort_values('REPORT_DATE', ascending=False).head(5)
        rows = []
        for _, row in profit_df.iterrows():
            def g(col, r=row):
                v = r.get(col)
                if v is None or (isinstance(v, float) and np.isnan(v)):
                    return None
                try:
                    return round(float(v) / 1e8, 2)
                except:
                    return None
            rows.append({
                'period': str(row.get('REPORT_DATE', ''))[:10],
                'revenue': g('OPERATE_INCOME'),
                'net_profit': g('PARENT_NETPROFIT'),
                'eps': safe(lambda r=row: round(float(r.get('BASIC_EPS', 0) or 0), 4))
            })
        result['financials'] = rows
    except:
        pass

    # 资产负债表
    try:
        bal_df = ak.stock_balance_sheet_by_report_em(symbol=symbol)
        bal_df = bal_df.sort_values('REPORT_DATE', ascending=False).head(3)
        rows = []
        for _, row in bal_df.iterrows():
            def g(col, r=row):
                v = r.get(col)
                if v is None or (isinstance(v, float) and np.isnan(v)):
                    return None
                try:
                    return round(float(v) / 1e8, 2)
                except:
                    return None
            rows.append({
                'period': str(row.get('REPORT_DATE', ''))[:10],
                'total_assets': g('TOTAL_ASSETS'),
                'total_liabilities': g('TOTAL_LIABILITIES'),
                'equity': g('TOTAL_EQUITY'),
                'current_assets': g('TOTAL_CURRENT_ASSETS'),
                'current_liabilities': g('TOTAL_CURRENT_LIABILITIES'),
            })
        result['balance'] = rows
    except:
        pass

    # 估值指标
    try:
        ind_df = ak.stock_a_indicator_lg(symbol=symbol)
        ind_df = ind_df.sort_values('trade_date', ascending=False).head(1)
        if len(ind_df) > 0:
            row = ind_df.iloc[0]
            def gi(col):
                v = row.get(col)
                if v is None or (isinstance(v, float) and np.isnan(v)):
                    return None
                try:
                    return round(float(v), 4)
                except:
                    return None
            result['indicators'] = {
                'pe': gi('pe'),
                'pe_ttm': gi('pe_ttm'),
                'pb': gi('pb'),
                'ps': gi('ps'),
                'roe': gi('roe'),
                'date': str(row.get('trade_date', ''))
            }
    except:
        pass

    # 月K线 (近12个月)
    try:
        hist_df = ak.stock_zh_a_hist(symbol=symbol, period='monthly', adjust='qfq')
        hist_df = hist_df.tail(13)
        hist_df.columns = [c.lower().replace(' ', '_') for c in hist_df.columns]
        # 找到正确的列名
        date_col = next((c for c in hist_df.columns if '日期' in c or 'date' in c), hist_df.columns[0])
        close_col = next((c for c in hist_df.columns if '收盘' in c or 'close' in c), None)
        open_col = next((c for c in hist_df.columns if '开盘' in c or 'open' in c), None)
        high_col = next((c for c in hist_df.columns if '最高' in c or 'high' in c), None)
        low_col = next((c for c in hist_df.columns if '最低' in c or 'low' in c), None)
        vol_col = next((c for c in hist_df.columns if '成交量' in c or 'volume' in c), None)

        # 重命名以统一处理
        rename_map = {}
        if date_col: rename_map[date_col] = 'date'
        if close_col: rename_map[close_col] = 'close'
        if open_col: rename_map[open_col] = 'open'
        if high_col: rename_map[high_col] = 'high'
        if low_col: rename_map[low_col] = 'low'
        if vol_col: rename_map[vol_col] = 'volume'
        hist_df = hist_df.rename(columns=rename_map)

        monthly = []
        for _, row in hist_df.iterrows():
            monthly.append({
                'date': str(row.get('date', ''))[:10],
                'close': safe(lambda r=row: round(float(r.get('close', 0)), 2)),
                'open': safe(lambda r=row: round(float(r.get('open', 0)), 2)),
                'high': safe(lambda r=row: round(float(r.get('high', 0)), 2)),
                'low': safe(lambda r=row: round(float(r.get('low', 0)), 2)),
                'volume': safe(lambda r=row: int(r.get('volume', 0)))
            })
        result['monthly_price'] = monthly
    except Exception as e:
        pass

    # 技术指标（用yfinance补充日K）
    try:
        import yfinance as yf
        suffix = '.SZ' if symbol.startswith(('0', '3')) else '.SS'
        yf_sym = symbol + suffix
        ticker = yf.Ticker(yf_sym)
        hist = ticker.history(period='1y', interval='1d')
        if len(hist) > 60:
            closes = hist['Close']
            result['tech_indicators'] = {
                'ma5': calc_ma(closes, 5),
                'ma20': calc_ma(closes, 20),
                'ma60': calc_ma(closes, 60),
                'rsi': calc_rsi(closes),
                'macd': calc_macd(closes),
                'bollinger': calc_bollinger(closes),
                'current_price': safe(lambda: round(float(closes.iloc[-1]), 2))
            }
            df_for_sr = pd.DataFrame({'close': closes})
            result['support_resistance'] = calc_support_resistance(df_for_sr)
    except:
        pass

    # 同行业股票对比
    try:
        industry = result.get('industry', '')
        if industry:
            peer_df = ak.stock_board_industry_cons_em(symbol=industry)
            peer_df = peer_df[peer_df['代码'] != symbol].head(5)
            peers = []
            for _, row in peer_df.iterrows():
                peers.append({
                    'symbol': str(row.get('代码', '')),
                    'name': str(row.get('名称', '')),
                    'price': safe(lambda r=row: round(float(r.get('最新价', 0) or 0), 2)),
                    'change_pct': safe(lambda r=row: round(float(r.get('涨跌幅', 0) or 0), 2)),
                    'pe': safe(lambda r=row: round(float(r.get('市盈率-动态', 0) or 0), 2)),
                    'market_cap': safe(lambda r=row: round(float(r.get('总市值', 0) or 0) / 1e8, 2))
                })
            result['peers_data'] = peers
    except:
        pass

    return result


def fetch_us(symbol):
    import yfinance as yf

    result = {
        'symbol': symbol,
        'market': 'us',
        'name': None,
        'industry': None,
        'basic_info': {},
        'financials': [],
        'balance': [],
        'indicators': {},
        'monthly_price': [],
        'tech_indicators': {},
        'support_resistance': {},
        'peers': [],
        'peers_data': []
    }

    ticker = yf.Ticker(symbol)

    # 基本信息
    try:
        info = ticker.info
        result['name'] = info.get('longName') or info.get('shortName') or symbol
        result['industry'] = info.get('industry') or info.get('sector') or ''
        result['basic_info'] = {
            '公司名称': result['name'],
            '行业': result['industry'],
            '所属板块': info.get('sector', ''),
            '国家': info.get('country', ''),
            '员工数': str(info.get('fullTimeEmployees', '')),
            '市值(亿USD)': str(round(float(info.get('marketCap', 0) or 0) / 1e8, 2)),
            '网站': info.get('website', ''),
            '描述': (info.get('longBusinessSummary') or '')[:300]
        }
        result['indicators'] = {
            'pe': safe(lambda: round(float(info.get('trailingPE') or 0), 2)),
            'pe_ttm': safe(lambda: round(float(info.get('trailingPE') or 0), 2)),
            'pb': safe(lambda: round(float(info.get('priceToBook') or 0), 2)),
            'ps': safe(lambda: round(float(info.get('priceToSalesTrailing12Months') or 0), 2)),
            'roe': safe(lambda: round(float(info.get('returnOnEquity') or 0) * 100, 2)),
            'date': datetime.now().strftime('%Y-%m-%d')
        }
    except:
        result['name'] = symbol

    # 财务数据
    try:
        fin = ticker.financials
        if fin is not None and not fin.empty:
            rows = []
            for col in fin.columns[:5]:
                year_str = str(col)[:10]
                def g(row_name, f=fin, c=col):
                    try:
                        v = f.loc[row_name, c]
                        if pd.isna(v):
                            return None
                        return round(float(v) / 1e8, 2)
                    except:
                        return None
                rev = g('Total Revenue') or g('Revenue')
                ni = g('Net Income')
                rows.append({
                    'period': year_str,
                    'revenue': rev,
                    'net_profit': ni,
                    'eps': safe(lambda c=col: round(float(ticker.info.get('trailingEps') or 0), 4))
                })
            result['financials'] = rows
    except:
        pass

    # 资产负债表
    try:
        bs = ticker.balance_sheet
        if bs is not None and not bs.empty:
            rows = []
            for col in bs.columns[:3]:
                def g(row_name, b=bs, c=col):
                    try:
                        v = b.loc[row_name, c]
                        if pd.isna(v):
                            return None
                        return round(float(v) / 1e8, 2)
                    except:
                        return None
                rows.append({
                    'period': str(col)[:10],
                    'total_assets': g('Total Assets'),
                    'total_liabilities': g('Total Liabilities Net Minority Interest'),
                    'equity': g('Stockholders Equity') or g('Common Stock Equity'),
                    'current_assets': g('Current Assets'),
                    'current_liabilities': g('Current Liabilities')
                })
            result['balance'] = rows
    except:
        pass

    # 月K线
    try:
        hist = ticker.history(period='1y', interval='1mo')
        monthly = []
        for dt, row in hist.iterrows():
            monthly.append({
                'date': str(dt)[:10],
                'close': safe(lambda r=row: round(float(r['Close']), 2)),
                'open': safe(lambda r=row: round(float(r['Open']), 2)),
                'high': safe(lambda r=row: round(float(r['High']), 2)),
                'low': safe(lambda r=row: round(float(r['Low']), 2)),
                'volume': safe(lambda r=row: int(r['Volume']))
            })
        result['monthly_price'] = monthly
    except:
        pass

    # 技术指标 (日K)
    try:
        hist_daily = ticker.history(period='1y', interval='1d')
        if len(hist_daily) > 60:
            closes = hist_daily['Close']
            result['tech_indicators'] = {
                'ma5': calc_ma(closes, 5),
                'ma20': calc_ma(closes, 20),
                'ma60': calc_ma(closes, 60),
                'rsi': calc_rsi(closes),
                'macd': calc_macd(closes),
                'bollinger': calc_bollinger(closes),
                'current_price': safe(lambda: round(float(closes.iloc[-1]), 2))
            }
            df_for_sr = pd.DataFrame({'close': closes.values})
            result['support_resistance'] = calc_support_resistance(df_for_sr)
    except:
        pass

    # 同行对比（同板块ETF持仓或硬编码同行）
    try:
        sector = ticker.info.get('sector', '')
        peers_map = {
            'Technology': ['AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA', 'AMD', 'INTC', 'AMZN', 'TSLA', 'NFLX'],
            'Financial Services': ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BRK-B', 'V', 'MA'],
            'Healthcare': ['JNJ', 'PFE', 'UNH', 'ABBV', 'MRK', 'LLY', 'AMGN', 'GILD'],
            'Consumer Cyclical': ['AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'SBUX', 'TGT', 'COST'],
            'Energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX'],
            'Communication Services': ['GOOGL', 'META', 'NFLX', 'DIS', 'CMCSA', 'T', 'VZ'],
            'Industrials': ['HON', 'GE', 'CAT', 'BA', 'UPS', 'FDX', 'LMT'],
            'Consumer Defensive': ['PG', 'KO', 'PEP', 'WMT', 'COST', 'CL', 'GIS'],
            'Basic Materials': ['LIN', 'APD', 'SHW', 'ECL', 'NEM', 'FCX', 'ALB'],
            'Real Estate': ['AMT', 'PLD', 'CCI', 'EQIX', 'SPG', 'O', 'DLR'],
            'Utilities': ['NEE', 'DUK', 'SO', 'D', 'AEP', 'SRE', 'XEL'],
        }
        peer_syms = [s for s in peers_map.get(sector, []) if s != symbol.upper()][:5]
        if peer_syms:
            import yfinance as yf
            peers_info = yf.download(peer_syms, period='5d', interval='1d', auto_adjust=True, progress=False)
            peers_data = []
            for sym in peer_syms:
                try:
                    t = yf.Ticker(sym)
                    ti = t.info
                    peers_data.append({
                        'symbol': sym,
                        'name': ti.get('shortName') or ti.get('longName') or sym,
                        'price': safe(lambda ti=ti: round(float(ti.get('regularMarketPrice') or ti.get('previousClose') or 0), 2)),
                        'change_pct': safe(lambda ti=ti: round(float(ti.get('regularMarketChangePercent') or 0) * 100, 2) if abs(float(ti.get('regularMarketChangePercent') or 0)) > 1 else round(float(ti.get('regularMarketChangePercent') or 0), 2)),
                        'pe': safe(lambda ti=ti: round(float(ti.get('trailingPE') or 0), 2)),
                        'market_cap': safe(lambda ti=ti: round(float(ti.get('marketCap') or 0) / 1e8, 2))
                    })
                except:
                    peers_data.append({'symbol': sym, 'name': sym, 'price': None, 'change_pct': None, 'pe': None, 'market_cap': None})
            result['peers_data'] = peers_data
    except:
        pass

    return result


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'error': '用法: python research_data.py <symbol> <market>'}))
        sys.exit(1)

    symbol = sys.argv[1].strip()
    market = sys.argv[2].strip().lower()

    try:
        if market == 'cn':
            data = fetch_cn(symbol)
        elif market == 'us':
            data = fetch_us(symbol)
        else:
            data = {'error': f'未知市场: {market}', 'symbol': symbol, 'market': market}

        print(json.dumps(data, ensure_ascii=False, default=str))
    except Exception as e:
        err_data = {
            'error': str(e),
            'symbol': symbol,
            'market': market,
            'traceback': traceback.format_exc()[-500:]
        }
        print(json.dumps(err_data, ensure_ascii=False))
        sys.exit(0)


if __name__ == '__main__':
    main()
