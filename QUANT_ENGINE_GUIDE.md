# Deriv Multiplier Quant Engine (Tier 3) — Complete Beginner's Guide

Welcome to the documentation for your **Tier 3 Deriv Multiplier Quant Engine**. This guide explains **what every trading term means in plain English**, **how the bot thinks and trades 24/7**, **how it protects your money and locks in profits**, and **how it performed over a full 1-year historical test**.

> [!TIP]
> **New to Quantitative Trading?** Start with **Section 1 (Plain-English Glossary)**. Every technical term you see on the dashboard (`ADX`, `ATR`, `EMA`, `Donchian`, `RSI`, `R-Multiple`, `Profit-Ratchet`) is translated into everyday language before we dive into how the engine works.

---

## 1. Plain-English Glossary of Terms (For Beginners)

Before looking at formulas or numbers, here is what each term in the bot actually means:

### Core Trading Concepts

| Term | Plain-English Meaning | Concrete Example |
| :--- | :--- | :--- |
| **Quant (Quantitative Bot)** | A computer program that makes trading decisions using strict math and statistics instead of human emotion, gut feelings, or news headlines. | Instead of guessing *"Bitcoin looks like it might go up,"* the Quant checks 5 mathematical conditions every 15 seconds and only trades when all 5 pass. |
| **Deriv Multiplier** | A type of trade on Deriv where your price movement is multiplied (e.g., `40x`, `50x`, or `100x`), **but your maximum loss can never exceed your initial Stake**. | If you put in a `$30` **Stake** with a **`50x` Multiplier**, and Bitcoin moves **up `1%`**, you make `1% × 50 = +50%` (`+$15`). Even if the market crashes `20%`, you cannot lose more than your `$30` stake. |
| **Stake (`1R` / Risk Unit)** | The exact dollar amount put into a single trade. In quant trading, we call one stake **`1R`** (1 unit of Risk). | If your account has `$1,000` and the bot risks `3%` (`$30`), then **`1R = $30`**.<ul><li>Making **`+1.0R`** means you won `+$30` (`+100%` of your stake).</li><li>Making **`+0.60R`** means you won `+$18` (`+60%` of your stake).</li><li>Losing **`-1.0R`** means the trade hit its stop-loss and lost `-$30`.</li></ul> |
| **Candle (or Bar)** | A summary of price movement over a fixed time window (`15m` = 15 minutes; `1h` = 1 hour). Each candle records 4 prices: **Open** (start price), **High** (highest peak), **Low** (lowest dip), and **Close** (final price). | A `1H` candle on Gold shows where Gold started at `10:00`, the highest and lowest price it touched between `10:00` and `11:00`, and where it finished at `11:00`. |
| **Long (`MULTUP`) vs. Short (`MULTDOWN`)** | **Long (`MULTUP`)** profits when the price goes **UP**. **Short (`MULTDOWN`)** profits when the price goes **DOWN**. | Because the bot can go both Long and Short, it can make money in both bull markets (rising prices) and bear markets (falling prices). |
| **Stop-Loss (`SL`)** | An automatic safety exit that closes a losing trade before you lose more than planned. | On Deriv Multipliers, the Stop-Loss is attached directly to the order on Deriv's servers so you never lose more than your stake (`1R`). |
| **Take-Profit (`TP`)** | An automatic target price where a winning trade closes immediately to cash in the gain. | On `15M` Trend trades, a `+2.0R` (`+200%` of stake) Take-Profit is placed on Deriv's servers so sudden spikes cash out automatically. |

---

### Technical Indicators (The Bot's "Sensors")

Think of indicators like the dashboard gauges in a car (speedometer, RPM, fuel, engine temperature):

