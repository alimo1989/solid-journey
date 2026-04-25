const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const BASE = "https://fapi.bitunix.com/api/v1/futures/market";
const DEFAULT_COINS = ["KATUSDT","BSBUSDT","APEUSDT","RAVEUSDT","BLESSUSDT"];

let cache = { data: [], lastUpdated: null };

const f = (v, fb = 0) => {
  const n = parseFloat(v);
  return isNaN(n) ? fb : n;
};

async function fetchCoin(symbol) {
  try {
    const [tickerRes, fundingRes, kline1hRes, kline15mRes, kline5mRes] =
      await Promise.all([
        axios.get(`${BASE}/tickers?symbols=${symbol}`),
        axios.get(`${BASE}/funding_rate?symbol=${symbol}`),
        axios.get(`${BASE}/kline?symbol=${symbol}&interval=1h&limit=50`),
        axios.get(`${BASE}/kline?symbol=${symbol}&interval=15m&limit=50`),
        axios.get(`${BASE}/kline?symbol=${symbol}&interval=5m&limit=50`),
      ]);

    const ticker  = tickerRes.data?.data?.[0]  || {};
    const funding = fundingRes.data?.data       || {};
    const kline1h  = kline1hRes.data?.data      || [];
    const kline15m = kline15mRes.data?.data     || [];
    const kline5m  = kline5mRes.data?.data      || [];

    function analyseKlines(klines) {
      if (!klines.length) return {};
      const closes  = klines.map(k => f(k.close || k[4]));
      const highs   = klines.map(k => f(k.high  || k[2]));
      const lows    = klines.map(k => f(k.low   || k[3]));
      const volumes = klines.map(k => f(k.volume || k[5]));

      const last    = closes[closes.length - 1];
      const prev10  = closes[Math.max(0, closes.length - 11)];
      const pctChg  = prev10 > 0 ? ((last - prev10) / prev10) * 100 : 0;

      const trend = Math.abs(pctChg) < 1 ? "sideways"
        : pctChg > 0 ? "uptrend" : "downtrend";

      const last20Highs = highs.slice(-20);
      const last20Lows  = lows.slice(-20);
      const last5Highs  = highs.slice(-5);
      const last5Lows   = lows.slice(-5);

      const resistance  = Math.max(...last20Highs);
      const support     = Math.min(...last20Lows);
      const recentHigh  = Math.max(...last5Highs);
      const recentLow   = Math.min(...last5Lows);

      const lastClose   = closes[closes.length - 1];
      const lastOpen    = f(klines[klines.length - 1].open || klines[klines.length - 1][1]);
      const bullish     = lastClose >= lastOpen;

      const avgVol      = volumes.slice(-20).reduce((a,b) => a+b, 0) / 20;
      const lastVol     = volumes[volumes.length - 1];
      const volumeAbove = lastVol > avgVol;

      return { trend, resistance, support, recentHigh, recentLow, bullish, volumeAbove, lastClose };
    }

    const tf1h  = analyseKlines(kline1h);
    const tf15m = analyseKlines(kline15m);
    const tf5m  = analyseKlines(kline5m);

    const price = f(ticker.lastPrice || ticker.markPrice);
    const fr    = f(funding.fundingRate) * 100;

    // bias logic
    let bias = "NEUTRAL";
    if (["uptrend"].includes(tf1h.trend) &&
        ["uptrend","sideways"].includes(tf15m.trend)) bias = "LONG";
    else if (["downtrend"].includes(tf1h.trend) &&
             ["downtrend","sideways"].includes(tf15m.trend)) bias = "SHORT";

    // levels
    const longEntry  = f(tf5m.recentLow);
    const longSL     = f(tf5m.support)   * 0.99;
    const longTP1    = (price + f(tf1h.resistance)) / 2;
    const longTP2    = f(tf1h.resistance);
    const shortEntry = f(tf5m.recentHigh);
    const shortSL    = f(tf5m.resistance) * 1.01;
    const shortTP1   = (price + f(tf1h.support)) / 2;
    const shortTP2   = f(tf1h.support);

    function rr(entry, sl, tp) {
      const risk   = Math.abs(entry - sl);
      const reward = Math.abs(tp - entry);
      if (risk === 0) return "—";
      return "1:" + (reward / risk).toFixed(1);
    }

    function priceFmt(n) {
      if (!n || isNaN(n)) return "—";
      if (n >= 1)      return n.toFixed(4);
      if (n >= 0.0001) return n.toFixed(6);
      return n.toPrecision(4);
    }

    return {
      symbol,
      price,
      change24h:    f(ticker.priceChangePercent || ticker.change24h),
      high24h:      f(ticker.high),
      low24h:       f(ticker.low),
      volume24h:    f(ticker.quoteVol || ticker.baseVol),
      fundingRate:  fr,
      markPrice:    f(ticker.markPrice),
      trend1h:      tf1h.trend,
      trend15m:     tf15m.trend,
      trend5m:      tf5m.trend,
      bias,
      long: {
        entry:       longEntry,
        entryFmt:    priceFmt(longEntry),
        stopLoss:    longSL,
        stopFmt:     priceFmt(longSL),
        tp1:         longTP1,
        tp1Fmt:      priceFmt(longTP1),
        tp2:         longTP2,
        tp2Fmt:      priceFmt(longTP2),
        rr1:         rr(longEntry, longSL, longTP1),
        rr2:         rr(longEntry, longSL, longTP2),
        condition:   `Go long at ${priceFmt(longEntry)} if the 5m candle closes green above this level with volume above the 20-candle average — confirming a bounce at the recent low`,
        invalidation:`Do not enter long if price closes below ${priceFmt(longSL)} on the 5m — support has broken`,
        support:     tf5m.support,
        resistance:  tf1h.resistance,
      },
      short: {
        entry:       shortEntry,
        entryFmt:    priceFmt(shortEntry),
        stopLoss:    shortSL,
        stopFmt:     priceFmt(shortSL),
        tp1:         shortTP1,
        tp1Fmt:      priceFmt(shortTP1),
        tp2:         shortTP2,
        tp2Fmt:      priceFmt(shortTP2),
        rr1:         rr(shortEntry, shortSL, shortTP1),
        rr2:         rr(shortEntry, shortSL, shortTP2),
        condition:   `Go short at ${priceFmt(shortEntry)} if the 5m candle closes red below this level with volume above the 20-candle average — confirming rejection at the recent high`,
        invalidation:`Do not enter short if price closes above ${priceFmt(shortSL)} on the 5m — resistance has broken`,
        support:     tf1h.support,
        resistance:  tf5m.resistance,
      },
      keyLevels: {
        majorSupport:    tf1h.support,
        majorResistance: tf1h.resistance,
        support15m:      tf15m.support,
        resistance15m:   tf15m.resistance,
      },
      fetchedAt: new Date().toUTCString(),
    };
  } catch(e) {
    return { symbol, error: e.message, fetchedAt: new Date().toUTCString() };
  }
}

async function runScan(coins) {
  console.log(`[${new Date().toUTCString()}] Scanning ${coins.join(", ")}...`);
  const results = await Promise.all(coins.map(fetchCoin));
  cache = { data: results, lastUpdated: new Date().toISOString() };
  console.log(`Scan complete.`);
}

// endpoints
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    lastUpdated: cache.lastUpdated,
    coins: cache.data.map(d => d.symbol),
  });
});

app.get("/api/scan", (req, res) => {
  res.json(cache);
});

app.get("/api/coins", (req, res) => {
  const coins = (req.query.symbols || "").split(",").filter(Boolean).map(s => s.toUpperCase());
  if (coins.length === 0) return res.json(cache);
  const filtered = cache.data.filter(d => coins.includes(d.symbol));
  res.json({ data: filtered, lastUpdated: cache.lastUpdated });
});

// initial scan + 15s refresh
const COINS = process.env.COINS
  ? process.env.COINS.split(",")
  : DEFAULT_COINS;

runScan(COINS);
setInterval(() => runScan(COINS), 15000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Signal scanner running on port ${PORT}`));
