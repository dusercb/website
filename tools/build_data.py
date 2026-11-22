"""Build the website's data files from the real project folders.

Every chart on the site is drawn from these JSON files, and every JSON file is
derived here from the projects' own outputs: the live bot's session recordings,
the backtester's result runs and IBKR caches, the OCR pipeline's per-day results,
and Lumina's cached face landmarks. Re-run after new sessions or backtests:

    python tools/build_data.py

Paths are resolved relative to this repo (the projects are its siblings). The
script is read-only towards the projects and writes only to site/data/ and
site/assets/img/. It deliberately drops anything private on the way through:
broker account ids never leave the recordings.
"""
from __future__ import annotations

import csv
import glob
import json
import math
import os
import re
import shutil
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.normpath(os.path.join(HERE, "..", "site"))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))  # .../aislop

BOT = os.path.join(ROOT, "VPS_trading_bot_v1")
BT = os.path.join(ROOT, "back_tester_v1", "ibkr_premarket_backtester")
OCR = os.path.join(ROOT, "BACK_TESTING_DATA", "automated_proj_1")
REA = os.path.join(ROOT, "REA")

# Showcase choices (all real): the session behind the hero + the Parity replay,
# the backtest run, the trade replayed tick by tick, and the OCR demo day.
HERO_SESSION = "2026-08-14"
BT_RUN = "run_20260812_171917"
TRADE = ("FLYX", "2026-01-08")
TAPE_DAY = "2026-08-04"

csv.field_size_limit(10**9)


def out(name: str, obj) -> None:
    path = os.path.join(SITE, "data", name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  wrote data/{name}  {os.path.getsize(path) / 1024:.1f} KB")


def r(x, n=2):
    return None if x is None else round(float(x), n)


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace(" ", "T"))