| Indicator | What Question Does It Answer? | How the Bot Uses It |
| :--- | :--- | :--- |
| **`EMA` (Exponential Moving Average)** | *"Which direction is the overall tide flowing?"* It averages the last $N$ candles (`EMA 20`, `EMA 50`, `EMA 200`), giving more weight to recent prices. | <ul><li>**`EMA(50)` / `EMA(200)`**: Used as a **Trend Compass**. If price is above the EMA and the EMA is sloping up, the bot only looks to buy (`MULTUP`).</li><li>**Trail EMA (`EMA 20`, `30`, or `50`)**: Used as a **Moving Exit Line**. As long as price stays above the Trail EMA, the bot keeps riding the winning trend.</li></ul> |
| **`ADX(14)` (Average Directional Index)** | *"Is the market trending strongly, or is it just drifting sideways?"* Scored from `0` to `100`. | <ul><li>**`ADX >= 25` (`TREND`)**: Strong directional wave — use the **Trend-Breakout** strategy.</li><li>**`ADX < 20` (`RANGE`)**: Calm, sideways market — use the **Mean-Reversion** bounce strategy (on `15M` synthetics).</li><li>**`ADX 20–25` (`NEUTRAL`)**: Indecisive chop — **do not enter new trades**.</li></ul> |
| **`ATR(14)` (Average True Range)** | *"How wild or calm are the price swings right now?"* Measures the average size of recent candles. | <ul><li>Detects **`CHAOS` Regime**: If candles suddenly become dangerously huge, the bot blocks new trades.</li><li>Sizes the **Stop-Loss distance** (`1.5 × ATR`) so normal market noise doesn't knock you out early.</li></ul> |
| **`Donchian Channel (20 or 36)`** | *"Did the price just break out to a brand-new high or low?"* Plots the highest high and lowest low of the last `20` (or `36`) candles. | In a `TREND` regime, the bot waits for a candle to **close above the previous 20-bar (or 36-bar) ceiling** (or below the floor) before jumping in. |
| **`Bollinger Bands (20, 2)` & `RSI(14)`** | *"Has price stretched way too far like a rubber band and is about to snap back?"* | Used only in calm sideways (`RANGE`) markets on `15M` Synthetics (`1HZ100V`, `R_75`). When price touches the bottom Bollinger Band and `RSI < 30` (oversold), the bot buys the bounce back toward the middle. |

---

### Profitability & Performance Metrics

| Metric | Plain-English Meaning | Why It Matters |
| :--- | :--- | :--- |
| **Win Rate (`WR`)** | The percentage of trades that finish in profit (`> $0`). | Tier 3 achieves a **`53.8%` Win Rate** (more than half of all trades win, AND the average winner is larger than the average loser). |
| **Profit Factor (`PF`)** | **Total Dollars Won ÷ Total Dollars Lost**.<ul><li>`PF = 1.0` means break-even.</li><li>`PF > 1.25` is solid.</li><li>`PF >= 1.40` is strong institutional-grade edge.</li></ul> | Tier 3 achieves a **`1.45` Profit Factor** — for every `$1.00` lost on losing trades, the bot earns **`$1.45`** on winning trades. |
| **Net `R`** | Total `R` (Risk Units) won minus Total `R` lost across all trades, before compounding. | Tier 3 generated **`+126.32R`** over 12 months (`784` trades). Even without compounding, at a flat `$30` stake, `+126.32R` is `+$3,789.60`. With compounding, it turned `$1,000` into **`$24,870.54`**. |
| **Max Drawdown (`MaxDD`)** | The largest temporary drop from an account's highest peak balance before recovering to a new high. | Every real strategy has losing weeks. Knowing the historical Max Drawdown (`-41.15%` at full `3.0%–3.8%` aggressive compounding) tells you what normal turbulence looks like so you don't panic during a dip. |

---

## 2. How the Tier 3 Quant Engine Works (Step-by-Step)

The engine runs 24/7 on Render (`server/quantRunner.ts`) and uses a shared mathematical brain (`src/services/quantStrategyEngine.ts`).

