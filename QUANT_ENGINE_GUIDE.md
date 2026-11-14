# Deriv Multiplier Quant Engine (WF-13) — Complete User & Technical Guide

Welcome to the documentation for your **WF-13 Deriv Multiplier Quant Engine** (`13` Walk-Forward Validated Markets · `8` Concurrent Open Slots). This guide explains **what every trading term means in plain English**, **how the live bot thinks and trades 24/7**, **how it protects your money and locks in profits**, and **its verified 1-year and 5-year historical performance**.

> [!TIP]
> **New to Quantitative Trading?** Start with **Section 1 (Plain-English Glossary)**. Every technical term you see on the dashboard (`ADX`, `ATR`, `EMA`, `Donchian`, `RSI`, `R-Multiple`, `Profit-Ratchet`, `Walk-Forward`) is translated into everyday language before we dive into the live configuration.

---

## 1. Plain-English Glossary of Terms (For Beginners)

Before looking at parameters or numbers, here is what each term in the bot actually means:

### Core Trading Concepts

| Term | Plain-English Meaning | Concrete Example |
| :--- | :--- | :--- |
| **Quant (Quantitative Bot)** | A computer program that makes trading decisions using strict math and statistics instead of human emotion, gut feelings, or news headlines. | Instead of guessing *"EUR/USD looks like it might go up,"* the Quant checks mathematical regime, trend, volatility, and session filters on every closed candle and only trades when every rule passes. |
| **Deriv Multiplier** | A type of trade on Deriv where your price movement is multiplied (e.g., `40x`, `100x`, `200x`, or `300x`), **but your maximum loss can never exceed your initial Stake**. | If you put in a `$30` **Stake** with a **`200x` Multiplier** on Gold, and Gold moves **up `0.5%`**, you make `0.5% × 200 = +100%` (`+$30`). Even if Gold crashes `10%`, you cannot lose more than your `$30` stake. |
| **Stake (`1R` / Risk Unit)** | The exact dollar amount put into a single trade. In quant trading, we call one stake **`1R`** (1 unit of Risk). | If your account has `$1,000` and the bot risks `3%` (`$30`), then **`1R = $30`**.<ul><li>Making **`+1.0R`** means you won `+$30` (`+100%` of your stake).</li><li>Making **`+0.60R`** means you won `+$18` (`+60%` of your stake).</li><li>Losing **`-1.0R`** means the trade hit its stop-out (`1R`).</li></ul> |
| **Candle (or Bar)** | A summary of price movement over a fixed time window (`15m` = 15 minutes; `1h` = 1 hour). Each candle records 4 prices: **Open**, **High**, **Low**, and **Close**. | A `1H` candle on `frxUSDCHF` shows where USD/CHF started at `10:00`, the highest and lowest price touched during that hour, and where it closed at `11:00`. |
| **Long (`MULTUP`) vs. Short (`MULTDOWN`)** | **Long (`MULTUP`)** profits when the price goes **UP**. **Short (`MULTDOWN`)** profits when the price goes **DOWN**. | Because the bot can go both Long and Short (except Gold, which is Long-biased `longBiasOnly: true`), it can profit in both rising and falling markets. |
| **Stop-Loss (`SL`)** | An automatic safety exit that closes a losing trade before you lose more than `1R`. | On Deriv Multipliers, your stake acts as the built-in maximum loss boundary (`1R`), so a single trade can never blow up your account. |
| **Take-Profit (`TP`)** | An automatic target price where a winning trade closes immediately to cash in the gain. | On `15M` Synthetics and capped Forex pairs (`USDCHF`, `AUDJPY`, `EURUSD`, `GBPAUD`), a `+2.0R` (`+200%` of stake) Take-Profit is placed directly on Deriv's servers. |
| **Walk-Forward Validation (`WF-13`)** | Testing a strategy on an **unseen past time period (`2024–2025`)** AND a **recent period (`2025–2026`)**, and only keeping markets that are profitable in **both**. | This prevents **overfitting** (picking settings that only worked in one lucky year). We dropped `frxUSDCAD` and `frxAUDUSD` because they failed the `2024–2025` out-of-sample test. |

