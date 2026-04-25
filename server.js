const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

// Explicit CORS — allow all origins, all methods
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(cors({ origin: "*" }));
app.use(express.json());

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
        axios.get(`${BASE}/tickers?symbols=${symbol}`, { timeout: 10000 }),
        axios.get(`${BASE}/funding_rate?symbol=${symbol}`, { timeout: 10000 }),
        axios.get(`${BASE}/kline?symbol=${symbol}&interval=1h&limit=50`, { timeout: 10000 }),
        axios.get(`${BASE}/kline?symbol=${symbol}&interval=15m&limit=50`, { timeout: 10000 }),
        axios.get(`${BASE}/kline?symbol=${symbol}&interval=5m&limit=50`, { timeout: 10000 }),
      ]);

    const ticker  = tickerRes.data?.data?.[0]  || {};
    const funding = fundingRes.data?.data       || {};
    const kline1h  = kline1hRes.data?.data      || [];
    const kline15m = kline15mRes.data?.data     || [];
    const kline5m  = kline5mRes.data?.data      || [];

    function analyseKlines(klines) {
      if (!klines.length) return {};

      // Bitunix kline fields: [time, open, high, low, close, volume]
      const getField = (k, idx, key) => {
        if (Array.isArray(k)) return f(k[idx]);
        return f(k[key]);
      };

      const closes  = klines.map(k => getField(k, 4, "close"));
      const highs   = klines.map(k => getField(k, 2, "high"));
      const lows    = klines.map(k => getField(k, 3, "low"));
      const opens   = klines.map(k => getField(k, 1, "open"));
      const volumes = klines.map(k => getField(k, 5, "volume"));

      const last   = closes[closes.length - 1];
      const prev10 = closes[Math.max(0, closes.length - 11)];
      const pctChg = prev10 > 0 ? ((last - prev10) / prev10) * 100 : 0;

      const trend = Math.abs(pctChg) < 1 ? "sideways"
        : pctChg > 0 ? "uptrend" : "downtrend";

      const last20Highs = highs.slice(-20);
      const last20Lows  = lows.slice(-20);
      const last5Highs  = highs.slice(-5);
      const last5Lows   = lows.slice(-5);

      const resistance = Math.max(...last20Highs);
      const support    = Math.min(...last20Lows);
      const recentHigh = Math.max(...last5Highs);
      const recentLow  = Math.min(...last5Lows);

      const lastClose  = closes[closes.length - 1];
      const lastOpen   = opens[opens.length - 1];
      const bullish    = lastClose >= lastOpen;

      const avgVol     = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const lastVol    = volumes[volumes.length - 1];
      const volumeAbove = lastVol > avgVol;

      return { trend, resistance, support, recentHigh, recentLow, bullish, volumeAbove, lastClose };
    }

    const tf1h  = analyseKlines(kline1h);
    const tf15m = analyseKlines(kline15m);
    const tf5m  = analyseKlines(kline5m);

    const price = f(ticker.lastPrice || ticker.markPrice);
    const fr    = f(funding.fundingRate) * 100;

    // bias
    let bias = "NEUTRAL";
    if (["uptrend"].includes(tf1h.trend) &&
        ["uptrend","sideways"].includes(tf15m.trend)) bias = "LONG";
    else if (["downtrend"].includes(tf1h.trend) &&
             ["downtrend","sideways"].includes(tf15m.trend)) bias = "SHORT";

    // entry levels
    const longEntry  = f(tf5m.recentLow);
    const longSL     = f(tf5m.support)    * 0.99;
    const longTP1    = price > 0 ? (price + f(tf1h.resistance)) / 2 : f(tf1h.resistance);
    const longTP2    = f(tf1h.resistance);
    const shortEntry = f(tf5m.recentHigh);
    const shortSL    = f(tf5m.resistance)  * 1.01;
    const shortTP1   = price > 0 ? (price + f(tf1h.support)) / 2 : f(tf1h.support);
    const shortTP2   = f(tf1h.support);

    function rr(entry, sl, tp) {
      const risk   = Math.abs(entry - sl);
      const reward = Math.abs(tp - entry);
      if (risk === 0) return "—";
      return "1:" + (reward / risk).toFixed(1);
    }

    function pf(n) {
      if (!n || isNaN(n)) return "—";
      if (n >= 1000)  return n.toFixed(2);
      if (n >= 1)     return n.toFixed(4);
      if (n >= 0.0001) return n.toFixed(6);
      return n.toPrecision(4);
    }

    return {
      symbol,
      price,
      change24h:  f(ticker.priceChangePercent || ticker.change24h),
      high24h:    f(ticker.high),
      low24h:     f(ticker.low),
      volume24h:  f(ticker.quoteVol || ticker.baseVol),
      fundingRate: fr,
      markPrice:  f(ticker.markPrice),
      trend1h:    tf1h.trend  || "sideways",
      trend15m:   tf15m.trend || "sideways",
      trend5m:    tf5m.trend  || "sideways",
      bias,
      long: {
        entry:       longEntry,
        entryFmt:    pf(longEntry),
        stopLoss:    longSL,
        stopFmt:     pf(longSL),
        tp1:         longTP1,
        tp1Fmt:      pf(longTP1),
        tp2:         longTP2,
        tp2Fmt:      pf(longTP2),
        rr1:         rr(longEntry, longSL, longTP1),
        rr2:         rr(longEntry, longSL, longTP2),
        condition:   `Go long at ${pf(longEntry)} if the 5m candle closes GREEN above this level with volume above average — confirming a bounce at the recent low`,
        invalidation:`Do not enter if price closes below ${pf(longSL)} on the 5m — support has broken`,
        support:     tf5m.support,
        resistance:  tf1h.resistance,
      },
      short: {
        entry:       shortEntry,
        entryFmt:    pf(shortEntry),
        stopLoss:    shortSL,
        stopFmt:     pf(shortSL),
        tp1:         shortTP1,
        tp1Fmt:      pf(shortTP1),
        tp2:         shortTP2,
        tp2Fmt:      pf(shortTP2),
        rr1:         rr(shortEntry, shortSL, shortTP1),
        rr2:         rr(shortEntry, shortSL, shortTP2),
        condition:   `Go short at ${pf(shortEntry)} if the 5m candle closes RED below this level with volume above average — confirming rejection at the recent high`,
        invalidation:`Do not enter if price closes above ${pf(shortSL)} on the 5m — resistance has broken`,
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
    console.error(`Error fetching ${symbol}:`, e.message);
    return { symbol, error: e.message, fetchedAt: new Date().toUTCString() };
  }
}

