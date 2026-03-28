#!/usr/bin/env python3
"""
ML量化预测 - Random Forest 短期价格方向预测
用法: python3 ml_predict.py <symbol>
输出: JSON { symbol, direction, confidence, up_prob, top_drivers, features, data_points }
"""
import sys
import json
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import yfinance as yf
from sklearn.ensemble import RandomForestClassifier

FEATURE_COLS = ['ret_1d', 'ret_5d', 'ret_20d', 'rsi', 'macd_hist', 'bb_pct', 'vol_ratio', 'volatility']
FEATURE_NAMES = {
    'ret_1d':     '1日涨幅',
    'ret_5d':     '5日涨幅',
    'ret_20d':    '20日涨幅',
    'rsi':        'RSI强弱',
    'macd_hist':  'MACD动量',
    'bb_pct':     '布林带位置',
    'vol_ratio':  '成交量比',
    'volatility': '波动率',
}

def compute_rsi(series, period=14):
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(window=period, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).rolling(window=period, min_periods=period).mean()
    rs = gain / (loss + 1e-10)
    return 100.0 - (100.0 / (1.0 + rs))

def build_features(df):
    df = df.copy()
    close = df['Close'].squeeze()
    volume = df['Volume'].squeeze()

    df['ret_1d']  = close.pct_change(1)
    df['ret_5d']  = close.pct_change(5)
    df['ret_20d'] = close.pct_change(20)
    df['rsi']     = compute_rsi(close, 14)

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd  = ema12 - ema26
    signal = macd.ewm(span=9, adjust=False).mean()
    df['macd_hist'] = macd - signal

    ma20  = close.rolling(20).mean()
    std20 = close.rolling(20).std()
    df['bb_pct'] = (close - (ma20 - 2 * std20)) / (4 * std20 + 1e-10)

    vol_ma20 = volume.rolling(20).mean()
    df['vol_ratio']  = volume / (vol_ma20 + 1e-10)
    df['volatility'] = df['ret_1d'].rolling(20).std() * np.sqrt(252)

    # label: 次日收盘 > 今日收盘 → 1 (涨)
    df['target'] = (close.shift(-1) > close).astype(int)
    return df

def predict(symbol):
    ticker = yf.Ticker(symbol)
    raw = ticker.history(period='2y', interval='1d', auto_adjust=True)

    if len(raw) < 60:
        return {'error': f'数据不足（{len(raw)}条），至少需要60个交易日'}

    df = build_features(raw).dropna(subset=FEATURE_COLS + ['target'])

    if len(df) < 50:
        return {'error': f'有效样本不足（{len(df)}条）'}

    X = df[FEATURE_COLS].values.astype(float)
    y = df['target'].values.astype(int)

    # 除最后一行外全部用于训练，最后一行做预测
    X_train, y_train = X[:-1], y[:-1]
    X_pred = X[-1:]

    clf = RandomForestClassifier(
        n_estimators=200, max_depth=6,
        min_samples_leaf=10, random_state=42, n_jobs=-1
    )
    clf.fit(X_train, y_train)

    proba   = clf.predict_proba(X_pred)[0]
    classes = list(clf.classes_)
    up_prob = float(proba[classes.index(1)]) if 1 in classes else 0.5
    direction  = 'up' if up_prob >= 0.5 else 'down'
    confidence = up_prob if direction == 'up' else (1.0 - up_prob)

    importances = clf.feature_importances_
    drivers = sorted([
        {'name': FEATURE_NAMES[c], 'importance': round(float(v), 4)}
        for c, v in zip(FEATURE_COLS, importances)
    ], key=lambda x: x['importance'], reverse=True)[:3]

    last = {c: round(float(v), 4) for c, v in zip(FEATURE_COLS, X[-1])}

    return {
        'symbol':      symbol,
        'direction':   direction,
        'confidence':  round(confidence, 4),
        'up_prob':     round(up_prob, 4),
        'top_drivers': drivers,
        'features':    last,
        'data_points': int(len(df)),
    }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': '缺少股票代码参数'}))
        sys.exit(1)
    symbol = sys.argv[1].strip()
    try:
        result = predict(symbol)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
