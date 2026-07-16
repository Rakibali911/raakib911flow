import os
import math
import time
from datetime import datetime, timezone
from flask import Flask, jsonify, request, render_template
from curl_cffi import requests as creq
import pytz

app = Flask(__name__)

IST = pytz.timezone('Asia/Kolkata')
RISK_FREE_RATE = 0.05
CONTRACT_SIZE = 100

TICKERS = ["SPY", "QQQ", "GLD"]

_cache = {}
CACHE_TTL = 25
CRUMB_TTL = 900

def cache_get(key):
    item = _cache.get(key)
    if item and (time.time() - item[0] < CACHE_TTL):
        return item[1]
    return None

def cache_set(key, value):
    _cache[key] = (time.time(), value)


_session_holder = {"session": None, "crumb": None, "crumb_time": 0}

def get_session_and_crumb(force=False):
    now = time.time()
    if not force and _session_holder["session"] is not None and (now - _session_holder["crumb_time"] < CRUMB_TTL):
        return _session_holder["session"], _session_holder["crumb"]

    session = creq.Session(impersonate="chrome110")
    crumb = None
    try:
        r0 = session.get("https://fc.yahoo.com", timeout=10)
        print(f"[warmup] fc.yahoo.com status={r0.status_code}")
    except Exception as e:
        print(f"cookie warm-up failed: {e}")
    try:
        r = session.get("https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=10)
        print(f"[crumb] status={r.status_code} body={r.text[:200]!r}")
        if r.status_code == 200 and r.text and "<html" not in r.text.lower():
            crumb = r.text.strip()
    except Exception as e:
        print(f"crumb fetch failed: {e}")

    _session_holder["session"] = session
    _session_holder["crumb"] = crumb
    _session_holder["crumb_time"] = now
    return session, crumb


def yahoo_get(url, params=None, retry=True):
    session, crumb = get_session_and_crumb()
    p = dict(params or {})
    if crumb:
        p["crumb"] = crumb
    try:
        r = session.get(url, params=p, timeout=15)
        if r.status_code != 200:
            print(f"[yahoo_get] {url} status={r.status_code} body={r.text[:300]!r}")
            if retry:
                session, crumb = get_session_and_crumb(force=True)
                p2 = dict(params or {})
                if crumb:
                    p2["crumb"] = crumb
                r = session.get(url, params=p2, timeout=15)
                print(f"[yahoo_get retry] {url} status={r.status_code} body={r.text[:300]!r}")
        return r.json()
    except Exception as e:
        print(f"yahoo_get error for {url}: {e}")
        return None


def norm_pdf(x):
    return (1.0 / math.sqrt(2 * math.pi)) * math.exp(-0.5 * x * x)

def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2)))

def bs_delta_gamma(S, K, T, r, sigma, option_type):
    if T <= 0:
        T = 0.0007
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
    price = 0.0
    try:
        data = yahoo_get(f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}")
        price = float(data["chart"]["result"][0]["meta"]["regularMarketPrice"])
    except Exception as e:
        print(f"spot price error for {ticker}: {e}")
    cache_set(key, price)
    return price


def get_raw_expiries(ticker):
    try:
        data = yahoo_get(f"https://query2.finance.yahoo.com/v7/finance/options/{ticker}")
        if data is None:
            print(f"expiries: no data returned for {ticker}")
            return []
        if "optionChain" not in data:
            print(f"expiries: unexpected response for {ticker}: {str(data)[:400]}")
            return []
        result = data["optionChain"]["result"][0]
        return result.get("expirationDates", [])
    except Exception as e:
        print(f"expiries error for {ticker}: {e}")
        return []


def get_option_chain_for_date(ticker, unix_ts):
    try:
        data = yahoo_get(f"https://query2.finance.yahoo.com/v7/finance/options/{ticker}", {"date": unix_ts})
        if data is None or "optionChain" not in data:
            print(f"chain: unexpected response for {ticker} {unix_ts}: {str(data)[:400]}")
            return [], []
        result = data["optionChain"]["result"][0]
        opt = result["options"][0]
        return opt.get("calls", []), opt.get("puts", [])
    except Exception as e:
        print(f"chain error for {ticker} {unix_ts}: {e}")
        return [], []


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

    raw_dates = get_raw_expiries(ticker)
    if not raw_dates:
        return jsonify({"expiries": [], "error": "Could not fetch expiries"})

    today = datetime.now(IST).date()
    result = []
    for unix_ts in raw_dates:
        exp_date = datetime.fromtimestamp(unix_ts, tz=timezone.utc).astimezone(IST).date()
        dte = (exp_date - today).days
        if dte < 0 or dte > 60:
            continue
        calls, puts = get_option_chain_for_date(ticker, unix_ts)
        oi_total = sum(c.get("openInterest", 0) or 0 for c in calls) + sum(p.get("openInterest", 0) or 0 for p in puts)
        result.append({
            "dte": dte,
            "date": exp_date.strftime("%b %d"),
            "expiry": str(unix_ts),
            "oi": oi_total
        })

    result.sort(key=lambda x: x["dte"])
    payload = {"expiries": result}
    cache_set(key, payload)
    return jsonify(payload)


@app.route("/api/gex")
def api_gex():
    ticker = request.args.get("ticker", "SPY").upper()
    expiries_param = request.args.get("expiries", "")

    if not expiries_param:
        return jsonify({"error": "No expiries selected"}), 400

    selected_expiries = expiries_param.split(",")
    spot = get_spot_price(ticker)
    if spot <= 0:
        return jsonify({"error": "Could not fetch live spot price. Try again."}), 400

    today = datetime.now(IST).date()
    strike_map = {}

    for unix_str in selected_expiries:
        try:
            unix_ts = int(unix_str)
            exp_date = datetime.fromtimestamp(unix_ts, tz=timezone.utc).astimezone(IST).date()
            T = max((exp_date - today).days, 0) / 365.0
            calls, puts = get_option_chain_for_date(ticker, unix_ts)
        except Exception as e:
            print(f"gex chain error for {ticker} {unix_str}: {e}")
            continue

        for row in calls:
            K = float(row.get("strike", 0))
            oi = float(row.get("openInterest", 0) or 0)
            iv = float(row.get("impliedVolatility", 0.25) or 0.25)
            if oi <= 0 or K <= 0:
                continue
            delta, gamma = bs_delta_gamma(spot, K, T, RISK_FREE_RATE, iv, "call")
            gex = gamma * oi * CONTRACT_SIZE * spot * spot * 0.01
            dex = delta * oi * CONTRACT_SIZE * spot
            s = strike_map.setdefault(K, {"gex": 0.0, "dex": 0.0, "call_gex": 0.0, "put_gex": 0.0})
            s["gex"] += gex
            s["dex"] += dex
            s["call_gex"] += gex

        for row in puts:
            K = float(row.get("strike", 0))
            oi = float(row.get("openInterest", 0) or 0)
            iv = float(row.get("impliedVolatility", 0.25) or 0.25)
            if oi <= 0 or K <= 0:
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

    max_pain_strike = strikes[0]
    min_payout = None
    for candidate in strikes:
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