async function runScan(coins) {
  console.log(`[${new Date().toUTCString()}] Scanning ${coins.join(", ")}...`);
  const results = await Promise.all(coins.map(fetchCoin));
  cache = { data: results, lastUpdated: new Date().toISOString() };
  console.log(`Scan complete. ${results.filter(r=>!r.error).length}/${results.length} successful.`);
}

const DASHBOARD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Signal Desk — Bitunix Futures</title>
<style>
  :root {
    --bg:#07090d; --card:#0d1520; --border:#182233; --dim:#0a111a;
    --text:#c8d8e8; --muted:#4a6070;
    --accent:#00d4ff; --green:#00e87a; --red:#ff3b5c;
    --yellow:#ffcc00; --purple:#a78bfa; --orange:#fb923c;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:sans-serif;min-height:100vh}
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap');
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  ::-webkit-scrollbar{width:4px}
  ::-webkit-scrollbar-thumb{background:#1e2a38;border-radius:2px}

  /* Header */
  header{
    background:rgba(7,9,13,.97);border-bottom:1px solid var(--border);
    padding:12px 20px;position:sticky;top:0;z-index:100;
    display:flex;align-items:center;justify-content:space-between;
    flex-wrap:wrap;gap:10px;
  }
  .logo{font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:4px;color:var(--accent);line-height:1}
  .logo-sub{font-family:monospace;font-size:9px;color:var(--muted);letter-spacing:2px}
  .hdr-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .status-dot{width:7px;height:7px;border-radius:50%;display:inline-block;animation:blink 1.8s infinite}
  .status-label{font-family:monospace;font-size:11px;display:flex;align-items:center;gap:5px}
  #clock{font-family:monospace;font-size:11px;color:var(--muted)}
  .btn{background:transparent;border:1px solid var(--border);color:var(--muted);
    padding:5px 12px;border-radius:6px;font-family:monospace;font-size:10px;
    cursor:pointer;letter-spacing:1px;transition:all .2s}
  .btn:hover{border-color:var(--accent);color:var(--accent)}
  .btn:disabled{opacity:.4;cursor:not-allowed}
  .pill{font-family:monospace;font-size:10px;padding:3px 10px;border-radius:20px}
  .pill-green{background:rgba(0,232,122,.1);border:1px solid rgba(0,232,122,.3);color:var(--green)}
  .pill-red{background:rgba(255,59,92,.1);border:1px solid rgba(255,59,92,.3);color:var(--red)}

  /* Countdown ring */
  #cdRing{display:flex;align-items:center;gap:5px;font-family:monospace;font-size:10px;color:var(--muted)}

  /* Main */
  main{max-width:860px;margin:0 auto;padding:16px 20px}

  /* Error banner */
  .error-banner{
    background:rgba(255,59,92,.07);border:1px solid rgba(255,59,92,.3);
    border-radius:10px;padding:12px 16px;margin-bottom:14px;
    font-family:monospace;font-size:12px;color:var(--red);line-height:1.7
  }

  /* Alert feed */
  #alertFeed{background:var(--card);border:1px solid var(--border);
    border-radius:12px;padding:12px 16px;margin-bottom:14px;display:none}
  .alert-title{font-family:monospace;font-size:9px;color:var(--muted);letter-spacing:2px;margin-bottom:8px}
  .alert-list{display:flex;flex-direction:column;gap:5px;max-height:140px;overflow-y:auto}
  .alert-item{display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:6px;font-family:monospace;font-size:10px}

  /* Filter tabs */
  .filters{display:flex;gap:8px;margin-bottom:12px}
  .filter-btn{padding:5px 14px;border-radius:20px;border:1px solid var(--border);
    background:transparent;color:var(--muted);font-family:monospace;
    font-size:9px;cursor:pointer;letter-spacing:1px;transition:all .2s}
  .filter-btn.active-all{border-color:var(--accent);background:rgba(0,212,255,.1);color:var(--accent)}
  .filter-btn.active-long{border-color:var(--green);background:rgba(0,232,122,.1);color:var(--green)}
  .filter-btn.active-short{border-color:var(--red);background:rgba(255,59,92,.1);color:var(--red)}
  .filter-btn.active-neutral{border-color:var(--yellow);background:rgba(255,204,0,.1);color:var(--yellow)}

  /* Cards */
  #coinsGrid{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
  .coin-card{background:var(--card);border:1px solid var(--border);
    border-radius:14px;overflow:hidden;transition:border-color .4s}
  .coin-card.bias-long{border-color:rgba(0,232,122,.35)}
  .coin-card.bias-short{border-color:rgba(255,59,92,.3)}

  .card-header{padding:14px 16px;cursor:pointer;
    display:flex;align-items:center;justify-content:space-between;gap:12px}
  .card-header:hover{background:rgba(255,255,255,.02)}

  .bias-badge{border-radius:6px;padding:4px 12px;font-family:monospace;
    font-size:11px;font-weight:700;letter-spacing:1px;min-width:64px;text-align:center;
    border:1px solid;flex-shrink:0}
  .badge-long{background:rgba(0,232,122,.12);border-color:rgba(0,232,122,.4);color:var(--green)}
  .badge-short{background:rgba(255,59,92,.12);border-color:rgba(255,59,92,.35);color:var(--red)}
  .badge-neutral{background:rgba(255,204,0,.08);border-color:rgba(255,204,0,.3);color:var(--yellow)}
  .badge-loading{background:rgba(74,96,112,.1);border-color:var(--border);color:var(--muted)}

  .card-info{flex:1;min-width:0}
  .card-name-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .coin-name{font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:2px;color:var(--text)}
  .coin-price{font-family:monospace;font-size:14px;font-weight:700;color:var(--text)}
  .coin-change{font-family:monospace;font-size:11px}
  .fr-badge{font-family:monospace;font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(0,0,0,.2)}
  .trend-row{display:flex;gap:8px;margin-top:3px;flex-wrap:wrap}
  .trend-item{font-family:monospace;font-size:9px}

  .card-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
  .sparkline-wrap{width:80px;height:28px}
  .chevron{color:var(--muted);font-size:11px}
  .remove-btn{background:transparent;border:1px solid var(--border);color:var(--red);
    padding:3px 8px;border-radius:4px;font-family:monospace;font-size:9px;
    cursor:pointer;opacity:.5}
  .remove-btn:hover{opacity:1}

  /* Card detail */
  .card-detail{border-top:1px solid var(--border);padding:14px 16px;display:none}
  .card-detail.open{display:block}

  /* Setup blocks */
  .setups-row{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .setup-block{flex:1;min-width:140px;border-radius:10px;padding:12px 14px;
    position:relative;overflow:hidden}
  .setup-long{background:rgba(0,232,122,.08);border:1px solid rgba(0,232,122,.22)}
  .setup-short{background:rgba(255,59,92,.08);border:1px solid rgba(255,59,92,.22)}
  .setup-long.favoured{border-color:rgba(0,232,122,.55)}
  .setup-short.favoured{border-color:rgba(255,59,92,.5)}
  .favoured-tag{position:absolute;top:0;right:0;font-family:monospace;font-size:8px;
    font-weight:700;padding:2px 8px;border-radius:0 10px 0 6px;letter-spacing:1px}
  .tag-long{background:var(--green);color:#000}
  .tag-short{background:var(--red);color:#fff}

  .setup-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
  .setup-type{border-radius:5px;padding:3px 10px;font-family:monospace;
    font-size:11px;font-weight:700;letter-spacing:1px;border:1px solid}
  .type-long{background:rgba(0,232,122,.2);border-color:rgba(0,232,122,.44);color:var(--green)}
  .type-short{background:rgba(255,59,92,.2);border-color:rgba(255,59,92,.44);color:var(--red)}
  .setup-entry{font-family:monospace;font-size:13px;font-weight:700;margin-left:auto}

  .condition-box{border-radius:8px;padding:10px 12px;margin-bottom:10px}
  .cond-long{background:rgba(0,232,122,.08);border:1px solid rgba(0,232,122,.25)}
  .cond-short{background:rgba(255,59,92,.08);border:1px solid rgba(255,59,92,.25)}
  .cond-label{font-family:monospace;font-size:8px;letter-spacing:1px;margin-bottom:5px}
  .cond-text{font-size:12px;color:var(--text);line-height:1.75;font-weight:500}

  .levels-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;
    background:var(--border);border-radius:7px;overflow:hidden;
    border:1px solid var(--border);margin-bottom:8px}
  .level-cell{background:var(--dim);padding:8px 10px}
  .level-label{font-family:monospace;font-size:8px;color:var(--muted);letter-spacing:1px;margin-bottom:3px}
  .level-val{font-family:monospace;font-size:12px;font-weight:700}

  .invalid-box{background:rgba(255,59,92,.05);border:1px solid rgba(255,59,92,.15);
    border-radius:6px;padding:7px 10px}
  .invalid-label{font-family:monospace;font-size:8px;color:var(--red);letter-spacing:1px;margin-bottom:3px}
  .invalid-text{font-size:11px;color:var(--muted);line-height:1.6}

  /* Key levels */
  .key-levels{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;
    background:var(--border);border-radius:8px;overflow:hidden;
    border:1px solid var(--border);margin-bottom:12px}
  .kl-cell{background:var(--dim);padding:9px 12px}
  .kl-label{font-family:monospace;font-size:8px;color:var(--muted);letter-spacing:1px;margin-bottom:3px}
  .kl-val{font-family:monospace;font-size:12px;font-weight:700}

  /* Stats */
  .stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;
    background:var(--border);border-radius:8px;overflow:hidden;
    border:1px solid var(--border);margin-bottom:10px}
  .stat-cell{background:var(--dim);padding:9px 12px}
  .stat-label{font-family:monospace;font-size:8px;color:var(--muted);letter-spacing:1px;margin-bottom:3px}
  .stat-val{font-family:monospace;font-size:12px;font-weight:700}

  .card-footer{font-family:monospace;font-size:9px;color:var(--muted);
    padding-top:8px;border-top:1px solid var(--border);
    display:flex;justify-content:space-between}

  /* Add coin */
  #addCoinBox{background:var(--card);border:1px solid var(--border);
    border-radius:12px;padding:14px 16px;margin-bottom:12px}
  .add-label{font-family:monospace;font-size:9px;color:var(--muted);
    letter-spacing:2px;margin-bottom:10px}
  .add-row{display:flex;gap:8px}
  #coinInput{flex:1;background:var(--dim);border:1px solid var(--border);
    color:var(--text);padding:8px 12px;border-radius:8px;
    font-family:monospace;font-size:12px}
  #addBtn{background:var(--accent);color:#000;border:none;
    padding:8px 18px;border-radius:8px;font-family:monospace;
    font-size:12px;font-weight:700;cursor:pointer;letter-spacing:1px}

  footer{font-family:monospace;font-size:9px;color:var(--muted);
    text-align:center;padding:10px 0;border-top:1px solid var(--border);
    max-width:860px;margin:0 auto;padding:10px 20px}

  /* Empty state */
  .empty{background:var(--card);border:1px solid var(--border);
    border-radius:12px;padding:24px;text-align:center;
    font-family:monospace;font-size:12px;color:var(--muted)}

  /* MTF trend row colors */
  .t-up{color:var(--green)} .t-down{color:var(--red)}
  .t-side{color:var(--muted)} .t-pull{color:var(--yellow)}
  .t-bounce{color:var(--green)} .t-break{color:var(--green)}
