import os
import math
import time
from datetime import datetime, timedelta
from flask import Flask, jsonify, request, render_template
import yfinance as yf
import pytz

app = Flask(__name__)

IST = pytz.timezone('Asia/Kolkata')
RISK_FREE_RATE = 0.05
CONTRACT_SIZE = 100

TICKERS = {
    "SPY": "SPY",
    "QQQ": "QQQ",
    "GLD": "GLD"
}

_cache = {}
CACHE_TTL = 25  # seconds, avoids hammering yfinance on rapid taps

def cache_get(key):
    item = _cache.get(key)
    if item and (time.time() - item[0] < CACHE_TTL):
        return item[1]
    return None

def cache_set(key, value):
    _cache[key] = (time.time(), value)


# ---------- Pure python Black-Scholes (no scipy) ----------
def norm_pdf(x):
    return (1.0 / math.sqrt(2 * math.pi)) * math.exp(-0.5 * x * x)

def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2)))

def bs_delta_gamma(S, K, T, r, sigma, option_type):
    if T <= 0:
        T = 0.0007  # ~6 hours, avoid div by zero on 0DTE
    if sigma <= 0:
        sigma = 0.0001
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    gamma = norm_pdf(d1) / (S * sigma * math.sqrt(T))
    if option_type == "call":
        delta = norm_cdf(d1)
    else:
        delta = norm_cdf(d1) - 1.0
    return delta, gamma


def get_spot_price(ticker):
    key = f"spot_{ticker}"
    cached = cache_get(key)
    if cached is not None:
        return cached
    t = yf.Ticker(ticker)
    price = None
    try:
        price = t.fast_info["last_price"]
    except Exception:
        hist = t.history(period="1d")
        if not hist.empty:
            price = float(hist["Close"].iloc[-1])
    if price is None:
        price = 0.0
    cache_set(key, price)
    return price


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/quotes")
def api_quotes():
    out = {}
    for sym in TICKERS:
        out[sym] = round(get_spot_price(sym), 2)
    return jsonify({"quotes": out, "updated": datetime.now(IST).strftime("%I:%M:%S %p IST")})


@app.route("/api/expiries")
def api_expiries():
    ticker = request.args.get("ticker", "SPY").upper()
    key = f"exp_{ticker}"
    cached = cache_get(key)
    if cached is not None:
        return jsonify(cached)

    t = yf.Ticker(ticker)
    try:
        all_expiries = t.options
    except Exception:
        return jsonify({"expiries": [], "error": "Could not fetch expiries"})

    today = datetime.now(IST).date()
    result = []
    for exp_str in all_expiries:
        exp_date = datetime.strptime(exp_str, "%Y-%m-%d").date()
        dte = (exp_date - today).days
        if dte < 0 or dte > 60:
            continue
        oi_total = 0
        try:
            chain = t.option_chain(exp_str)
            oi_total = int(chain.calls["openInterest"].fillna(0).sum() +
                            chain.puts["openInterest"].fillna(0).sum())
        except Exception:
            oi_total = 0
        result.append({
            "dte": dte,
            "date": exp_date.strftime("%b %d"),
            "expiry": exp_str,
            "oi": oi_total
        })

    result.sort(key=lambda x: x["dte"])
    payload = {"expiries": result}
    cache_set(key, payload)
    return jsonify(payload)