---

### Technical Indicators (The Bot's "Sensors")

| Indicator | What Question Does It Answer? | How the Bot Uses It |
| :--- | :--- | :--- |
| **`EMA` (Exponential Moving Average)** | *"Which direction is the overall tide flowing?"* Averages the last `N` candles (`EMA 30`, `EMA 50`, `EMA 100`, `EMA 200`), giving more weight to recent prices. | <ul><li>**`EMA(100)` & `EMA(200)`**: Macro Trend Compass. Price must align with `EMA(100)` (and `EMA(200)` on `cryBTCUSD`, `frxXAUUSD`, `1HZ100V`, `USDCHF`, `GBPJPY`, `AUDJPY`, `EURUSD`) before entering.</li><li>**Trail EMA (`EMA 30` or `EMA 50`)**: Moving Exit Line. As long as closed candles stay on the winning side of the Trail EMA, the bot keeps riding the trend.</li></ul> |
| **`ADX(14)` (Average Directional Index)** | *"Is the market trending strongly, or is it drifting sideways?"* Scored `0` to `100`. | <ul><li>**`ADX >= trendAdxMin`** (`20` on Gold, `22` on Silver/most FX, `24` on Crypto, `26` on GBP/USD, `28` on `15M` Synthetics): Strong directional wave — use **Trend-Breakout**.</li><li>**`ADX <= 20` (`RANGE`)**: Calm sideways market — use **Mean-Reversion** RSI bounce on non-`pureTrendOnly` markets (`15M` Synthetics and `USDCHF`, `USDJPY`, `GBPJPY`, `EURUSD`, `GBPUSD`).</li></ul> |
| **`ATR(14)` (Average True Range)** | *"How wild or calm are the price swings right now?"* Measures average candle size relative to price (`ATR %`). | **Chaos Gate**: If `ATR %` exceeds the symbol's safety ceiling (`0.45%`–`0.75%` on `1H`, `1.50%` on `15M`), the bot blocks new entries until volatility cools down. |
| **`Donchian Channel (24, 32, 36, 48, or 72)`** | *"Did price just break out to a new high or low?"* Plots the highest high and lowest low of the previous `N` candles. | In a `TREND` regime, the bot waits for a closed candle to **break above the `N`-bar high** (for `MULTUP`) or **below the `N`-bar low** (for `MULTDOWN`). |
| **`RSI(14)`** | *"Has price stretched too far in a range and is snapping back?"* | Used on `RANGE` (`ADX <= 20`) trades when `pureTrendOnly` is `false`: buys when `RSI(14)` crosses back above `32` in an uptrend (`close > EMA100`), or shorts when `RSI(14)` crosses back below `68` in a downtrend. |

---

### Profitability & Performance Metrics

| Metric | Plain-English Meaning | WF-13 (`1-Year 2025–2026` @ `3%` Risk) |
| :--- | :--- | :--- |
| **Win Rate (`WR`)** | Percentage of trades that close in profit (`> $0`). | **`52.7%`** (`1,092` trades) |
| **Profit Factor (`PF`)** | **Total Dollars Won ÷ Total Dollars Lost**. (`> 1.40` is institutional-grade edge). | **`1.52`** (`$1.52` won for every `$1.00` lost) |
| **Net `R`** | Total `R` won minus Total `R` lost before compounding. | **`+207.10R`** in 1 year (`+445.57R` over 5 years) |
| **Max Drawdown (`MaxDD`)** | Largest temporary peak-to-valley dip before recovering to a new high. | **`-64.48%`** at `3.0%` base risk (`-48.27%` at `2.0%` balanced risk) |

---

## 2. How the Live WF-13 Quant Engine Works

The engine runs 24/7 on Render (`server/quantRunner.ts`) and evaluates the exact same deterministic signal logic as the UI (`src/services/quantStrategyEngine.ts`).

### Step 1: Dual-Timeframe 13-Market Walk-Forward Basket (`8` Open Slots)