</style>
</head>
<body>

<header>
  <div>
    <div class="logo">Signal Desk</div>
    <div class="logo-sub">LIVE · BITUNIX FUTURES · 15s</div>
  </div>
  <div class="hdr-right">
    <span id="longPill" class="pill pill-green" style="display:none"></span>
    <span id="shortPill" class="pill pill-red" style="display:none"></span>
    <span class="status-label">
      <span id="statusDot" class="status-dot" style="background:var(--yellow);box-shadow:0 0 6px var(--yellow)"></span>
      <span id="statusText" style="font-family:monospace;font-size:11px;color:var(--yellow)">CONNECTING</span>
    </span>
    <span id="clock">--:--:-- UTC</span>
    <div id="cdRing">
      <svg width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" fill="none" stroke="#182233" stroke-width="2.5"/>
        <circle id="cdCircle" cx="12" cy="12" r="9" fill="none" stroke="#00d4ff" stroke-width="2.5"
          stroke-dasharray="56.55" stroke-dashoffset="56.55"
          stroke-linecap="round" transform="rotate(-90 12 12)"
          style="transition:stroke-dashoffset .95s linear"/>
        <text id="cdText" x="12" y="16" text-anchor="middle" fill="#00d4ff" font-size="7" font-family="monospace">15s</text>
      </svg>
      next fetch
    </div>
    <button class="btn" id="fetchBtn" onclick="fetchData()">↻ FETCH</button>
  </div>
