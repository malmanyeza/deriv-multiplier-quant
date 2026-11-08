# Deriv Multiplier Quant Trading Desk & Lab

An algorithmic trading platform, quant laboratory, and interactive execution desk built on the **New Deriv Options API** (`api.derivws.com` & `auth.deriv.com`) using React (Vite + TypeScript) and an Express Backend-for-Frontend (BFF).

---

## 🌟 Key Features

### 1. Quant Strategy Lab & Walk-Forward Engine
- **Mathematical Edge**: 100x Multiplier dual-regime model combining **48-bar Donchian Breakouts + Trend Confirmation (EMA30/EMA100, ADX $\ge 24$)** with **RSI Volatility Mean Reversion (RSI $\le 27$ / $\ge 73$, ADX $\le 20$)**.
- **Risk Preservation**: Dynamic ATR volatility cutoff ($\le 0.65\%$) preventing entries during dangerous news spikes.
- **Asymmetric Payoffs**: Trend trades ride momentum with trailing EMA30 exits; mean reversion locks in high-probability +160% targets.
- **Configurable Risk Sizing**: Supports `0.75%`, `1.0%`, `2.0%` risk of balance per trade, and quarter-Kelly throttling.

### 2. Multi-Year Backtested Results (2022 – 2026)
Tested on institutional 1-hour spot candle datasets (~35,000 bars) with real Deriv multiplier mechanics (100x leverage, -100% Stop-Out, exchange commissions):
- **4-Year Cumulative Return**: **+1,391.1%** (Initial `$1,000.00` compounded to **`$14,910.66`** at 2% risk).
- **Compound Annual Growth Rate (CAGR)**: **+96.5% / year**.
- **Profitable Active Months**: **27 / 46 (58.7%)**.
- **Peak-to-Trough Portfolio Drawdown**: **-28.08%** (at 2% risk) / **-15.11%** (at 1% risk).
- **Worst Losing Streak**: 14 consecutive losses (cumulative drawdown -24.6% of peak balance; account preserved, zero ruin).
- **Monte Carlo 2,000-Trial Ruin Probability**: **0.0%** (zero simulations blew up).

### 3. Interactive Execution Desk
- **Live TradingView Charts**: Powered by `lightweight-charts` with real-time ticks, multi-timeframe candles, entry markers, and Stop-Out / Take-Profit projection overlays.
- **Hover Previews**: Hovering over BUY / SELL tickets projects exact Stop-Out and Take-Profit barrier lines directly onto the live chart.
- **Multi-Asset Support**: Crypto (`cryBTCUSD`, `cryETHUSD`), Metals (`frxXAUUSD`), Indices (`OTC_NDX`), and Synthetic Volatility Indices (`R_100`, `1HZ100V`).
- **OAuth 2.0 + PKCE & Single-Use OTP**: Secure authentication keeping API tokens strictly server-side.

---

## 🚀 Quick Start

### 1. Installation
```bash
git clone <repository-url>
cd deriv-rise-fall-app
npm install
```

### 2. Start Local Development
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173):
- **Public indicative mode** streams immediately without credentials.
- Navigate to the **Quant Strategy Lab** tab to inspect live strategy performance, walk-forward testing, and risk parameters.

### 3. Run Standalone Quant Backtest Scripts
All quant backtest and Monte Carlo verification engines are located in `scripts/`:

```bash
# Run the full 4-year institutional backtest (2022-2026) at 2% risk:
node scripts/run_true_4year_backtest.mjs

# Run the 12-month month-by-month table from Deriv API:
node scripts/monthly_2pct_backtest.mjs

# Run the Monte Carlo Risk & Ruin simulation:
node scripts/risk_and_ruin_backtest.mjs
```

---

## ☁️ 24/7 Cloud Deployment Guide

To keep the quant bot running 24/7 when your laptop is turned off:

```
[Deriv API WebSocket]
        ▲
        │  (24/7 persistent connection, orders & ticks)
        ▼
[24/7 Cloud Worker] (Node.js daemon on Railway / Render / Fly.io - $0 to $5/mo)
        │
        │  (logs trades, reads risk %, updates balance)
        ▼
   [Supabase] (PostgreSQL Database - 100% Free Tier)
        ▲
        │  (fetches history, toggles bot ON/OFF)
        │
[Web Dashboard] (Vercel / Cloudflare Pages - 100% Free Tier)
```

1. **Frontend (Vercel / Cloudflare Pages)**: Deploy this repository to Vercel or Cloudflare Pages for free UI access anywhere.
2. **Database (Supabase)**: Create a free Supabase project to store active positions and user settings.
3. **Background Worker (Railway / Render / Fly.io)**: Run the continuous worker daemon with persistent WebSocket connection to Deriv.

---

## 📜 License
MIT License.