| Symbol | Market | Timeframe | Multiplier | Conviction Risk (at `3.0%` Base) | Lookback / ADX / ATR Gate | Macro `EMA 200` / Pure Trend | Trail EMA / Exit Rule | Session Filter |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :---: |
| **`1HZ100V`** | Vol 100 (1s) | **`15M`** | `40x` | **`3.80%`** | `32` · `ADX≥28` · `1.50%` | `EMA200` · Trend + MR | `EMA(30)` · Ratchet `[0.75->0.2, 1.2->0.6]` · `TP +2.0R` | 24/7 |
| **`R_75`** | Volatility 75 | **`15M`** | `50x` | **`3.80%`** | `32` · `ADX≥28` · `1.50%` | No M200 · Trend + MR | `EMA(50)` · Ratchet `[0.75->0.2, 1.2->0.6]` · `TP +2.0R` | 24/7 |
| **`cryBTCUSD`** | BTC/USD | **`1H`** | `100x` | **`3.80%`** | `36` · `ADX≥24` · `0.65%` | `EMA200` · Pure Trend | `EMA(50)` · Ratchet `[0.8->0.2]` · Uncapped | 24/7 |
| **`cryETHUSD`** | ETH/USD | **`1H`** | `100x` | **`2.80%`** | `48` · `ADX≥24` · `0.75%` | No M200 · Pure Trend | `EMA(50)` · Ratchet `[0.8->0.2]` · Uncapped | 24/7 |
| **`frxXAUUSD`** | Gold XAU/USD | **`1H`** | `200x` | **`3.80%`** | `72` · `ADX≥20` · `0.65%` | `EMA200` · Pure Trend (`Long Only`) | `EMA(50)` · Uncapped Trail | 24/5 |
| **`frxXAGUSD`** | Silver XAG/USD | **`1H`** | `100x` | **`3.20%`** | `24` · `ADX≥22` · `0.65%` | No M200 · Pure Trend | `EMA(30)` · Ratchet `[0.8->0.2]` · Uncapped | 24/5 |
| **`frxUSDCHF`** | USD/CHF | **`1H`** | `300x` | **`3.50%`** | `24` · `ADX≥22` · `0.65%` | `EMA200` · Trend + MR | `EMA(50)` · Ratchet `[0.8->0.2]` · `TP +2.0R` | 24/5 |
| **`frxUSDJPY`** | USD/JPY | **`1H`** | `300x` | **`3.50%`** | `72` · `ADX≥22` · `0.65%` | No M200 · Trend + MR | `EMA(50)` · Uncapped Trail | **`06–18 UTC`** |
| **`frxGBPJPY`** | GBP/JPY | **`1H`** | `300x` | **`3.20%`** | `72` · `ADX≥22` · `0.65%` | `EMA200` · Trend + MR | `EMA(50)` · Uncapped Trail | **`06–18 UTC`** |
| **`frxAUDJPY`** | AUD/JPY | **`1H`** | `300x` | **`3.00%`** | `72` · `ADX≥22` · `0.65%` | `EMA200` · Pure Trend | `EMA(50)` · Ratchet `[0.8->0.2]` · `TP +2.0R` | 24/5 |
| **`frxEURUSD`** | EUR/USD | **`1H`** | `200x` | **`3.00%`** | `24` · `ADX≥22` · `0.45%` | `EMA200` · Trend + MR | `EMA(50)` · Ratchet `[0.8->0.2]` · `TP +2.0R` | **`06–18 UTC`** |
| **`frxGBPUSD`** | GBP/USD | **`1H`** | `300x` | **`2.80%`** | `48` · `ADX≥26` · `0.45%` | No M200 · Trend + MR | `EMA(50)` · Uncapped Trail | 24/5 |
| **`frxGBPAUD`** | GBP/AUD | **`1H`** | `300x` | **`2.80%`** | `24` · `ADX≥22` · `0.45%` | No M200 · Pure Trend | `EMA(50)` · Ratchet `[0.8->0.2]` · `TP +2.0R` | 24/5 |

> [!NOTE]
> **Why are Forex & Metals quiet on weekends?** Forex (`frx*`) and Spot Metals (`frxXAUUSD`, `frxXAGUSD`) only trade Sunday `23:00 UTC` through Friday `21:00 UTC`. Over weekends, the engine continues scanning `cryBTCUSD`, `cryETHUSD`, `1HZ100V`, and `R_75` 24/7.