</header>

<main>
  <div id="errorBanner" class="error-banner" style="display:none"></div>
  <div id="alertFeed">
    <div class="alert-title">📡 SIGNAL FEED</div>
    <div class="alert-list" id="alertList"></div>
  </div>
  <div class="filters">
    <button class="filter-btn active-all" onclick="setFilter('ALL')">ALL</button>
    <button class="filter-btn" onclick="setFilter('LONG')">LONG</button>
    <button class="filter-btn" onclick="setFilter('SHORT')">SHORT</button>
    <button class="filter-btn" onclick="setFilter('NEUTRAL')">NEUTRAL</button>
  </div>
  <div id="coinsGrid"></div>
  <div id="addCoinBox">
    <div class="add-label" id="watchingLabel">ADD TO WATCHLIST</div>
    <div class="add-row">
      <input id="coinInput" placeholder="e.g. BLESS, KAT, BSB" onkeydown="if(event.key==='Enter')addCoin()"/>
      <button id="addBtn" onclick="addCoin()">+ ADD</button>
    </div>
  </div>
  <footer id="footerText">Connecting to server...</footer>
</main>

<script>
const SERVER   = "https://solid-journey-production.up.railway.app";
const INTERVAL = 15;
const CIRC     = 2 * Math.PI * 9; // 56.55

