#!/usr/bin/env python3
"""
energy_archive.py - long-term 5-minute energy archive for the Home mains "Day" graph.

Runs INSIDE the Home Assistant container:  python3 /config/energy_archive.py [YYYY-MM-DD]

For each target day it reads that day's history straight from the recorder database
(read-only), buckets it into 288 five-minute averages (carry-forward across gaps),
computes the day's import/export kWh from the meter's cumulative kWh registers, and writes
/config/www/energy-archive/YYYY-MM-DD.json. Files older than ~20 years are purged.
Days with no data are skipped. With no date arg it (re)archives a sliding window of the
last few days plus today, so a missed run self-heals as long as it runs every ~9 days.

No host dependency and no credential: script + data live under /config and it reads the
DB read-only, so it travels with HA if the instance is ever moved to the cloud.
"""
import json, os, sys, sqlite3, traceback
from datetime import datetime, timedelta

DB = "/config/home-assistant_v2.db"
OUT_DIR = "/config/www/energy-archive"
ENTITIES = [
    "sensor.p1_meter_power",
    "sensor.p1_meter_power_phase_1",
    "sensor.p1_meter_power_phase_2",
    "sensor.p1_meter_power_phase_3",
    "sensor.home_consumption_power",
    "sensor.plug_in_battery_power",
    "sensor.total_solar_power",
    "sensor.cmg1a4201v_output_power",        # Growatt live W (for the Growatt production card's past-day Day graph)
    "sensor.sb3_0_1av_41_947_pv_power",      # SMA live W (for the SMA production card's past-day Day graph)
    "sensor.plug_in_battery_state_of_charge",  # battery charge % (for the battery card's past-day % line)
]
NET = "sensor.p1_meter_power"
IMP_REG = "sensor.p1_meter_energy_import"   # cumulative kWh registers = exact billed energy
EXP_REG = "sensor.p1_meter_energy_export"
CONS = "sensor.home_consumption_power"      # household consumption (archived for the self-sufficient curve)
SELFSUFF_FILE = "selfsuff_daily.json"       # date -> [self_sufficient, grid_import, grid_export] kWh (W/M/Y bars)
SELFSUFF = {}
# self-sufficient (= consumption - grid import) via cumulative registers -> robust to recording gaps and
# matches home_consumption_today:  ss = production - grid_export - battery_charge + battery_discharge
PROD_REGS = ["sensor.cmg1a4201v_lifetime_energy_output", "sensor.sb3_0_1av_41_947_total_yield"]
BAT_CHG_REG = "sensor.plug_in_battery_energy_import"
BAT_DIS_REG = "sensor.plug_in_battery_energy_export"
BUCKET_MIN = 5
N = 24 * 60 // BUCKET_MIN          # 288 buckets/day
DAYS_BACK = 9                      # sliding re-archive window (self-heal missed runs)
RETAIN_DAYS = 20 * 366             # ~20 years
BAD = ("unavailable", "unknown", "", None)

def connect():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)

def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

def fetch_states(con, eid, start_ts, end_ts):
    """returns (value just before window, [(ts, value), ...] within window)."""
    cur = con.cursor()
    cur.execute(
        "SELECT s.state FROM states s JOIN states_meta m ON s.metadata_id=m.metadata_id "
        "WHERE m.entity_id=? AND s.last_updated_ts<? AND s.state NOT IN ('unavailable','unknown','') "
        "ORDER BY s.last_updated_ts DESC LIMIT 1", (eid, start_ts))
    row = cur.fetchone()
    before = num(row[0]) if row else None
    cur.execute(
        "SELECT s.last_updated_ts, s.state FROM states s JOIN states_meta m ON s.metadata_id=m.metadata_id "
        "WHERE m.entity_id=? AND s.last_updated_ts>=? AND s.last_updated_ts<? "
        "ORDER BY s.last_updated_ts", (eid, start_ts, end_ts))
    pts = [(r[0], num(r[1])) for r in cur.fetchall()]
    return before, [(t, v) for t, v in pts if v is not None]