### Step 1: Dual-Timeframe 6-Market Basket
Instead of relying on a single asset (which might go quiet or choppy for weeks), the bot watches **6 uncorrelated markets** split across two speeds:

| Symbol | Market Name | Timeframe | Strategy Mode | Multiplier | Conviction Risk Weight (at `3.0%` Base) | Trail Exit EMA | Profit-Ratchet Schedule |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :--- |
| **`cryBTCUSD`** | Bitcoin / USD | **`1H`** | Pure Trend-Breakout (`36`-bar Donchian + `EMA 200`) | `50x` | **`3.8%`** *(Core Leader)* | `EMA(50)` | Arms at `+80%` -> Locks `+20%` floor (Uncapped upside) |
| **`cryETHUSD`** | Ethereum / USD | **`1H`** | Pure Trend-Breakout (`20`-bar Donchian, `0.75%` ATR cap) | `50x` | **`2.8%`** *(Diversifier)* | `EMA(50)` | Arms at `+80%` -> Locks `+20%` floor (Uncapped upside) |
| **`frxXAUUSD`** | Gold / USD | **`1H`** | Pure Trend-Breakout (`20`-bar Donchian) | `100x` | **`2.8%`** *(Diversifier)* | `EMA(50)` | Wide `EMA(50)` Trend Trail (Uncapped upside) |
| **`frxXAGUSD`** | Silver / USD | **`1H`** | Pure Trend-Breakout (`20`-bar Donchian) | `100x` | **`2.8%`** *(Diversifier)* | `EMA(20)` | Arms at `+80%` -> Locks `+20%` floor (Uncapped upside) |
| **`1HZ100V`** | Volatility 100 (1s) | **`15M`** | Trend (`EMA 200`) + Mean-Reversion | `40x` | **`3.8%`** *(Core Leader)* | `EMA(30)` | Stage 1: `+75%` -> `+20%` floor<br>Stage 2: `+120%` -> `+60%` floor<br>Hardware TP: `+200%` (Trend) / `+120%` (MR) |
| **`R_75`** | Volatility 75 Index | **`15M`** | Trend (`EMA 50`) + Mean-Reversion | `50x` | **`3.8%`** *(Core Leader)* | `EMA(50)` | Stage 1: `+75%` -> `+20%` floor<br>Stage 2: `+120%` -> `+60%` floor<br>Hardware TP: `+200%` (Trend) / `+120%` (MR) |

---

### Step 2: Market Regime Classification (Filter Out Bad Markets First)
On every closed candle, the bot measures `ADX(14)` and `ATR%(14)` and puts the market into one of 4 buckets:
1. **`CHAOS` (Danger — Stand Down)**: Volatility (`ATR%`) is above the safety ceiling (`1.2%` on `15M`, `2.5%` on `1H`, or `0.75%` on `cryETHUSD`). **Action: `HOLD`.**
2. **`NEUTRAL` (Choppy — Stand Down)**: `ADX` is between `20` and `25`. Neither a clean trend nor a clean range. **Action: `HOLD`.**
3. **`TREND` (`ADX >= 25`)**: Strong directional momentum.
   - Checks that price is above `EMA(50)` (and `EMA(200)` on `cryBTCUSD` and `1HZ100V`) and the EMA is sloping upward (for `MULTUP`), or below and sloping downward (for `MULTDOWN`).
   - Checks that the latest closed candle broke above the highest high (or below the lowest low) of the previous `20` candles (`36` on `cryBTCUSD`).
   - **Body Conviction Filter**: Checks that the candle body is at least `35%` of the candle's total range (`|Close - Open| / (High - Low) >= 0.35`) so the bot never buys a weak "wick fakeout."