let state = {
  coinData:    [],
  histories:   {},
  watchlist:   ["KATUSDT","BSBUSDT","APEUSDT","RAVEUSDT","BLESSUSDT"],
  alerts:      [],
  filter:      "ALL",
  countdown:   INTERVAL,
  fetchCount:  0,
  expanded:    {},
  serverOk:    false,
};

// ── Clock ──────────────────────────────────────────────────────────────
setInterval(() => {
  document.getElementById("clock").textContent =
    new Date().toUTCString().slice(17,25) + " UTC";
}, 500);

// ── Countdown ──────────────────────────────────────────────────────────
setInterval(() => {
  state.countdown--;
  if (state.countdown <= 0) { fetchData(); state.countdown = INTERVAL; }
  const prog = 1 - state.countdown / INTERVAL;
  document.getElementById("cdCircle").style.strokeDashoffset = CIRC * (1 - prog);
  document.getElementById("cdText").textContent = state.countdown + "s";
}, 1000);

// ── Format helpers ─────────────────────────────────────────────────────
function fp(v) {
  const x = parseFloat(v);
  if (!x || isNaN(x)) return "—";
  if (x >= 1000) return "$" + x.toLocaleString("en-US", {maximumFractionDigits:0});
  if (x >= 1)    return "$" + x.toFixed(4);
  if (x >= 0.0001) return "$" + x.toFixed(6);
  return "$" + x.toPrecision(4);
}

function trendClass(t) {
  if (!t) return "t-side";
  return {uptrend:"t-up",downtrend:"t-down",sideways:"t-side",
    pullback:"t-pull",bouncing:"t-bounce",breakout:"t-break"}[t] || "t-side";
}

function trendText(t) {
  return {uptrend:"↗ uptrend",downtrend:"↘ downtrend",sideways:"→ sideways",
    pullback:"↙ pullback",bouncing:"↑ bouncing",breakout:"⚡ breakout"}[t] || (t||"—");
}

// ── Sparkline ──────────────────────────────────────────────────────────
function drawSparkline(canvas, prices) {
  if (!canvas || prices.length < 2) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const pad = 2;
  const points = prices.map((p,i) => ({
    x: pad + (i/(prices.length-1))*(W-pad*2),
    y: pad + (H-pad*2) - ((p-min)/range)*(H-pad*2)
  }));
  const rising = prices[prices.length-1] >= prices[0];
  const col = rising ? "#00e87a" : "#ff3b5c";
  ctx.beginPath();
  points.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
  ctx.strokeStyle = col; ctx.lineWidth = 1.5;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.stroke();
  const last = points[points.length-1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 2.5, 0, Math.PI*2);
  ctx.fillStyle = col; ctx.fill();
}