# --------------------------------------------------------------------------- hero
def read_session(date: str):
    """Yield the decoded events of one recorded session."""
    with open(os.path.join(BOT, "recordings", f"session_{date}.jsonl"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


def build_hero() -> dict:
    """One premarket as the bot saw it: every symbol it streamed, 04:00-09:35 ET,
    resampled from its 10-second bars to 1-minute bins.
      rv   -- each minute's volume as a share of the symbol's busiest minute,
              linear 0-99, two characters per minute
      hod  -- '1' in each minute the symbol printed a new high of day, else '0'
      gain / hi / hodMin / totalVol -- the readout shown on hover"""
    frames: dict[str, list] = {}
    for ev in read_session(HERO_SESSION):
        if ev.get("kind") == "frame":
            sym, bars = ev["symbol"], ev["bars"]
            if sym not in frames or len(bars) > len(frames[sym]):
                frames[sym] = bars

    minutes = list(range(4 * 60, 9 * 60 + 35))  # 04:00 .. 09:34 (335 minutes)
    series = []
    peak_logvol = 0.0
    vol_by_min_all: dict[str, Counter] = {}
    for sym, bars in frames.items():
        close_by_min: dict[int, float] = {}
        vol_by_min: Counter = Counter()
        hod_minutes: set[int] = set()
        hi_px, hi_min = -1.0, None
        for ts, o, h, l, c, v in bars:
            t = parse_ts(ts)
            m = t.hour * 60 + t.minute
            if m < minutes[0] or m > minutes[-1]:
                continue
            close_by_min[m] = c
            vol_by_min[m] += v or 0
            if h > hi_px:
                if hi_px > 0 and (v or 0) > 0:
                    hod_minutes.add(m)
                hi_px, hi_min = h, m
        if len(close_by_min) < 20:
            continue
        first_min = min(close_by_min)
        base = bars[0][1] if parse_ts(bars[0][0]).hour * 60 + parse_ts(bars[0][0]).minute <= first_min else close_by_min[first_min]
        vals, last = [], close_by_min[first_min]
        for m in minutes:
            if m in close_by_min:
                last = close_by_min[m]
            vals.append(round((last / base - 1) * 100, 1))
        vmax = max(vol_by_min.values()) or 1
        vol = "".join(
            str(min(9, int(round(9 * math.log1p(vol_by_min.get(m, 0)) / math.log1p(vmax))))) for m in minutes
        )
        logv = [math.log1p(vol_by_min.get(m, 0)) for m in minutes]
        peak_logvol = max(peak_logvol, max(logv))
        vol_by_min_all[sym] = vol_by_min
        series.append({
            "s": sym,
            "open": r(base, 4),
            "hi": r(hi_px, 4),
            "gain": round((hi_px / base - 1) * 100, 1),
            "hodMin": hi_min - minutes[0] if hi_min is not None else None,
            "start": first_min - minutes[0],
            "totalVol": int(sum(vol_by_min.values())),
            "hodBreaks": len(hod_minutes),
            "v": vals,
            "vol": vol,
            "hod": "".join("1" if m in hod_minutes else "0" for m in minutes),
            "_logv": logv,
        })
    for s in series:
        s.pop("_logv")
        # rv: each minute's volume as a share of this symbol's own busiest minute (linear, 0-99)
        mv = [vol_by_min_all[s["s"]].get(m, 0) for m in minutes]
        top = max(mv) or 1
        s["rv"] = "".join(f"{min(99, int(round(99 * x / top))):02d}" for x in mv)
        # the hero draws volume; price survives as the readout fields above
        s.pop("v")
        s.pop("vol")
    series.sort(key=lambda s: s["gain"])
    data = {"date": HERO_SESSION, "startMin": minutes[0], "n": len(minutes), "series": series}
    out("hero.json", data)
    return data


# --------------------------------------------------------------------------- parity
SAFE_IB_CODES = {2104, 2106, 2107, 2158}


def build_parity() -> dict:
    """The same session as a sanitized event stream (seconds after 04:00 ET),
    plus a status table of every recorded session for the CLI easter egg."""
    events = []
    first_bar_offset = None
    ib_msgs = 0
    for ev in read_session(HERO_SESSION):
        k = ev.get("kind")
        if k == "frame" and first_bar_offset is None:
            first_bar_offset = parse_ts(ev["bars"][0][0]).utcoffset()
    off = first_bar_offset or timedelta(hours=-4)
    t0 = None

    def secs(ts: str) -> float:
        t = parse_ts(ts) + off  # wall clock ET
        return round((t.hour * 3600 + t.minute * 60 + t.second + t.microsecond / 1e6) - 4 * 3600, 2)

    for ev in read_session(HERO_SESSION):
        k = ev.get("kind")
        t = secs(ev["ts"])
        s = ev.get("symbol") or ev.get("ticker")
        e = None
        if k == "session_meta":
            e = {"sha": (ev.get("signal_sha") or "")[:7], "trading": ev.get("trading")}
        elif k == "connected":
            e = {"port": ev.get("port"), "attempt": ev.get("attempt")}
        elif k == "trading_armed":
            e = {"account": "paper"}  # the real account id is never published
        elif k == "ib_message":
            if ev.get("code") in SAFE_IB_CODES and ib_msgs < 6:
                ib_msgs += 1
                e = {"code": ev.get("code"), "msg": ev.get("msg")}
        elif k == "scanner_seen":
            e = {}
        elif k == "backfill":
            e = {"bars": ev.get("bars")}
        elif k == "confirm":
            e = {"float": ev.get("float_shares"), "adv": r(ev.get("daily_avg_volume"), 0), "why": ev.get("reason")}
        elif k in ("demoted",):
            e = {}
        elif k in ("tick_slot_acquired", "tick_slot_released"):
            e = {"used": ev.get("used")}
        elif k == "tick_fire":
            e = {"engine": ev.get("engine"), "dir": ev.get("direction"), "trigger": ev.get("trigger"),
                 "fill": ev.get("fill"), "stop": ev.get("stop"), "target": ev.get("target")}
        elif k == "entry_submitted":
            e = {"dir": ev.get("direction"), "shares": ev.get("shares"), "limit": ev.get("limit")}
        elif k == "entry_unfilled":
            e = {"status": ev.get("status")}
        elif k == "position_opened":
            e = {"dir": ev.get("direction"), "shares": ev.get("shares"), "entry": r(ev.get("entry"), 4),
                 "stop": ev.get("stop"), "target": ev.get("target"), "mode": ev.get("exit_mode")}
        elif k == "position_closed":
            e = {"reason": ev.get("reason"), "exit": r(ev.get("exit"), 4), "shares": ev.get("shares"),
                 "pnl": ev.get("pnl"), "session": ev.get("realized_session_pnl")}
        elif k == "exit_submitted":
            e = {"reason": ev.get("reason"), "shares": ev.get("shares"), "src": ev.get("source")}
        elif k == "reconcile_alarm":
            e = {"detail": re.sub(r"\bDU\w+", "paper", ev.get("detail", ""))}
        elif k == "intended_trade":
            e = {"dir": ev.get("direction"), "entry": ev.get("entry_price"), "stop": ev.get("stop_price"),
                 "target": ev.get("target_price"), "result": ev.get("result_so_far")}
        elif k == "session_end":
            e = {"reason": ev.get("reason")}
        elif k == "summary":
            e = {key: ev.get(key) for key in ("tracked", "scanner_seen", "intended_trades", "closed_trades", "realized_pnl", "open_at_end")}
        if e is None:
            continue
        row = [t, k]
        if s:
            row.append(s)
        else:
            row.append(None)
        row.append(e)
        events.append(row)
    events.sort(key=lambda x: x[0])

    # Every recorded session, for `live_bot status` (counts only).
    sessions = []
    total_bytes = 0
    for fn in sorted(glob.glob(os.path.join(BOT, "recordings", "session_*.jsonl"))):
        size = os.path.getsize(fn)
        total_bytes += size
        date = os.path.basename(fn)[8:18]
        summ, frames, n = None, 0, 0
        with open(fn, encoding="utf-8") as f:
            for line in f:
                n += 1
                if '"kind": "summary"' in line:
                    summ = json.loads(line)
                elif '"kind": "frame"' in line:
                    frames += 1
        if not summ:
            continue
        sessions.append({
            "date": date, "events": n, "kb": round(size / 1024), "tracked": summ.get("tracked"),
            "seen": summ.get("scanner_seen"), "intended": summ.get("intended_trades"),
            "closed": summ.get("closed_trades"), "frames": frames,
        })
    data = {
        "date": HERO_SESSION,
        "events": events,
        "sessions": sessions,
        "totals": {"sessions": len(sessions), "mb": round(total_bytes / 1e6), "files": len(glob.glob(os.path.join(BOT, "recordings", "*.jsonl")))},
    }
    out("parity.json", data)
    return data


# --------------------------------------------------------------------------- hindsight
def load_bars(ticker: str, date: str):
    path = os.path.join(BT, "data", "cache", f"{ticker}_{date}_10secs.csv")
    rows = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            t = parse_ts(row["date"])
            if t.date().isoformat() != date:
                continue
            sec = t.hour * 3600 + t.minute * 60 + t.second
            if 4 * 3600 <= sec < 9 * 3600 + 30 * 60:
                rows.append([sec, float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"]), float(row["volume"])])
    return rows


def load_ticks(ticker: str, date: str, keep: set[str] | None = None):
    """Cached tick windows (optionally only the `keep` start times), with ticks
    spread across their whole second in sequence order (IBKR stamps historical
    ticks to the second). Exchanges are indexed into a shared `ex` list."""
    windows = {}
    exchanges: list[str] = []
    for path in sorted(glob.glob(os.path.join(BT, "data", "cache", "ticks", f"{ticker}_{date}_*_ticks.csv"))):
        m = re.search(r"_(\d{6})_(\d{6})_ticks\.csv$", path)
        start = m.group(1)
        if keep and start not in keep:
            continue
        w0 = int(start[:2]) * 3600 + int(start[2:4]) * 60 + int(start[4:])
        raw = []
        with open(path, newline="") as f:
            for row in csv.DictReader(f):
                t = parse_ts(row["time"])
                sec = t.hour * 3600 + t.minute * 60 + t.second
                raw.append((sec, float(row["price"]), float(row["size"]), row["exchange"]))
        per_sec = Counter(x[0] for x in raw)
        seen = Counter()
        ticks = []
        for sec, px, size, ex in raw:
            i = seen[sec]
            seen[sec] += 1
            if ex not in exchanges:
                exchanges.append(ex)
            ticks.append([round(sec - w0 + (i + 0.5) / per_sec[sec], 3), px, int(size), exchanges.index(ex)])
        windows[start] = {"t0": w0, "ticks": ticks}
    return windows, exchanges


def build_hindsight() -> dict:
    run = os.path.join(BT, "results", BT_RUN)
    summary = json.load(open(glob.glob(os.path.join(run, "summary_*.json"))[0], encoding="utf-8"))
    rows = list(csv.DictReader(open(glob.glob(os.path.join(run, "backtest_trades_*.csv"))[0], newline="", encoding="utf-8")))

    # The dip engine's funnel: every ticker-day appears once with either a blank
    # entry_mode (rejected before any engine ran) or 'dip_red_break'.
    dip_rows = [x for x in rows if x["entry_mode"] in ("", "dip_red_break")]
    res = Counter(x["result"] for x in dip_rows)
    did_not = res["DID_NOT_QUALIFY"]
    funnel = [
        ["Ticker-days harvested", summary["candidates"]],
        ["Blackout dates", res["SKIPPED_BLACKOUT_DATE"]],
        ["Outside price band", res["SKIPPED_PRICE_FILTER"]],
        ["Float too large", res["SKIPPED_FLOAT_FILTER"]],
        ["Not enough history", res["INSUFFICIENT_DATA"]],
        ["No volume / gain spike", did_not],
        ["Pullback broke the rip", res["INVALID_RETRACE"]],
        ["High-of-day went stale", res["STALE_HOD"]],
        ["Never triggered", res["NO_TRIGGER"]],
        ["Trades", res["WIN"] + res["LOSS"]],
    ]
    check = sum(v for _, v in funnel[1:])
    assert check == summary["candidates"], (check, summary["candidates"])

    gate_cols = [c for c in rows[0].keys() if c.startswith("skipped_") and c not in ("skipped_spread_too_wide",)]
    gates = Counter()
    touches = 0
    for x in rows:
        if x["entry_mode"] != "dip_red_break":
            continue
        touches += int(float(x["trigger_touches"] or 0))
        for c in gate_cols:
            gates[c] += int(float(x[c] or 0))

    def r_list(mode):
        tr = [x for x in rows if x["entry_mode"] == mode and x["result"] in ("WIN", "LOSS", "EXIT_AT_OPEN") and x["r_multiple"]]
        tr.sort(key=lambda x: (x["date"], x["entry_time"]))
        return [round(float(x["r_multiple"]), 3) for x in tr]

    q = summary["quant"]["per_strategy"]

    def pick(d):
        keys = ("n", "wins", "losses", "win_rate_pct", "mean_r", "median_r", "sum_r", "avg_win_r", "avg_loss_r",
                "profit_factor", "best_r", "worst_r", "avg_hold_min", "median_hold_min")
        o = {k: d.get(k) for k in keys}
        o["sig"] = d.get("significance")
        return o

    ticker, date = TRADE
    trade_row = next(x for x in rows if x["ticker"] == ticker and x["date"] == date and x["entry_mode"] == "dip_red_break")
    keep = ("ticker", "date", "result", "reason", "prev_close", "premarket_open", "premarket_high", "premarket_high_time",
            "premarket_gain_pct", "premarket_volume", "pullback_low", "pullback_low_time", "pullback_retrace_pct",
            "trigger_time", "trigger_price", "entry_time", "entry_price", "slippage", "target_price", "stop_price",
            "exit_time", "exit_price", "exit_legs", "trail_stop_final", "r_multiple", "mfe", "mae", "rip_low",
            "float_shares", "max_rvol_seen", "entry_fill_source", "exit_fill_source", "trigger_touches")
    trade = {k: trade_row[k] for k in keep}
    trade["exit_legs"] = json.loads(trade["exit_legs"]) if trade["exit_legs"] else []

    bars = load_bars(ticker, date)
    # The two windows the site draws: the entry bar (trigger cross, fill, and the
    # 1R bank a second later) and the bar where the trailed runner was stopped.
    entry_w = parse_ts(trade["trigger_time"]).strftime("%H%M%S")
    exit_w = parse_ts(trade["exit_time"])
    exit_w = (exit_w - timedelta(seconds=exit_w.second % 10)).strftime("%H%M%S")
    ticks, exchanges = load_ticks(ticker, date, keep={entry_w, exit_w})

    cache = os.path.join(BT, "data", "cache")
    cache_bytes = 0
    for dirpath, _, files in os.walk(cache):
        for fn in files:
            cache_bytes += os.path.getsize(os.path.join(dirpath, fn))

    data = {
        "run": BT_RUN,
        "trade": trade,
        "bars": bars,
        "ticks": ticks,
        "exchanges": exchanges,
        "windows": {"entry": entry_w, "exit": exit_w},
        "latency": 0.1,
        "funnel": funnel,
        "touches": touches,
        "gates": dict(gates),
        "strategies": {"dip": pick(q["dip_red_break"]), "wedge": pick(q["wedge_break"])},
        "rDip": r_list("dip_red_break"),
        "rWedge": r_list("wedge_break"),
        "runs": len(glob.glob(os.path.join(BT, "results", "run_*"))),
        "cache": {
            "barFiles": len(glob.glob(os.path.join(cache, "*_10secs.csv"))),
            "tickWindows": len(glob.glob(os.path.join(cache, "ticks", "*_ticks.csv"))),
            "baselines": len(glob.glob(os.path.join(cache, "daily_volume", "*"))),
            "gb": round(cache_bytes / 1e9, 1),
        },
        "monteCarlo": {k: summary["monte_carlo"].get(k) for k in ("iterations", "mode")},
    }
    out("hindsight.json", data)
    return data


# --------------------------------------------------------------------------- tape reader
def build_tape() -> dict:
    results = sorted(glob.glob(os.path.join(OCR, "output", "results", "*.json")))
    cal = []
    frames = ocr_s = unl = 0
    uniq = set()
    for fn in results:
        d = json.load(open(fn, encoding="utf-8"))
        tick = d.get("tickers") or []
        counts = d.get("counts") or {}
        top = sorted(tick, key=lambda t: -counts.get(t, 0))[:3]
        cal.append([d["date"], len(tick), " ".join(top)])
        frames += d.get("total_frames") or 0
        ocr_s += d.get("ocr_seconds") or 0
        unl += len(d.get("unlisted_tickers") or [])
        uniq.update(tick)
    with open(os.path.join(OCR, "output", "tickers.csv"), encoding="utf-8") as f:
        catalogue_rows = sum(1 for line in f if line.strip()) - 0
    status = json.load(open(os.path.join(OCR, "output", "status.json"), encoding="utf-8"))
    st = Counter((v.get("status") if isinstance(v, dict) else v) for v in status.values())
    boundary = json.load(open(os.path.join(OCR, "output", "layout_boundary.json"), encoding="utf-8"))

    day = json.load(open(os.path.join(OCR, "output", "results", f"{TAPE_DAY}.json"), encoding="utf-8"))
    demo = {
        "date": day["date"],
        "frames": day["total_frames"],
        "ocrSeconds": day["ocr_seconds"],
        "order": day["order"],
        "counts": day["counts"],
        "conf": day["best_conf"],
        "unlisted": day["unlisted_tickers"],
        "unlistedCounts": day["unlisted_counts"],
        "unlistedConf": day["unlisted_best_conf"],
        "probe": day.get("probe"),
        # filters.py's thresholds, so the browser applies the pipeline's own rules
        "refine": json.load(open(os.path.join(OCR, "config.json"), encoding="utf-8")).get("refine", {}),
    }
    loc = sum(sum(1 for _ in open(p, encoding="utf-8", errors="ignore")) for p in glob.glob(os.path.join(OCR, "*.py")))
    data = {
        "demo": demo,
        "calendar": cal,
        "totals": {
            "days": len(results), "frames": frames, "ocrHours": round(ocr_s / 3600, 1),
            "rows": catalogue_rows, "unique": len(uniq), "unlistedReads": unl, "loc": loc,
        },
        "status": dict(st),
        "boundary": {"stoppedAt": boundary.get("stopped_at"), "oldest": boundary.get("oldest_day_collected"),
                     "failed": boundary.get("failed_days")},
    }
    out("tape.json", data)
    return data


# --------------------------------------------------------------------------- lumina
TOOL_BLURBS = {
    "Auto": "One tap: spots cleared, eyes and teeth brightened, dark circles lifted. Never smooths skin.",
    "Smooth": "Smoothing only where you paint it. Depth puts light and shadow back; Stubble keeps beard texture.",
    "Blemish": "Tap a spot to heal it, or let Find spots do it, leaving moles and freckles alone.",
    "Eraser": "Paint over a stray hair or object and it is rebuilt from the texture around it.",
    "Stamp": "A clone stamp with a feathered edge that replays exactly on undo.",
    "Wrinkles": "Lifts the shadow inside a crease toward the skin around it, so the texture stays.",
    "Concealer": "Dark spots, eye bags and tear troughs evened out by dodge and burn.",
    "Matte": "Turns shine down across three bands of detail, so pores survive.",
    "Texture": "Paints fine pore grain back over skin that was smoothed.",
    "Details": "Sharpens face, body and background by their own amounts.",
    "Eyes": "Whites, irises, dark circles, red-eye, iris size and colour. Closed eyes are left alone.",
    "Teeth": "Whiten, lift stains, and align the teeth's edge onto a smooth curve.",
    "Skin": "Tone from Fair to Deep or any colour, redness, and tan, sun-kissed or glass-skin looks.",
    "Fillers": "Fills hollows at the temples, cheeks and eyes with light, and plumps the lips.",
    "Age": "One slider moves 18 signs of age, each arriving at its own point, down to grey hair strand by strand.",
    "Sculpt": "50 face controls in seven tabs. Neighbouring features stay put and the outline never tears.",
    "Reshape": "Push, resize and restore, plus Protect, which holds against every warp.",
    "Body": "Slim, waist, hips, legs and posture, while arms and hands keep their shape.",
    "Makeup": "Lips in nine finishes, eyeshadow, liner, lashes, brows, blush, contour and freckles, plus saved looks.",
    "Hair": "17 shades laid along the hair's own light and matted strand by strand. Shine, smooth and volume.",
    "Relight": "Studio, neon, rim and scene lights that wrap around the face's 3D form.",
    "Background": "Shaped bokeh, colour or photo swaps, shadow and blend, with a cut-out that follows the hair.",
    "Presets": "One tap sets a filter, a little retouching and the background together.",
    "Filters": "85 colour filters in twelve groups, from film stocks to light leaks, kept off faces.",
    "Glitter": "Brush-on glitter in nine colours, and star glints on the photo's own highlights.",
    "Adjust": "Seventeen light, colour and detail controls, plus Auto.",
    "Crop": "Ratios, rotation, straightening, perspective and lens correction.",
    "Text": "Nine templates, seven fonts and five styles, neon included.",
}


def build_lumina() -> dict:
    face = json.load(open(os.path.join(REA, "app", "assets", "sample-face.json"), encoding="utf-8"))
    pts = [[round(p[0], 5), round(p[1], 5), round(p[2], 5)] for p in face["faces"][0]]
    src = open(os.path.join(REA, "app", "js", "facemesh-data.js"), encoding="utf-8").read()
    tri = [int(x) for x in re.search(r"TRIANGLES\s*=\s*new\s+\w+\(\[([^\]]*)\]", src).group(1).split(",") if x.strip()]
    face_js = open(os.path.join(REA, "app", "js", "face.js"), encoding="utf-8").read()
    idx_block = re.search(r"export const IDX = \{(.*?)\n\};", face_js, re.S).group(1)
    idx = {m.group(1): [int(v) for v in m.group(2).split(",")] for m in re.finditer(r"(\w+):\s*\[([\d,\s]+)\]", idx_block)}
    idx["irisR"] = [468, 469, 470, 471, 472]
    idx["irisL"] = [473, 474, 475, 476, 477]

    # Tool names come from the README's tool table (so new tools show up), the
    # one-line blurbs are written for the site. A tool without a blurb falls back
    # to the README's first sentence, scrubbed of any competitor's name.
    readme = open(os.path.join(REA, "README.md"), encoding="utf-8").read()
    tools = []
    for m in re.finditer(r"^\| ([A-Z][^|]+?) \| (.+?) \|$", readme.split("## Run it")[0], re.M):
        name, desc = m.group(1).strip(), m.group(2).strip()
        if name in ("Tool", "---") or name.startswith("Freeze bg"):
            continue
        blurb = TOOL_BLURBS.get(name)
        if not blurb:
            blurb = re.sub(r"\bAirBrush('s)?\s*", "", re.split(r"(?<=\.)\s", desc, maxsplit=1)[0]).strip()
            blurb = blurb[:1].upper() + blurb[1:]
        tools.append([name, blurb])
    loc = 0
    for p in glob.glob(os.path.join(REA, "app", "js", "*.js")) + [os.path.join(REA, "app", "index.html")]:
        if p.endswith("facemesh-data.js"):
            continue
        loc += sum(1 for _ in open(p, encoding="utf-8", errors="ignore"))
    sculpt_src = open(os.path.join(REA, "app", "js", "sculpt.js"), encoding="utf-8").read()
    sculpt = len(re.findall(r"^\s*C\('\w+', '\w+'", sculpt_src, re.M))
    data = {"w": 999, "h": 1600, "pts": pts, "tris": tri, "idx": idx, "tools": tools, "loc": loc, "sculpt": sculpt}
    out("lumina.json", data)

    try:
        from PIL import Image
        im = Image.open(os.path.join(REA, "app", "assets", "sample.jpg")).convert("RGB")
        im.save(os.path.join(SITE, "assets", "img", "lumina-sample.jpg"), quality=86, optimize=True, progressive=True)
        print("  wrote assets/img/lumina-sample.jpg")
    except Exception as exc:  # PIL is optional; fall back to a straight copy
        shutil.copy(os.path.join(REA, "app", "assets", "sample.jpg"), os.path.join(SITE, "assets", "img", "lumina-sample.jpg"))
        print("  copied assets/img/lumina-sample.jpg", exc)
    return data


# --------------------------------------------------------------------------- stats
def count_lines(paths) -> int:
    n = 0
    for p in paths:
        with open(p, encoding="utf-8", errors="ignore") as f:
            n += sum(1 for _ in f)
    return n


def count_tests(paths) -> int:
    n = 0
    for p in paths:
        with open(p, encoding="utf-8", errors="ignore") as f:
            n += sum(1 for line in f if re.match(r"\s*(async\s+)?def test_", line))
    return n


def build_stats(tape, hind, parity, lumina) -> dict:
    bt_src = glob.glob(os.path.join(BT, "premarket_backtester", "*.py")) + glob.glob(os.path.join(BT, "signal_core", "*.py"))
    bt_tests = glob.glob(os.path.join(BT, "tests", "test_*.py"))
    bot_src = glob.glob(os.path.join(BOT, "live_bot", "*.py")) + glob.glob(os.path.join(BOT, "replay", "*.py"))
    bot_tests = glob.glob(os.path.join(BOT, "tests", "test_*.py"))
    s = {
        "hindsight": {"loc": count_lines(bt_src), "testLoc": count_lines(bt_tests), "tests": count_tests(bt_tests)},
        "parity": {"loc": count_lines(bot_src), "testLoc": count_lines(bot_tests), "tests": count_tests(bot_tests)},
        "tape": {"loc": tape["totals"]["loc"]},
        "lumina": {"loc": lumina["loc"]},
    }
    s["total"] = {
        "loc": s["hindsight"]["loc"] + s["hindsight"]["testLoc"] + s["parity"]["loc"] + s["parity"]["testLoc"]
        + s["tape"]["loc"] + s["lumina"]["loc"],
        "tests": s["hindsight"]["tests"] + s["parity"]["tests"],
    }
    s["built"] = datetime.now().strftime("%Y-%m-%d")
    out("stats.json", s)
    return s


def main() -> int:
    os.makedirs(os.path.join(SITE, "data"), exist_ok=True)
    os.makedirs(os.path.join(SITE, "assets", "img"), exist_ok=True)
    print("hero / parity  <-", BOT)
    build_hero()
    parity = build_parity()
    print("hindsight      <-", BT)
    hind = build_hindsight()
    print("tape reader    <-", OCR)
    tape = build_tape()
    print("lumina         <-", REA)
    lum = build_lumina()
    stats = build_stats(tape, hind, parity, lum)
    print("totals:", json.dumps(stats["total"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