4. **`RANGE` (`ADX < 20` — `15M` Synthetics Only)**:
   - On `1H` Crypto and Metals (`cryBTCUSD`, `cryETHUSD`, `frxXAUUSD`, `frxXAGUSD`), sideways range trading is disabled (`pureTrendOnly: true`) because macro assets trend heavily and whipsaw in ranges.
   - On `15M` Synthetics (`1HZ100V`, `R_75`), when `ADX < 20`, if price touches the lower Bollinger Band and `RSI(14) < 30`, the bot enters `MULTUP` aiming for a quick snap-back (`+1.2R` Take-Profit or `RSI > 58`).

---

### Step 3: Why `1H` Trades Have No Take-Profit Number on Deriv (And How the Bot Exits Winning Trades)

1. **On `1H` Trend Trades (`cryBTCUSD`, `cryETHUSD`, `frxXAUUSD`, `frxXAGUSD`), the upside is intentionally uncapped (`takeProfitPrice: null`)** so that when Bitcoin, Gold, or Silver goes on a massive multi-day run (`+3R`, `+5R`, `+10R`), a fixed ceiling doesn't cut your biggest winners short.
2. **Instead of a fixed ceiling, the bot closes winning trades using two dynamic mechanisms**:
   - **Mechanism A — The Two-Stage Profit-Ratchet (Real-Time Tick Protection)**:
     - On **`15M` Synthetics (`1HZ100V`, `R_75`)**:
       - Once your open trade touches **`+75%` profit (`+0.75R`)**, **Stage 1 arms**: if price pulls back to **`+20%` (`+0.20R`)**, the bot immediately sells at market to guarantee a profitable trade.
       - Once your open trade touches **`+120%` profit (`+1.20R`)**, **Stage 2 arms**: your guaranteed profit floor jumps up to **`+60%` (`+0.60R`)**.
       - And if it surges all the way to **`+200%` (`+2.00R`)**, the hardware Take-Profit on Deriv cashes out the full double-stake win automatically.
     - On **`1H` Crypto & Silver (`cryBTCUSD`, `cryETHUSD`, `frxXAGUSD`)**:
       - Once your open trade touches **`+80%` profit (`+0.80R`)**, **Stage 1 arms** and locks a **`+20%` (`+0.20R`)** floor so a winning breakout that goes `+80%` in your favor can never round-trip into a `-100%` loss.
   - **Mechanism B — The Calibrated Trail EMA (`EMA 20`, `EMA 30`, or `EMA 50`)**:
     - As long as closed candles stay on the winning side of the Trail EMA (`EMA 50` on BTC, ETH, Gold, and `R_75`; `EMA 30` on `1HZ100V`; `EMA 20` on Silver), the bot stays in the trade. The moment a closed candle crosses back across the Trail EMA, the bot closes the trade and banks the trend profit.

---

### Step 4: Built-In Safety Guardrails (Risk Management)
- **Max `1R` Loss Per Trade**: Every trade has a hardware Stop-Loss sent inside the Deriv `buy` order (`limit_order.stop_loss`) equal to the stake.
- **Conviction Sizing (`3.8%` / `2.8%`)**: Scales your stake to `3.8%` of equity on its 3 highest-edge markets (`cryBTCUSD`, `1HZ100V`, `R_75`) and `2.8%` on its 3 portfolio diversifiers (`cryETHUSD`, `frxXAUUSD`, `frxXAGUSD`).
- **4-Slot Portfolio Cap**: At most **4 trades** can be open across the entire account at the same time (and at most **1 trade per symbol**).
- **3-Loss Symbol Cooldown (30 Minutes)**: If any symbol suffers 3 consecutive losses, that symbol automatically pauses for **30 minutes** (`1800s`) to let choppy conditions pass, then automatically resumes.
- **6% Daily Circuit Breaker**: If total net losses in the last 24 hours ever reach `6%` of account equity, the entire engine pauses new entries until the 24-hour window clears.

---

## 3. Verified 1-Year Profitability Benchmark (`2025-11-14` to `2026-11-14`)

Tested across **157,916 real historical candles** fetched directly from Deriv's servers across all 6 symbols over 12 months (`$1,000` starting balance):