// ── Fetch data ─────────────────────────────────────────────────────────
async function fetchData() {
  document.getElementById("fetchBtn").disabled = true;
  setStatus("updating");
  try {
    const res  = await fetch(\`${SERVER}/api/scan\`);
    if (!res.ok) throw new Error(\`HTTP ${res.status}\`);
    const json = await res.json();
    const data = Array.isArray(json) ? json : (json.data || []);

    state.coinData  = data.filter(d => state.watchlist.includes(d.symbol));
    state.serverOk  = true;
    state.fetchCount++;

    // Update price histories
    state.coinData.forEach(d => {
      if (d.price && !d.error) {
        if (!state.histories[d.symbol]) state.histories[d.symbol] = [];
        state.histories[d.symbol].push(parseFloat(d.price));
        if (state.histories[d.symbol].length > 48)
          state.histories[d.symbol].shift();
      }
    });

    // Alerts
    const now = new Date().toUTCString().slice(17,25) + " UTC";
    state.coinData.forEach(d => {
      if (d.bias && d.bias !== "NEUTRAL" && !d.error) {
        const exists = state.alerts.find(a => a.symbol===d.symbol && a.bias===d.bias);
        if (!exists) {
          state.alerts.unshift({
            time: now, symbol: d.symbol, bias: d.bias,
            entry: d.bias==="LONG" ? d.long?.entryFmt : d.short?.entryFmt
          });
          if (state.alerts.length > 50) state.alerts.pop();
        }
      }
    });

    document.getElementById("errorBanner").style.display = "none";
    setStatus("live");
    render();
  } catch(e) {
    state.serverOk = false;
    setStatus("error");
    document.getElementById("errorBanner").style.display = "block";
    document.getElementById("errorBanner").innerHTML =
      \`⚠ Cannot reach server at ${SERVER}<br>
       <span style="font-size:10px;color:var(--muted)">
       Check: <a href="${SERVER}/api/health" target="_blank" style="color:var(--accent)">${SERVER}/api/health</a>
       </span>\`;
  } finally {
    document.getElementById("fetchBtn").disabled = false;
    state.countdown = INTERVAL;
  }
}

function setStatus(s) {
  const dot  = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  const map  = {
    live:      {col:"#00e87a", label:"LIVE"},
    updating:  {col:"#00d4ff", label:"UPDATING"},
    error:     {col:"#ff3b5c", label:"SERVER ERROR"},
    connecting:{col:"#ffcc00", label:"CONNECTING"},
  };
  const m = map[s] || map.connecting;
  dot.style.background   = m.col;
  dot.style.boxShadow    = \`0 0 6px ${m.col}\`;
  text.style.color       = m.col;
  text.textContent       = m.label;
}

// ── Filter ─────────────────────────────────────────────────────────────
function setFilter(f) {
  state.filter = f;
  document.querySelectorAll(".filter-btn").forEach(b => {
    b.className = "filter-btn";
  });
  const map = {ALL:"active-all",LONG:"active-long",SHORT:"active-short",NEUTRAL:"active-neutral"};
  event.target.className = "filter-btn " + (map[f]||"active-all");
  render();
}

// ── Add / remove coin ──────────────────────────────────────────────────
function addCoin() {
  const val = document.getElementById("coinInput").value.trim().toUpperCase();
  if (!val) return;
  const sym = val.endsWith("USDT") ? val : val + "USDT";
  if (!state.watchlist.includes(sym)) {
    state.watchlist.push(sym);
    fetchData();
  }
  document.getElementById("coinInput").value = "";
}

function removeCoin(sym) {
  state.watchlist  = state.watchlist.filter(s => s !== sym);
  state.coinData   = state.coinData.filter(d => d.symbol !== sym);
  delete state.histories[sym];
  render();
}

function toggleExpand(sym) {
  state.expanded[sym] = !state.expanded[sym];
  render();
}

// ── Render ─────────────────────────────────────────────────────────────
function render() {
  // Header pills
  const lc = state.coinData.filter(d=>d.bias==="LONG").length;
  const sc = state.coinData.filter(d=>d.bias==="SHORT").length;
  const lp = document.getElementById("longPill");
  const sp = document.getElementById("shortPill");
  lp.style.display = lc > 0 ? "" : "none"; lp.textContent = lc + " LONG";
  sp.style.display = sc > 0 ? "" : "none"; sp.textContent = sc + " SHORT";

  // Watching label
  document.getElementById("watchingLabel").textContent =
    "ADD TO WATCHLIST · Watching: " + state.watchlist.map(s=>s.replace("USDT","")).join(", ");

  // Alerts
  const alertFeed = document.getElementById("alertFeed");
  const alertList = document.getElementById("alertList");
  if (state.alerts.length > 0) {
    alertFeed.style.display = "";
    alertList.innerHTML = state.alerts.slice(0,15).map(a => {
      const col = a.bias==="LONG" ? "#00e87a" : a.bias==="SHORT" ? "#ff3b5c" : "#ffcc00";
      return \`<div class="alert-item" style="background:${col}10;border:1px solid ${col}20">
        <span style="color:var(--muted)">${a.time}</span>
        <span style="color:${col};font-weight:700">${a.symbol.replace("USDT","")}</span>
        <span style="color:${col}">${a.bias}</span>
        <span style="color:var(--muted)">Entry: ${a.entry||"—"}</span>
      </div>\`;
    }).join("");
  }

  // Filter coins
  const filtered = state.coinData
    .filter(d => state.filter==="ALL" || d.bias===state.filter)
    .sort((a,b) => {
      const o={LONG:0,SHORT:1,NEUTRAL:2};
      return (o[a.bias]??3)-(o[b.bias]??3);
    });

  const grid = document.getElementById("coinsGrid");

  if (filtered.length === 0 && state.fetchCount > 0) {
    grid.innerHTML = \`<div class="empty">${state.filter==="ALL"?"No data yet — tap FETCH":"No "+state.filter+" signals right now"}</div>\`;
    return;
  }

  if (filtered.length === 0) {
    grid.innerHTML = \`<div class="empty">Connecting to Bitunix server...</div>\`;
    return;
  }

  grid.innerHTML = filtered.map(coin => buildCard(coin)).join("");

  // Draw sparklines
  filtered.forEach(coin => {
    const canvas = document.getElementById("spark-" + coin.symbol);
    const prices = state.histories[coin.symbol] || [];
    if (canvas && prices.length > 1) drawSparkline(canvas, prices);
    // Restore expanded state
    const detail = document.getElementById("detail-" + coin.symbol);
    if (detail && state.expanded[coin.symbol]) detail.classList.add("open");
  });

  // Footer
  document.getElementById("footerText").textContent =
    state.fetchCount > 0
      ? \`${state.fetchCount} fetch${state.fetchCount>1?"es":""} · Server: ${SERVER} · Data: Bitunix API · Not financial advice\`
      : "Connecting...";
}

function buildCard(coin) {
  const bias  = coin.bias || "NEUTRAL";
  const price = parseFloat(coin.price) || 0;
  const chg   = parseFloat(coin.change24h) || 0;
  const fr    = parseFloat(coin.fundingRate) || 0;
  const frCol = fr > 0.05 ? "#ff3b5c" : fr < -0.02 ? "#00e87a" : "#4a6070";

  const biasCls = bias==="LONG"?"badge-long":bias==="SHORT"?"badge-short":"badge-neutral";
  const cardCls = bias==="LONG"?"bias-long":bias==="SHORT"?"bias-short":"";
  const chgCol  = chg >= 0 ? "#00e87a" : "#ff3b5c";

  // Long setup
  const ls = coin.long || {};
  const lFav = bias==="LONG";
  const longBlock = \`
    <div class="setup-block setup-long ${lFav?"favoured":""}">
      ${lFav?'<div class="favoured-tag tag-long">FAVOURED</div>':""}
      <div class="setup-header">
        <span class="setup-type type-long">LONG</span>
        <span class="setup-entry" style="color:#00e87a">${ls.entryFmt||"—"}</span>
      </div>
      <div class="condition-box cond-long">
        <div class="cond-label" style="color:#00e87a">📋 ENTRY CONDITION</div>
        <div class="cond-text">${ls.condition||"—"}</div>
      </div>
      <div class="levels-grid">
        <div class="level-cell"><div class="level-label">STOP LOSS</div><div class="level-val" style="color:#ff3b5c">${ls.stopFmt||fp(ls.stopLoss)}</div></div>
        <div class="level-cell"><div class="level-label">R:R (TP1)</div><div class="level-val" style="color:#ffcc00">${ls.rr1||"—"}</div></div>
        <div class="level-cell"><div class="level-label">TAKE PROFIT 1</div><div class="level-val" style="color:#00e87a">${ls.tp1Fmt||fp(ls.tp1)}</div></div>
        <div class="level-cell"><div class="level-label">TAKE PROFIT 2</div><div class="level-val" style="color:rgba(0,232,122,.65)">${ls.tp2Fmt||fp(ls.tp2)}</div></div>
      </div>
      <div class="invalid-box">
        <div class="invalid-label">⛔ INVALIDATION</div>
        <div class="invalid-text">${ls.invalidation||"—"}</div>
      </div>
    </div>\`;

  // Short setup
  const ss = coin.short || {};
  const sFav = bias==="SHORT";
  const shortBlock = \`
    <div class="setup-block setup-short ${sFav?"favoured":""}">
      ${sFav?'<div class="favoured-tag tag-short">FAVOURED</div>':""}
      <div class="setup-header">
        <span class="setup-type type-short">SHORT</span>
        <span class="setup-entry" style="color:#ff3b5c">${ss.entryFmt||"—"}</span>
      </div>
      <div class="condition-box cond-short">
        <div class="cond-label" style="color:#ff3b5c">📋 ENTRY CONDITION</div>
        <div class="cond-text">${ss.condition||"—"}</div>
      </div>
      <div class="levels-grid">
        <div class="level-cell"><div class="level-label">STOP LOSS</div><div class="level-val" style="color:#ff3b5c">${ss.stopFmt||fp(ss.stopLoss)}</div></div>
        <div class="level-cell"><div class="level-label">R:R (TP1)</div><div class="level-val" style="color:#ffcc00">${ss.rr1||"—"}</div></div>
        <div class="level-cell"><div class="level-label">TAKE PROFIT 1</div><div class="level-val" style="color:#00e87a">${ss.tp1Fmt||fp(ss.tp1)}</div></div>
        <div class="level-cell"><div class="level-label">TAKE PROFIT 2</div><div class="level-val" style="color:rgba(0,232,122,.65)">${ss.tp2Fmt||fp(ss.tp2)}</div></div>
      </div>
      <div class="invalid-box">
        <div class="invalid-label">⛔ INVALIDATION</div>
        <div class="invalid-text">${ss.invalidation||"—"}</div>
      </div>
    </div>\`;

  // Key levels
  const kl = coin.keyLevels || {};
  const klBlock = \`
    <div class="key-levels">
      <div class="kl-cell"><div class="kl-label">MAJOR SUPPORT (1H)</div><div class="kl-val" style="color:#00e87a">${fp(kl.majorSupport)}</div></div>
      <div class="kl-cell"><div class="kl-label">MAJOR RESISTANCE (1H)</div><div class="kl-val" style="color:#ff3b5c">${fp(kl.majorResistance)}</div></div>
      <div class="kl-cell"><div class="kl-label">SUPPORT (15M)</div><div class="kl-val" style="color:rgba(0,232,122,.6)">${fp(kl.support15m)}</div></div>
      <div class="kl-cell"><div class="kl-label">RESISTANCE (15M)</div><div class="kl-val" style="color:rgba(255,59,92,.6)">${fp(kl.resistance15m)}</div></div>
    </div>\`;

  return \`
  <div class="coin-card ${cardCls}" id="card-${coin.symbol}">
    <div class="card-header" onclick="toggleExpand('${coin.symbol}')">
      <span class="bias-badge ${biasCls}">${coin.error?"ERR":bias}</span>
      <div class="card-info">
        <div class="card-name-row">
          <span class="coin-name">${coin.symbol.replace("USDT","")}</span>
          ${price>0?\`<span class="coin-price">${fp(price)}</span>\`:""}
          ${chg!==0?\`<span class="coin-change" style="color:${chgCol}">${chg>=0?"+":""}${chg.toFixed(2)}%</span>\`:""}
          ${fr!==0?\`<span class="fr-badge" style="color:${frCol}">FR ${fr>=0?"+":""}${fr.toFixed(4)}%</span>\`:""}
        </div>
        ${coin.error
          ? \`<div style="font-family:monospace;font-size:10px;color:#ff3b5c">${coin.error}</div>\`
          : \`<div class="trend-row">
              <span class="trend-item ${trendClass(coin.trend1h)}">1H: ${trendText(coin.trend1h)}</span>
              <span class="trend-item ${trendClass(coin.trend15m)}">15M: ${trendText(coin.trend15m)}</span>
              <span class="trend-item ${trendClass(coin.trend5m)}">5M: ${trendText(coin.trend5m)}</span>
             </div>\`
        }
      </div>
      <div class="card-right">
        <canvas id="spark-${coin.symbol}" class="sparkline-wrap" width="80" height="28"></canvas>
        ${!coin.error?\`<span class="chevron">${state.expanded[coin.symbol]?"▲":"▼"}</span>\`:""}
        <button class="remove-btn" onclick="event.stopPropagation();removeCoin('${coin.symbol}')">✕</button>
      </div>
    </div>
    ${!coin.error ? \`
    <div class="card-detail" id="detail-${coin.symbol}">
      <div class="setups-row">${longBlock}${shortBlock}</div>
      ${klBlock}
      <div class="stats-row">
        <div class="stat-cell"><div class="stat-label">24H HIGH</div><div class="stat-val" style="color:#00e87a">${fp(coin.high24h)}</div></div>
        <div class="stat-cell"><div class="stat-label">24H LOW</div><div class="stat-val" style="color:#ff3b5c">${fp(coin.low24h)}</div></div>
        <div class="stat-cell"><div class="stat-label">MARK PRICE</div><div class="stat-val" style="color:var(--muted)">${fp(coin.markPrice)}</div></div>
      </div>
      <div class="card-footer">
        <span>Bitunix · ${coin.fetchedAt||"—"}</span>
      </div>
    </div>\` : ""}
  </div>\`;
}

// ── Init ───────────────────────────────────────────────────────────────
render();
fetchData();
</script>
</body>
</html>
`;

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(DASHBOARD);
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    lastUpdated: cache.lastUpdated,
    coins: cache.data.map(d => d.symbol),
    errors: cache.data.filter(d=>d.error).map(d=>({symbol:d.symbol,error:d.error})),
  });
});

app.get("/api/scan", (req, res) => {
  res.json(cache);
});

app.get("/api/coins", (req, res) => {
  const coins = (req.query.symbols || "").split(",").filter(Boolean).map(s=>s.toUpperCase());
  if (!coins.length) return res.json(cache);
  const filtered = cache.data.filter(d => coins.includes(d.symbol));
  res.json({ data: filtered, lastUpdated: cache.lastUpdated });
});

app.get("/", (req, res) => {
  res.json({ message: "Signal Scanner Server", status: "ok", endpoints: ["/api/health", "/api/scan"] });
});

const COINS = process.env.COINS ? process.env.COINS.split(",") : DEFAULT_COINS;

// initial scan then every 15s
runScan(COINS);
setInterval(() => runScan(COINS), 15000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Signal scanner running on port ${PORT}`));