---

### Step 2: Entry Filters & Non-Repainting Execution
1. **Closed-Candle Evaluation (`bars.length - 2`)**: Signals are always evaluated on the **most recently closed candle**, eliminating intrabar repainting.
2. **Chaos Gate (`atrPct <= atrCutoff`)**: Blocks entries when volatility is too wide for the Multiplier's knock-out buffer.
3. **London/New York Session Gate (`06:00–18:00 UTC`)**: On `frxUSDJPY`, `frxGBPJPY`, and `frxEURUSD`, new `1H` entries are restricted to liquid London/NY hours while open positions remain managed 24/5.
4. **Intraday Chop Gate (`15M` Synthetics)**: Blocks `15M` breakouts if `12+` of the last `16` bars had `ADX < 19`.

---

### Step 3: Automated Exits & Profit-Ratchet Protection
1. **Real-Time Tick-Level Profit-Ratchet**:
   - **Two-Stage (`15M` Synthetics)**: At `+0.75R` peak profit, Stage 1 locks a **`+0.20R`** floor; at `+1.20R` peak profit, Stage 2 locks a **`+0.60R`** floor.
   - **Single-Stage (`BTC`, `ETH`, `XAG`, `USDCHF`, `AUDJPY`, `EURUSD`, `GBPAUD`)**: At `+0.80R` peak profit, Stage 1 locks a **`+0.20R`** floor so winning breakouts cannot round-trip into `-1.0R` losses.
2. **Trailing EMA Exit**: Uncapped trend runners (`BTC`, `ETH`, `Gold`, `Silver`, `USDJPY`, `GBPJPY`, `GBPUSD`) ride trends until a closed candle crosses back across their calibrated Trail EMA (`EMA 30` or `EMA 50`).
3. **Mean-Reversion RSI Exit**: Range trades exit when `RSI(14)` recovers (`> 58` for Longs, `< 42` for Shorts) or hits the `+1.2R` (`15M`/Forex) / `+1.6R` (Crypto) Take-Profit.

---

### Step 4: Portfolio Risk Guardrails
- **8-Slot Concurrency Cap (`openPositions < 8`)**: Captures `~98.8%` of valid signals across all 13 markets while keeping ~`75%` of account equity in cash even at maximum occupancy (and max 1 open trade per symbol).
- **3-Loss Symbol Cooldown (`30` Minutes)**: After 3 consecutive losses on a symbol, that symbol pauses for `1800s`.
- **Daily `-4.0R` Circuit Breaker**: If total realized losses on the current UTC day reach `-4.0R`, the entire engine pauses new entries until the next UTC day.
- **Drawdown Throttle**: When a symbol's rolling 12-trade net `R` drops to `<= -6.0R` (with `>= 8` trades), stake size is automatically halved (`50%`) until performance recovers.

---

## 3. Verified 1-Year Benchmark (`2025-11-14` -> `2026-11-14`, Deriv Candles)

Evaluated across all **13 live markets** (`8` open slots, `$1,000` starting balance) in `scripts/backtest_1y_live_wf13.ts`:

| Risk Setting | Trades | Win Rate | Profit Factor | Net `R` | Avg Full Month | Profitable Full Months | `$1,000` Ending Balance | Max Drawdown |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Live `3.0%` Base Risk** | `1,092` | `52.7%` | **`1.52`** | **`+207.10R`** | **`+79.25%/mo`** | `8 / 11` | **`$150,714.74`** | `-64.48%` |
| **Balanced `2.0%` Base Risk** | `1,092` | `52.7%` | **`1.52`** | **`+207.10R`** | `+48.53%/mo` | **`9 / 11`** | **`$41,671.31`** | **`-48.27%`** |
| **Conservative `1.5%` Base Risk** | `1,092` | `52.7%` | **`1.52`** | **`+207.10R`** | `+34.80%/mo` | **`9 / 11`** | **`$19,377.66`** | **`-38.29%`** |

### Month-by-Month (`2025-11` -> `2026-11` @ `3.0%` Base Risk)