| Engine Tier | Total Trades | Win Rate | Profit Factor | Net `R` Won | `$1,000` Ending Balance | Avg Full-Month Return | Profitable Full Months | Max Drawdown |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **0. Previous Baseline Bot** (`3.0%` Risk, 3 Slots, No Ratchet) | `667` | `39.3%` | `1.29` | `+73.31R` | `$3,917.26` (`+291.7%`) | `+16.66% / mo` | `5 / 11` (`45%`) | `-44.78%` |
| **1. + Two-Stage Profit-Ratchet & Calibrated Trail EMA** | `762` | `53.4%` | `1.44` | `+121.70R` | `$8,735.98` (`+773.6%`) | `+24.79% / mo` | `7 / 11` (`64%`) | `-30.69%` |
| **2. + Silver (`frxXAGUSD 1H`) & 4-Slot Portfolio** | `784` | `53.8%` | `1.45` | `+126.32R` | `$16,642.04` (`+1,564.2%`) | `+36.74% / mo` | `8 / 11` (`73%`) | `-37.28%` |
| **3. Deployed Tier 3 (+ Conviction Sizing `2.8%–3.8%`)** | **`784`** | **`53.8%`** | **`1.45`** | **`+126.32R`** | **`$24,870.54` (`+2,387.1%`)** | **`+43.83% / mo`** | **`8 / 11` (`73%`)** | **`-41.15%`** |

### Month-by-Month Breakdown (`$1,000` Starting Balance)

| Month | Old Baseline Return (`$1,000` Start) | Tier 3 Trades | Tier 3 Win Rate | Tier 3 Net `R` | Tier 3 Monthly Return (`%`) | Tier 3 Compounded Balance |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **2025-11** *(Partial)* | `+12.7%` (`$1,127`) | `26` | `54%` | `+2.03R` | **`+6.8%`** | **`$1,068`** |
| **2025-12** | `-14.7%` (`$961`) | `68` | `56%` | `+0.33R` | **`-0.9%`** | **`$1,058`** |
| **2026-01** | `+56.2%` (`$1,502`) | `91` | `60%` | `+17.52R` | **`+65.2%`** | **`$1,748`** |
| **2026-02** | `-9.0%` (`$1,367`) | `39` | `39%` | `+4.59R` | **`+13.8%`** | **`$1,989`** |
| **2026-03** | `-4.4%` (`$1,307`) | `65` | `48%` | `+2.93R` | **`+4.6%`** | **`$2,081`** |
| **2026-04** | `-13.8%` (`$1,126`) | `61` | `49%` | `-5.02R` | **`-17.1%`** | **`$1,724`** |
| **2026-05** | `-12.4%` (`$986`) | `77` | `57%` | `-0.91R` | **`-4.3%`** | **`$1,649`** |
| **2026-06** | `+31.2%` (`$1,295`) | `62` | `53%` | `+23.56R` | **`+96.9%`** | **`$3,248`** |
| **2026-07** | `-17.5%` (`$1,068`) | `67` | `55%` | `+1.16R` | **`+1.0%`** | **`$3,281`** |
| **2026-08** | `+106.2%` (`$2,203`) | `76` | `53%` | `+47.76R` | **`+172.4%`** | **`$8,939`** |
| **2026-09** | `+10.7%` (`$2,438`) | `56` | `54%` | `+2.87R` | **`+5.7%`** | **`$9,449`** |
| **2026-10** | `+50.7%` (`$3,675`) | `74` | `62%` | `+26.63R` | **`+144.9%`** | **`$23,143`** |
| **2026-11** *(Partial)* | `+6.6%` (`$3,917`) | `22` | `41%` | `+2.86R` | **`+7.5%`** | **`$24,871`** |

---

## 4. Verified 5-Year Multi-Cycle Backtest (`2021-11-11` to `2026-11-14` — `1,826` Days)