def bucketize(before, pts, start_ts, fill_until):
    sums = [0.0] * N; cnts = [0] * N
    for ts, v in pts:
        idx = int((ts - start_ts) // (BUCKET_MIN * 60))
        if 0 <= idx < N:
            sums[idx] += v; cnts[idx] += 1
    out = [None] * N; carry = before
    for i in range(N):
        if cnts[i] > 0:
            out[i] = round(sums[i] / cnts[i], 1); carry = out[i]
        elif i < fill_until:
            out[i] = carry
        else:
            out[i] = None
    return out

def day_totals(net):
    """integrate 5-min net-power averages (W) -> kWh import (>0) / export (<0).
    Approximate (loses sub-5-min peaks + within-bucket import/export); kept only as a
    fallback. Exact totals come from the meter registers via register_delta()."""
    h = BUCKET_MIN / 60.0
    imp = sum(max(v, 0.0) for v in net if v is not None) * h / 1000.0
    exp = sum(max(-v, 0.0) for v in net if v is not None) * h / 1000.0
    return round(imp, 2), round(exp, 2)

def register_delta(con, eid, sts, ets):
    """exact kWh during the day = the meter's cumulative register change
    (last reading - reading at day start). Matches HA's Energy dashboard / statistics."""
    before, pts = fetch_states(con, eid, sts, ets)
    vals = [v for _, v in pts]
    if not vals:
        return None
    start_val = before if before is not None else vals[0]
    return max(0.0, round(vals[-1] - start_val, 2))

def archive_day(con, d):
    start = datetime(d.year, d.month, d.day).astimezone()   # local (Europe/Berlin) midnight
    now = datetime.now().astimezone()
    end = min(start + timedelta(days=1), now)
    if end <= start:
        return
    sts, ets = start.timestamp(), end.timestamp()
    fill_until = max(0, min(N, int(round((ets - sts) / (BUCKET_MIN * 60)))))
    series = {}
    for e in ENTITIES:
        before, pts = fetch_states(con, e, sts, ets)
        series[e] = bucketize(before, pts, sts, fill_until)
    path = os.path.join(OUT_DIR, f"{d.isoformat()}.json")
    filled = sum(1 for v in series[NET] if v is not None)
    if filled == 0:
        if os.path.exists(path):
            os.remove(path)
        print(f"{d.isoformat()}: no data, skipped")
        return
    # Exact import/export = the P1 meter's own cumulative kWh registers (matches HA's Energy
    # dashboard and the homewizard-today-card). Fall back to integrating 5-min net power only
    # if a register has no recorded data for the day.
    imp = register_delta(con, IMP_REG, sts, ets)
    exp = register_delta(con, EXP_REG, sts, ets)
    if imp is None or exp is None:
        pimp, pexp = day_totals(series[NET])
        if imp is None:
            imp = pimp
        if exp is None:
            exp = pexp
    # Self-sufficient = consumption met WITHOUT the grid = consumption - grid import.
    # Grid/Surplus = the REAL P1 meter import/export (imp/exp), so they match the Home mains card.
    # (A cons-vs-prod overlap would wrongly fold the battery's charge/discharge into grid/surplus.)
    prod_kwh = sum((register_delta(con, r, sts, ets) or 0.0) for r in PROD_REGS)
    bc = register_delta(con, BAT_CHG_REG, sts, ets) or 0.0
    bd = register_delta(con, BAT_DIS_REG, sts, ets) or 0.0
    ss = round(max(0.0, prod_kwh - exp - bc + bd), 2)   # = consumption - grid import (register-based)
    SELFSUFF[d.isoformat()] = [ss, imp, exp]
    doc = {"date": d.isoformat(), "bucket_min": BUCKET_MIN, "n": N, "series": series,
           "import_kwh": imp, "export_kwh": exp,
           "self_sufficient_kwh": ss, "ss_grid_kwh": imp, "ss_surplus_kwh": exp,
           "generated": now.isoformat()}
    with open(path, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"{d.isoformat()}: {filled}/{N} net buckets, import={imp} export={exp} kWh")

def purge_old():
    cut = (datetime.now() - timedelta(days=RETAIN_DAYS)).date()
    for fn in os.listdir(OUT_DIR):
        if fn.endswith(".json") and fn != "index.json":
            try:
                if datetime.strptime(fn[:-5], "%Y-%m-%d").date() < cut:
                    os.remove(os.path.join(OUT_DIR, fn))
            except Exception:
                pass

def write_index():
    # list of days that actually have a stored file, for the calendar picker
    dates = sorted(fn[:-5] for fn in os.listdir(OUT_DIR)
                   if fn.endswith(".json") and fn != "index.json" and len(fn) == 15)
    with open(os.path.join(OUT_DIR, "index.json"), "w") as f:
        json.dump({"dates": dates, "min": dates[0] if dates else None, "max": dates[-1] if dates else None}, f, separators=(",", ":"))
    print(f"index: {len(dates)} day(s) available")

def write_selfsuff():
    cut = (datetime.now() - timedelta(days=RETAIN_DAYS)).date()
    for k in [k for k in SELFSUFF if datetime.strptime(k, "%Y-%m-%d").date() < cut]:
        del SELFSUFF[k]
    with open(os.path.join(OUT_DIR, SELFSUFF_FILE), "w") as f:
        json.dump(SELFSUFF, f, separators=(",", ":"))
    print(f"selfsuff: {len(SELFSUFF)} day(s)")

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    try:
        with open(os.path.join(OUT_DIR, SELFSUFF_FILE)) as f:
            SELFSUFF.update(json.load(f))
    except Exception:
        pass
    if len(sys.argv) > 1:
        days = [datetime.strptime(sys.argv[1], "%Y-%m-%d").date()]
    else:
        today = datetime.now().date()
        days = [today - timedelta(days=k) for k in range(DAYS_BACK, -1, -1)]
    con = connect()
    try:
        for d in days:
            try:
                archive_day(con, d)
            except Exception as e:
                print(f"{d}: ERROR {e}")
                traceback.print_exc()
    finally:
        con.close()
    purge_old()
    write_index()
    write_selfsuff()

if __name__ == "__main__":
    main()