@app.route("/api/gex")
def api_gex():
    ticker = request.args.get("ticker", "SPY").upper()
    dtes_param = request.args.get("dtes", "")
    expiries_param = request.args.get("expiries", "")

    if not expiries_param:
        return jsonify({"error": "No expiries selected"}), 400

    selected_expiries = expiries_param.split(",")
    spot = get_spot_price(ticker)
    today = datetime.now(IST).date()

    t = yf.Ticker(ticker)
    strike_map = {}  # strike -> {gex, dex}

    for exp_str in selected_expiries:
        try:
            exp_date = datetime.strptime(exp_str, "%Y-%m-%d").date()
            T = max((exp_date - today).days, 0) / 365.0
            chain = t.option_chain(exp_str)
        except Exception:
            continue

        for _, row in chain.calls.iterrows():
            K = float(row["strike"])
            oi = float(row["openInterest"]) if not math.isnan(row["openInterest"]) else 0
            iv = float(row["impliedVolatility"]) if not math.isnan(row["impliedVolatility"]) else 0.25
            if oi <= 0:
                continue
            delta, gamma = bs_delta_gamma(spot, K, T, RISK_FREE_RATE, iv, "call")
            gex = gamma * oi * CONTRACT_SIZE * spot * spot * 0.01
            dex = delta * oi * CONTRACT_SIZE * spot
            s = strike_map.setdefault(K, {"gex": 0.0, "dex": 0.0, "call_gex": 0.0, "put_gex": 0.0})
            s["gex"] += gex
            s["dex"] += dex
            s["call_gex"] += gex

        for _, row in chain.puts.iterrows():
            K = float(row["strike"])
            oi = float(row["openInterest"]) if not math.isnan(row["openInterest"]) else 0
            iv = float(row["impliedVolatility"]) if not math.isnan(row["impliedVolatility"]) else 0.25
            if oi <= 0:
                continue
            delta, gamma = bs_delta_gamma(spot, K, T, RISK_FREE_RATE, iv, "put")
            gex = -1 * gamma * oi * CONTRACT_SIZE * spot * spot * 0.01
            dex = delta * oi * CONTRACT_SIZE * spot
            s = strike_map.setdefault(K, {"gex": 0.0, "dex": 0.0, "call_gex": 0.0, "put_gex": 0.0})
            s["gex"] += gex
            s["dex"] += dex
            s["put_gex"] += gex

    if not strike_map:
        return jsonify({"error": "No open interest data found for selected DTEs"}), 400

    strikes = sorted(strike_map.keys())
    gex_vals = [strike_map[k]["gex"] for k in strikes]
    dex_vals = [strike_map[k]["dex"] for k in strikes]

    net_gex = sum(gex_vals)
    net_dex = sum(dex_vals)

    call_wall = max(strike_map.items(), key=lambda kv: kv[1]["call_gex"])[0]
    put_wall = min(strike_map.items(), key=lambda kv: kv[1]["put_gex"])[0]

    # cumulative GEX for flip point (zero gamma level)
    cum = 0.0
    cum_list = []
    flip_point = strikes[0]
    prev_cum = None
    for k in strikes:
        cum += strike_map[k]["gex"]
        cum_list.append(cum)
        if prev_cum is not None and prev_cum < 0 <= cum:
            flip_point = k
        prev_cum = cum

    # max pain: strike minimizing total option holder payout
    max_pain_strike = strikes[0]
    min_payout = None
    for candidate in strikes:
        payout = 0.0
        for k in strikes:
            oi_c = strike_map[k]["call_gex"]  # proxy not exact OI, keep simple below
        # simple approximation using intrinsic value * combined magnitude as weight
        for k in strikes:
            weight = abs(strike_map[k]["gex"]) + abs(strike_map[k]["dex"]) / max(spot, 1)
            payout += max(0, candidate - k) * weight * 0  # placeholder to keep zero cost if not enough data
        # fallback simple: distance-weighted by |gex| as proxy for OI concentration
        proxy_cost = sum(abs(strike_map[k]["gex"]) * abs(candidate - k) for k in strikes)
        if min_payout is None or proxy_cost < min_payout:
            min_payout = proxy_cost
            max_pain_strike = candidate

    cumulative_gex = [{"strike": strikes[i], "value": cum_list[i]} for i in range(len(strikes))]

    cum2 = 0.0
    cumulative_dex = []
    for i, k in enumerate(strikes):
        cum2 += dex_vals[i]
        cumulative_dex.append({"strike": k, "value": cum2})

    return jsonify({
        "ticker": ticker,
        "spot": round(spot, 2),
        "strikes": strikes,
        "gex": gex_vals,
        "dex": dex_vals,
        "cumulative_gex": cumulative_gex,
        "cumulative_dex": cumulative_dex,
        "call_wall": call_wall,
        "put_wall": put_wall,
        "net_gex": round(net_gex, 2),
        "net_dex": round(net_dex, 2),
        "flip_point": flip_point,
        "max_pain": max_pain_strike,
        "updated": datetime.now(IST).strftime("%I:%M:%S %p IST")
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