Tested across **`132,219` hourly candles (`5` full years: `2021-11` to `2026-11`)** for the `1H` Macro Core (`cryBTCUSD`, `cryETHUSD`, and `frxXAUUSD` filtered to FX 24/5 trading hours) plus **`75,871` candles (`1` full year: `2025-11` to `2026-11`)** for `15M` Synthetics (`1HZ100V`, `R_75`) and `1H` Silver (`frxXAGUSD`):

### A. 5-Year Per-Symbol Performance (Tier 3 Engine)

| Symbol | Timeframe & History Span | Total Trades | Avg Trades / Mo | Win Rate | Profit Factor (`PF`) | Net `R` Won | Exit Breakdown (`Ratchet` / `Trail` / `TP` / `Stop-Out`) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **`cryBTCUSD` (`100x`)** | `1H` — **5 Years** (`44,073` bars) | `163` | `2.7 / mo` | **`55.8%`** | **`2.36`** | **`+95.12R`** | `66` Ratchet · `30` Trail · `0` TP · `67` KO |
| **`cryBTCUSD` (`50x`)** | `1H` — **5 Years** (`44,073` bars) | `140` | `2.3 / mo` | **`48.6%`** | **`1.95`** | **`+48.36R`** | `36` Ratchet · `76` Trail · `0` TP · `28` KO |
| **`cryETHUSD` (`100x`)** | `1H` — **5 Years** (`44,073` bars) | `152` | `2.5 / mo` | **`48.7%`** | **`1.72`** | **`+55.98R`** | `49` Ratchet · `25` Trail · `0` TP · `78` KO |
| **`cryETHUSD` (`50x`)** | `1H` — **5 Years** (`44,073` bars) | `131` | `2.2 / mo` | **`49.6%`** | **`1.46`** | **`+25.93R`** | `37` Ratchet · `54` Trail · `0` TP · `40` KO |
| **`frxXAUUSD` (`100x`)** | `1H` — **5 Years** (`44,073` bars) | `136` | `2.3 / mo` | **`41.2%`** | **`1.81`** | **`+42.28R`** | `0` Ratchet · `106` Trail · `0` TP · `30` KO |
| **`frxXAGUSD` (`100x`)** | `1H` — **1 Year** (`5,789` bars, Deriv max) | `9` | `0.8 / mo` | **`66.7%`** | **`2.43`** | **`+4.30R`** | `4` Ratchet · `2` Trail · `0` TP · `3` KO |
| **`1HZ100V` (`40x`)** | `15M` — **1 Year** (`35,041` bars, Deriv max) | `338` | `28.2 / mo` | **`50.6%`** | **`1.20`** | **`+23.85R`** | `116` Ratchet · `130` Trail · `45` TP · `47` KO |
| **`R_75` (`50x`)** | `15M` — **1 Year** (`35,041` bars, Deriv max) | `329` | `27.4 / mo` | **`57.8%`** | **`1.27`** | **`+30.58R`** | `142` Ratchet · `77` Trail · `45` TP · `65` KO |

### B. 5-Year Portfolio Summary (`$1,000` Starting Capital)

| 5-Year Portfolio Configuration | Total Trades | Win Rate | Profit Factor | Total Net `R` | `$1,000` Ending Equity | Annualized CAGR | 5-Year Max Drawdown |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Old Baseline (`1H` Macro 5Y Only)** | `458` | `34.1%` | `1.83` | `+191.83R` | `$33,644.37` (`+3,264%`) | `+102.01% / yr` | `-39.69%` |
| **Tier 3 (`1H` Macro 5Y Only @ `50x` Crypto)** | `407` | `46.4%` | `1.73` | `+116.57R` | `$18,294.41` (`+1,729%`) | `+78.84% / yr` | **`-33.69%`** |
| **Tier 3 (`1H` Macro 5Y Only @ `100x` Crypto)** | `451` | **`49.0%`** | **`1.95`** | **`+190.98R`** | **`$73,493.37` (`+7,249%`)** | **`+136.18% / yr`** | `-38.10%` |
| **Tier 3 Combined (`5Y Macro @ 50x` + `1Y Synthetics & Silver`)** | `1,080` | `51.4%` | `1.45` | `+174.75R` | **`$99,830.38` (`+9,883%`)** | **`+151.10% / yr`** | `-41.94%` |
| **Tier 3 Combined (`5Y Macro @ 100x` + `1Y Synthetics & Silver`)** | `1,124` | **`52.2%`** | **`1.57`** | **`+249.16R`** | **`$405,246.64` (`+40,425%`)** | **`+232.31% / yr`** | `-39.82%` |