| Month | Trades | Win Rate | Net `R` | Monthly Return | Ending Balance |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **2025-11** *(partial)* | `27` | `52%` | `+1.05R` | `+3.49%` | `$1,034.86` |
| **2025-12** | `70` | `54%` | `+0.10R` | `-1.54%` | `$1,018.94` |
| **2026-01** | `106` | `59%` | `+38.26R` | **`+169.84%`** | `$2,749.47` |
| **2026-02** | `58` | `41%` | `+7.03R` | `+25.33%` | `$3,445.83` |
| **2026-03** | `102` | `50%` | `+9.00R` | `+21.40%` | `$4,183.19` |
| **2026-04** | `98` | `45%` | `-5.14R` | `-25.64%` | `$3,110.79` |
| **2026-05** | `105` | `50%` | `-7.60R` | `-24.46%` | `$2,349.81` |
| **2026-06** | `96` | `53%` | `+25.47R` | **`+115.42%`** | `$5,061.93` |
| **2026-07** | `92` | `55%` | `+2.87R` | `+3.86%` | `$5,257.41` |
| **2026-08** | `108` | `51%` | **`+70.96R`** | **`+385.23%`** | `$25,510.65` |
| **2026-09** | `85` | `55%` | `+20.86R` | **`+63.97%`** | `$41,830.88` |
| **2026-10** | `102` | `59%` | `+25.87R` | **`+138.33%`** | `$99,694.82` |
| **2026-11** *(partial)* | `43` | `60%` | `+18.38R` | **`+51.18%`** | **`$150,714.74`** |

---

## 4. Verified 5-Year Multi-Cycle Backtest (`2021-11` -> `2026-11`)

Evaluated across `5` years (`2021–2026`) for `BTC`, `ETH`, and `Gold`, `2.4–2.8` years (`2024–2026`) for `Silver` and the `7` Forex pairs, and `1` year (`2025–2026`) for `15M` Synthetics (`scripts/backtest_5y_portfolio_e.ts`):

### A. Continuous 5-Year Compounded Performance (`$1,000` Start, `8` Slots)

| Risk Setting | Trades | Win Rate | Profit Factor | Total Net `R` | `$1,000` Ending Balance | 5-Year Max Drawdown |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Live `3.0%` Base Risk** | `2,315` | `49.8%` | **`1.46`** | **`+445.57R`** | **`$24,056,397.87`** | `-65.35%` |
| **Balanced `2.0%` Base Risk** | `2,315` | `49.8%` | **`1.46`** | **`+445.57R`** | **`$2,003,186.63`** | **`-49.10%`** |

### B. Standalone Year-by-Year Scorecard (`$1,000` Fresh Start Each Year @ `3.0%` Base Risk)

| Rolling 12-Month Period | Markets Available in Historical Feed | Trades | Win Rate | Profit Factor | Net `R` | `$1,000` End | Max Drawdown |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **2021–2022** *(Crypto Bear)* | `3` Macro Core (`BTC`, `ETH`, `Gold`) | `33` | `27.3%` | `0.64` | `-8.26R` | **`$704.45`** (`-29.6%`) | `-42.81%` |
| **2022–2023** *(Recovery)* | `3` Macro Core (`BTC`, `ETH`, `Gold`) | `96` | `50.0%` | **`2.02`** | `+45.13R` | **`$2,650.23`** (`+165.0%`) | `-40.26%` |
| **2023–2024** *(Bull + FX)* | `11` `1H` (`Crypto` + `Metals` + `7 FX`) | `433` | `48.0%` | **`1.67`** | `+128.08R` | **`$19,880.25`** (`+1,888.0%`) | `-41.41%` |
| **2024–2025** *(Choppy OOS)* | `11` `1H` (`Crypto` + `Metals` + `7 FX`) | `580` | `46.6%` | `1.25` | `+69.36R` | **`$4,248.68`** (`+324.9%`) | `-64.09%` |
| **2025–2026** *(Full Basket)* | All `13` (`+ 15M` Synthetics) | `1,092` | `52.7%` | **`1.52`** | `+207.10R` | **`$150,714.74`** (`+14,971.5%`) | `-64.48%` |