### C. Year-by-Year 5-Year Progression (`$1,000` Start — Tier 3 Engine)

| Rolling 12-Month Period | Market Cycle Context | Tier 3 (`50x` Crypto / Exact Engine) | Tier 3 (`100x` Crypto Benchmark) |
| :--- | :--- | :--- | :--- |
| **Year 1** (`2021-11` -> `2022-11`) | 2022 Bear Crash (Chaos Gate active; only `39` trades) | `39t` · `35.9%` WR · `-7.80R` · `$1,000` -> **`$785.28` (`-21.5%`)** · MaxDD `-32.3%` | `39t` · `33.3%` WR · `-9.10R` · `$1,000` -> **`$727.29` (`-27.3%`)** · MaxDD `-38.1%` |
| **Year 2** (`2022-11` -> `2023-11`) | Post-FTX Recovery & Gold Breakout | `88t` · `42.0%` WR · `PF 2.06` · `+33.52R` · `$785` -> **`$1,792.25` (`+128.2%`)** · MaxDD `-21.5%` | `98t` · `49.0%` WR · `PF 2.47` · `+59.09R` · `$727` -> **`$2,613.32` (`+259.3%`)** · MaxDD `-28.3%` |
| **Year 3** (`2023-11` -> `2024-11`) | ETF Approval & Halving Cycle | `94t` · `43.6%` WR · `PF 1.37` · `+15.26R` · `$1,792` -> **`$2,643.85` (`+47.5%`)** · MaxDD `-29.0%` | `106t` · `46.2%` WR · `PF 1.86` · `+41.92R` · `$2,613` -> **`$7,719.76` (`+195.4%`)** · MaxDD `-31.0%` |
| **Year 4** (`2024-11` -> `2025-11`) | Macro Bull Expansion (`BTC`, `ETH`, `XAU`) | `80t` · `57.5%` WR · `PF 2.69` · `+40.09R` · `$2,644` -> **`$8,196.22` (`+210.0%`)** · MaxDD `-18.8%` | `91t` · `54.9%` WR · `PF 1.95` · `+34.36R` · `$7,720` -> **`$19,707.80` (`+155.3%`)** · MaxDD `-31.3%` |
| **Year 5** (`2025-11` -> `2026-11`, `1H` Macro Only) | High-Velocity Macro Trends | `106t` · `48.1%` WR · `PF 1.83` · `+35.51R` · `$8,196` -> **`$18,294.41` (`+123.2%`)** · MaxDD `-33.7%` | `117t` · `52.1%` WR · `PF 2.20` · `+64.71R` · `$19,708` -> **`$73,493.37` (`+272.9%`)** · MaxDD `-37.0%` |
| **Year 5** (`2025-11` -> `2026-11`, **Full 6-Symbol Dual Basket**) | `1H` Macro + `15M` Synthetics (`1HZ100V`, `R_75`) + Silver (`frxXAGUSD`) | `779t` · `53.5%` WR · `PF 1.34` · `+93.69R` · `$8,196` -> **`$99,830.38` (`+1,118.0%`)** · MaxDD `-41.9%` | `790t` · `54.1%` WR · `PF 1.43` · `+122.89R` · `$19,708` -> **`$405,246.64` (`+1,956.3%`)** · MaxDD `-39.8%` |

