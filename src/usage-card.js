/*
 * usage-card  (v2)
 * "Power usage" with a battery-charging breakdown.
 *   line 1 (magenta)  = TOTAL consumption = appliances + battery charging   -> the envelope
 *   line 2 (purple)   = battery charging, drawn WITHIN line 1 (always <= it), faint ~20% opacity
 *   gap between them  = appliance load.   "what share of consumption goes to battery charging"
 *
 *  - Now  = live: appliance = sensor.home_consumption_power, battery = max(plug_in_battery_power,0).
 *  - Day  = that day's curves (today/recent from history; older from the long-term archive).
 *  - Week/Month/Year = energy bars: appliance (component stats) + battery charge (plug_in_battery_energy_import).
 *  Header: Usage = appliance energy, Batteries = battery-charge energy. Live: Consumption + Batteries (W).
 *  Marstek is intentionally excluded (offline); battery = HomeWizard plug-in battery only.
 */
(function () {
  const TAG = "usage-card";
  const COL = "#e040fb";          // magenta = consumption (total envelope)
  const COL2 = "#7b1fa2";         // purple = battery charging (within) — matches Home mains Phase 2
  const WINDOW = 60000, EASE = 0.14;
  const BATT_PWR = "sensor.plug_in_battery_power";          // signed: + charge / - discharge
  const BATT_STAT = "sensor.plug_in_battery_energy_import"; // cumulative charge kWh (for bars)
  const BATT_TODAY = "sensor.battery_charged_daily";        // today's charge kWh

  const ptTime = (p) => { let t = p.lu != null ? p.lu : (p.lc != null ? p.lc : (p.last_updated != null ? p.last_updated : p.last_changed)); if (t == null) return null; if (typeof t === "string") return Date.parse(t); return t < 1e12 ? t * 1000 : t; };
  const ptVal = (p) => parseFloat(p.s != null ? p.s : p.state);
  const num = (v) => { const f = parseFloat(v); return isFinite(f) ? f : null; };
  const niceStep = (v) => { if (v <= 0) return 1; const e = Math.floor(Math.log10(v)), b = Math.pow(10, e), f = v / b; const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; return nf * b; };
  const fmtPower = (w) => Math.abs(w) >= 1000 ? (w / 1000).toFixed(2) + " kW" : Math.round(w).toLocaleString() + " W";
  const fmtNum = (v) => v >= 10 ? Math.round(v).toString() : (v >= 1 ? (Math.round(v * 10) / 10).toString() : (Math.round(v * 100) / 100).toString());
  const mondayMs = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const isoWeek = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const w1 = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7); };
  function hexA(hex, a) { let h = (hex || "").trim().replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16); if (isNaN(n)) return "rgba(224,64,251," + a + ")"; return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; }

  // appliance consumption = sum(sign * energy-component change) -> matches sensor.home_consumption_today
  const COMP = [
    { id: "sensor.growatt_lifetime_energy_output", s: 1 },   // Growatt solar production
    { id: "sensor.sma_total_yield", s: 1 },        // SMA solar production
    { id: "sensor.p1_meter_energy_import", s: 1 },              // grid import
    { id: "sensor.p1_meter_energy_export", s: -1 },             // grid export
    { id: "sensor.plug_in_battery_energy_import", s: -1 },      // battery charge
    { id: "sensor.plug_in_battery_energy_export", s: 1 },       // battery discharge
  ];

  class UsageCard extends HTMLElement {
    constructor() {
      super(); this.attachShadow({ mode: "open" });
      this._period = "Day"; this._data = null; this._live = {}; this._dispMax = null;
      this._lastFetch = 0; this._fetching = false; this._built = false;
      this._raf = null; this._sampleTimer = null; this._ro = null; this._archive = null; this._archiveDate = null; this._archiveCache = {};
    }
    setConfig(config) {
      this._cfg = {
        title: config.title || "Power usage",
        power_entity: config.power_entity || "sensor.home_consumption_power",  // appliance W
        batt_entity: config.batt_entity || BATT_PWR,                           // battery W (signed)
        today_entity: config.today_entity || "sensor.home_consumption_today",  // appliance kWh today
        batt_today_entity: config.batt_today_entity || BATT_TODAY,             // battery kWh today
        period_entity: config.period_entity || "input_select.energy_period",
        date_entity: config.date_entity || "input_datetime.energy_date",
        archive_base: config.archive_base || "/local/energy-archive",
        hours: Number(config.hours) > 0 ? Number(config.hours) : 24,
        bucket: Number(config.bucket_minutes) > 0 ? Number(config.bucket_minutes) : 10,
        height: Number(config.height) > 0 ? Number(config.height) : 250,
      };
      this._built = false; this._data = null; this._dispMax = null;
    }
    getCardSize() { return Math.ceil(this._cfg.height / 50) + 2; }

    set hass(hass) {
      this._hass = hass; if (!this._built) this._build();
      const st = hass.states[this._cfg.period_entity];
      const per = st ? st.state : "Day";
      if (per !== this._period) this._setPeriod(per);
      if (this._period !== "Now") {
        const dst = hass.states[this._cfg.date_entity]; const dstr = dst ? dst.state : null;
        if (dstr !== this._selDate) { this._selDate = dstr; this._dispMax = null; }
      }
      this._updateHeader();
      if (this._period === "Week") this._loadWeek();
      else if (this._period === "Month") this._loadMonth();
      else if (this._period === "Year") this._loadYear();
      else if (this._period !== "Now") this._loadDay();
    }

    _setPeriod(per) {
      this._period = per; this._dispMax = null;
      if (per === "Now") this._startLive();
      else if (per === "Week") { this._stopLive(); this._loadWeek(); }
      else if (per === "Month") { this._stopLive(); this._loadMonth(); }
      else if (per === "Year") { this._stopLive(); this._loadYear(); }
      else { this._stopLive(); this._loadDay(); }
    }

    _build() {
      const c = this._cfg;
      this.shadowRoot.innerHTML = `
        <style>
          :host{display:block;}
          .card{background:#1c1c1e;border:1px solid #3a3a3c;border-radius:16px;padding:18px 20px 14px;position:relative;
                font-family:Inter,Roboto,-apple-system,"Segoe UI",sans-serif;color:#e6e0e9;}
          .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;}
          .title{font-size:17px;font-weight:500;color:#cbc4d2;margin:0 0 6px;}
          .readings{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;}
          .rlabel{font-size:13px;color:#fff;} .rlabel.b{margin-left:16px;}
          .num{font-size:38px;font-weight:700;letter-spacing:-.02em;line-height:1;}
          .num2{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1;}
          .unit{font-size:13px;color:#cbc4d2;}
          .now{position:absolute;top:18px;right:56px;width:155px;display:flex;flex-direction:column;gap:6px;font-size:13px;color:#cbc4d2;white-space:nowrap;visibility:hidden;}
          .nowrow{display:flex;justify-content:space-between;align-items:center;}
          .now .lbl{display:flex;align-items:center;gap:6px;}
          .now .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;}
          .now b{font-weight:700;}
          .live{display:none;align-items:center;gap:6px;font-size:12px;color:#0a84ff;margin-left:8px;}
          .live .d{width:8px;height:8px;border-radius:50%;background:#0a84ff;animation:bl 1s infinite;}
          @keyframes bl{50%{opacity:.25;}}
          .wrap{position:relative;width:100%;margin-top:12px;} canvas{display:block;width:100%;}
          .empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#cbc4d2;font-size:13px;}
        </style>
        <div class="card">
          <div class="head">
            <div>
              <div class="title">${c.title}<span class="live" id="live"><span class="d"></span>LIVE</span></div>
              <div class="readings">
                <span class="rlabel">Usage</span><span class="num" id="r1" style="color:${COL}">–</span><span class="unit">kWh</span>
                <span class="rlabel b">Batteries</span><span class="num2" id="r2" style="color:${COL2}">–</span><span class="unit">kWh</span>
              </div>
            </div>
            <div class="now" id="now">
              <div class="nowrow"><span class="lbl"><span class="dot" style="background:${COL}"></span>Consumption</span><b id="nowval" style="color:${COL}">–</b></div>
              <div class="nowrow"><span class="lbl"><span class="dot" style="background:${COL2}"></span>Batteries</span><b id="nowval2" style="color:${COL2}">–</b></div>
            </div>
          </div>
          <div class="wrap"><canvas></canvas><div class="empty">Loading…</div></div>
        </div>`;
      this._el = {
        r1: this.shadowRoot.getElementById("r1"), r2: this.shadowRoot.getElementById("r2"),
        live: this.shadowRoot.getElementById("live"), now: this.shadowRoot.getElementById("now"),
        nowval: this.shadowRoot.getElementById("nowval"), nowval2: this.shadowRoot.getElementById("nowval2"),
      };
      this._canvas = this.shadowRoot.querySelector("canvas"); this._empty = this.shadowRoot.querySelector(".empty"); this._wrap = this.shadowRoot.querySelector(".wrap");
      this._canvas.style.height = c.height + "px"; this._wrap.style.height = c.height + "px";
      this._built = true;
      if (this._ro) this._ro.disconnect();
      this._ro = new ResizeObserver(() => this._animate()); this._ro.observe(this._wrap);
    }

    _updateHeader() {
      if (!this._hass || !this._el) return;
      this._el.live.style.display = this._period === "Now" ? "inline-flex" : "none";
      const isToday = this._isToday();
      let app = null, bat = null;
      if (this._period === "Week") { app = this._week ? this._week.totalApp : null; bat = this._week ? this._week.totalBat : null; }
      else if (this._period === "Month") { app = this._month ? this._month.totalApp : null; bat = this._month ? this._month.totalBat : null; }
      else if (this._period === "Year") { app = this._year ? this._year.totalApp : null; bat = this._year ? this._year.totalBat : null; }
      else if (this._period === "Now" || isToday) {
        const s = this._hass.states[this._cfg.today_entity]; app = s ? num(s.state) : null;
        const b = this._hass.states[this._cfg.batt_today_entity]; bat = b ? num(b.state) : null;
      } else if (this._archive && this._archiveDate === this._selDate) { app = this._archiveTotal(this._cfg.power_entity); bat = this._archiveTotal(this._cfg.batt_entity); }
      // Usage / Consumption (magenta) = TOTAL = house + batteries; Batteries (purple) = the share within it.
      const total = app != null ? app + (bat || 0) : null;
      this._el.r1.textContent = total != null ? total.toFixed(1) : "—";
      this._el.r2.textContent = bat != null ? bat.toFixed(1) : "—";
      const showNow = this._period === "Now" || (this._period === "Day" && isToday);
      this._el.now.style.visibility = showNow ? "visible" : "hidden";
      if (showNow) {
        const s = this._hass.states[this._cfg.power_entity]; let v = s ? num(s.state) : null; if (v != null) v = Math.max(0, v);
        const b = this._hass.states[this._cfg.batt_entity]; let bv = b ? num(b.state) : null; if (bv != null) bv = Math.max(0, bv);
        this._el.nowval.textContent = v != null ? fmtPower(v + (bv || 0)) : "–";   // Consumption = house + batteries
        this._el.nowval2.textContent = bv != null ? fmtPower(bv) : "–";
      }
    }
    _archiveTotal(id) {
      if (!this._archive || !this._archive.series) return id === this._cfg.batt_entity ? 0 : null;
      const arr = this._archive.series[id]; if (!arr) return id === this._cfg.batt_entity ? 0 : null;
      const bm = this._archive.bucket_min || 5; let s = 0;
      for (const v of arr) if (v != null && v > 0) s += v;
      return s * (bm / 60) / 1000;
    }

    // ---- live (Now) ----
    _startLive() { this._stopLive(); this._live = {}; this._seedLive(); this._sampleTimer = setInterval(() => this._sample(), 500); this._sample(); this._animate(); }
    _stopLive() { if (this._sampleTimer) { clearInterval(this._sampleTimer); this._sampleTimer = null; } }
    async _seedLive() {
      try {
        const ids = [this._cfg.power_entity, this._cfg.batt_entity], now = Date.now(), start = now - WINDOW;
        const res = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(now - WINDOW - 8000).toISOString(), end_time: new Date(now).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true });
        for (const id of ids) {
          const raw = (res && res[id] ? res[id] : []).map((p) => ({ t: ptTime(p), v: ptVal(p) })).filter((p) => p.t != null && isFinite(p.v));
          this._live[id] = this._resample(raw, start, now, 500);
        }
        this._animate();
      } catch (e) { /* sampling fills it */ }
    }
    _resample(raw, s, e, step) { const out = []; let i = 0, last = null; while (i < raw.length && raw[i].t <= s) { last = raw[i].v; i++; } for (let t = s; t <= e; t += step) { while (i < raw.length && raw[i].t <= t) { last = raw[i].v; i++; } if (last != null) out.push({ t, v: Math.max(0, last) }); } return out; }
    _sample() {
      if (!this._hass) return; const now = Date.now(), cutoff = now - WINDOW - 2000;
      for (const id of [this._cfg.power_entity, this._cfg.batt_entity]) {
        const st = this._hass.states[id]; const v = st ? num(st.state) : null;
        if (!this._live[id]) this._live[id] = [];
        if (v != null) this._live[id].push({ t: now, v: Math.max(0, v) });
        const a = this._live[id]; let i = 0; while (i < a.length && a[i].t < cutoff) i++; if (i) a.splice(0, i);
      }
      this._updateHeader();
    }

    // ---- day ----
    _dayStart() { const s = this._selDate, p = s ? String(s).split("-") : null; const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0) : new Date(new Date().setHours(0, 0, 0, 0)); return d.getTime(); }
    _isToday() { const t = new Date(); t.setHours(0, 0, 0, 0); return this._dayStart() === t.getTime(); }
    _loadDay() {
      if (this._isToday()) { this._archive = null; this._archiveDate = null; this._maybeFetch(); return; }
      const cached = this._archiveCache[this._selDate];
      if (cached !== undefined) { this._archive = cached === "nodata" ? null : cached; this._archiveDate = this._selDate; this._updateHeader(); this._animate(); return; }
      if (this._loadingArchive === this._selDate) return;
      this._loadingArchive = this._selDate; this._loadArchive(this._selDate);
    }
    async _loadArchive(dateStr) {
      const want = dateStr; if (!dateStr) { this._maybeFetch(); return; }
      try { const r = await fetch(`${this._cfg.archive_base}/${dateStr}.json`, { cache: "no-cache" }); this._archiveCache[dateStr] = r.ok ? await r.json() : "nodata"; }
      catch (e) { /* retry later */ }
      finally { if (this._loadingArchive === want) this._loadingArchive = null; }
      if (this._selDate !== want) return;
      const c = this._archiveCache[want];
      this._archive = (c && c !== "nodata") ? c : null; this._archiveDate = want;
      this._dispMax = null; this._updateHeader(); this._animate();
    }
    async _maybeFetch() {
      if (!this._hass || this._fetching || this._period === "Now") return;
      const now = Date.now(); if (this._data && now - this._lastFetch < 30000) { this._animate(); return; }
      this._fetching = true;
      try {
        const ids = [this._cfg.power_entity, this._cfg.batt_entity], dayStart = this._dayStart(), dayEnd = Math.min(Date.now(), dayStart + this._cfg.hours * 3600000);
        const res = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(dayStart).toISOString(), end_time: new Date(dayEnd).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true });
        this._data = {};
        for (const id of ids) this._data[id] = (res && res[id] ? res[id] : []).map((p) => ({ t: ptTime(p), v: ptVal(p) })).filter((p) => p.t != null && isFinite(p.v));
        this._lastFetch = Date.now(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "History unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetching = false; }
    }
    _bucketize(points, s, e, b, clamp) {
      const n = Math.max(1, Math.ceil((e - s) / b)); const su = new Array(n).fill(0), cn = new Array(n).fill(0); let last = null;
      for (const p of points) { const val = clamp ? Math.max(0, p.v) : p.v; if (p.t < s) { last = val; continue; } const i = Math.floor((p.t - s) / b); if (i < 0 || i >= n) continue; su[i] += val; cn[i]++; }
      const out = new Array(n); for (let i = 0; i < n; i++) { const t = s + i * b + b / 2; if (cn[i] > 0) { last = su[i] / cn[i]; out[i] = { t, v: last }; } else out[i] = { t, v: last != null ? last : null }; } return out;
    }
    // returns { total:[{t,v}], batt:[{t,v}] }  (total = appliance + battery; batt within)
    _buildSeries() {
      const pid = this._cfg.power_entity, bid = this._cfg.batt_entity;
      if (this._period === "Now") {
        const A = this._live[pid] || [], B = this._live[bid] || [];
        const n = Math.min(A.length, B.length), total = [], batt = [];
        for (let i = 0; i < n; i++) { const b = Math.max(0, B[i].v); total.push({ t: A[i].t, v: A[i].v + b }); batt.push({ t: A[i].t, v: b }); }
        const sa = this._hass && this._hass.states[pid], sbt = this._hass && this._hass.states[bid];
        let av = sa ? num(sa.state) : null; if (av != null) av = Math.max(0, av); else if (n) av = A[n - 1].v;
        let bv = sbt ? num(sbt.state) : null; if (bv != null) bv = Math.max(0, bv); else if (n) bv = Math.max(0, B[n - 1].v);
        if (av != null) { const bb = bv != null ? bv : 0; total.push({ t: Date.now(), v: av + bb }); batt.push({ t: Date.now(), v: bb }); }   // anchor live value to the right edge -> leads smoothly, no jerk (matches Home mains)
        return { total, batt };
      }
      if (this._archive && this._archiveDate === this._selDate && this._archive.series) {
        const aStart = this._dayStart(), abms = (this._archive.bucket_min || 5) * 60000;
        const aArr = this._archive.series[pid] || [], bArr = this._archive.series[bid] || [];
        const f = Math.max(1, Math.round((this._cfg.bucket * 60000) / abms));   // group archive buckets up to the display interval (e.g. 2x5min -> 10min)
        const total = [], batt = [];
        for (let i = 0; i < aArr.length; i += f) {
          let as = 0, ac = 0, bs = 0, bc = 0;
          for (let k = i; k < i + f && k < aArr.length; k++) { if (aArr[k] != null) { as += aArr[k]; ac++; } if (bArr[k] != null) { bs += Math.max(0, bArr[k]); bc++; } }
          const t = aStart + (i + f / 2) * abms, a = ac > 0 ? as / ac : null, b = bc > 0 ? bs / bc : 0;
          total.push({ t, v: a == null ? null : a + b }); batt.push({ t, v: a == null ? null : b });
        }
        return { total, batt };
      }
      const axisStart = this._dayStart(), axisEnd = axisStart + this._cfg.hours * 3600000, dataEnd = Math.min(Date.now(), axisEnd), bms = this._cfg.bucket * 60000;
      const aB = this._bucketize(this._data && this._data[pid] ? this._data[pid] : [], axisStart, dataEnd, bms, false);
      const bB = this._bucketize(this._data && this._data[bid] ? this._data[bid] : [], axisStart, dataEnd, bms, true);
      const total = [], batt = [];
      for (let i = 0; i < aB.length; i++) {
        const t = aB[i].t, a = aB[i].v, b = bB[i] ? bB[i].v : null;
        total.push({ t, v: a == null ? null : a + (b || 0) }); batt.push({ t, v: a == null ? null : (b || 0) });
      }
      return { total, batt };
    }

    // ---- week / month / year (energy bars: appliance + battery charge) ----
    async _fetchSplit(start, end, period) {
      const ids = COMP.map((c) => c.id); if (ids.indexOf(BATT_STAT) < 0) ids.push(BATT_STAT);
      const res = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), statistic_ids: ids, period });
      const app = {}, bat = {};
      COMP.forEach((c) => { (res && res[c.id] ? res[c.id] : []).forEach((e) => { if (e.change != null) { const k = +new Date(e.start); app[k] = (app[k] || 0) + c.s * e.change; } }); });
      (res && res[BATT_STAT] ? res[BATT_STAT] : []).forEach((e) => { if (e.change != null) { const k = +new Date(e.start); bat[k] = (bat[k] || 0) + Math.max(0, e.change); } });
      return { app, bat };
    }
    _weekMonday() { const s = this._selDate, p = s ? String(s).split("-") : null; const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
    async _loadWeek() {
      if (!this._hass || this._fetchingBars) return; const mon = this._weekMonday();
      if (this._week && this._week.monday === mon && Date.now() - (this._barsFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingBars = true;
      try {
        const end = Math.min(Date.now(), mon + 7 * 86400000); const sp = await this._fetchSplit(mon, end, "day");
        const days = []; for (let i = 0; i < 7; i++) { const k = mon + i * 86400000; days.push({ app: sp.app[k] != null ? sp.app[k] : null, bat: sp.bat[k] != null ? sp.bat[k] : null }); }
        let ta = 0, tb = 0; days.forEach((d) => { if (d.app > 0) ta += d.app; if (d.bat > 0) tb += d.bat; });
        this._week = { monday: mon, days, totalApp: ta, totalBat: tb }; this._barsFetch = Date.now(); this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingBars = false; }
    }
    _monthRange() { const s = this._selDate, p = s ? String(s).split("-") : null; const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date(); return { first: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), next: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(), key: d.getFullYear() + "-" + d.getMonth() }; }
    async _loadMonth() {
      if (!this._hass || this._fetchingBars) return; const mr = this._monthRange();
      if (this._month && this._month.key === mr.key && Date.now() - (this._barsFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingBars = true;
      try {
        const weeks = [], map = {}; for (let wk = mondayMs(mr.first); wk < mr.next; wk += 7 * 86400000) { map[wk] = weeks.length; weeks.push({ weekNum: isoWeek(wk), app: null, bat: null }); }
        const end = Math.min(Date.now(), mr.next); const sp = await this._fetchSplit(mr.first, end, "day");
        Object.keys(sp.app).forEach((k) => { const i = map[mondayMs(+k)]; if (i != null) weeks[i].app = (weeks[i].app || 0) + sp.app[k]; });
        Object.keys(sp.bat).forEach((k) => { const i = map[mondayMs(+k)]; if (i != null) weeks[i].bat = (weeks[i].bat || 0) + sp.bat[k]; });
        let ta = 0, tb = 0; weeks.forEach((w) => { if (w.app > 0) ta += w.app; if (w.bat > 0) tb += w.bat; });
        this._month = { key: mr.key, weeks, totalApp: ta, totalBat: tb }; this._barsFetch = Date.now(); this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingBars = false; }
    }
    _yearRange() { const s = this._selDate, p = s ? String(s).split("-") : null; const y = (p && p.length >= 1 && +p[0]) ? +p[0] : new Date().getFullYear(); return { first: new Date(y, 0, 1).getTime(), next: new Date(y + 1, 0, 1).getTime(), year: y }; }
    async _loadYear() {
      if (!this._hass || this._fetchingBars) return; const yr = this._yearRange();
      if (this._year && this._year.year === yr.year && Date.now() - (this._barsFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingBars = true;
      try {
        const end = Math.min(Date.now(), yr.next); const sp = await this._fetchSplit(yr.first, end, "month");
        const months = []; for (let m = 0; m < 12; m++) months.push({ app: null, bat: null });
        Object.keys(sp.app).forEach((k) => { const d = new Date(+k); if (d.getFullYear() === yr.year) months[d.getMonth()].app = sp.app[k]; });
        Object.keys(sp.bat).forEach((k) => { const d = new Date(+k); if (d.getFullYear() === yr.year) months[d.getMonth()].bat = sp.bat[k]; });
        let ta = 0, tb = 0; months.forEach((m) => { if (m.app > 0) ta += m.app; if (m.bat > 0) tb += m.bat; });
        this._year = { year: yr.year, months, totalApp: ta, totalBat: tb }; this._barsFetch = Date.now(); this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingBars = false; }
    }

    // ---- animation + render ----
    _animate() { if (!this._raf) this._raf = requestAnimationFrame(() => this._frame()); }
    _frame() {
      this._raf = null; if (!this._built || !this._wrap.clientWidth) return;
      if (this._period === "Week") { this._renderBars((this._week && this._week.days || new Array(7).fill({})).map((d, i) => ({ label: ["mo", "tu", "we", "th", "fr", "sa", "su"][i], app: d.app, bat: d.bat }))); return; }
      if (this._period === "Month") { this._renderBars((this._month && this._month.weeks || []).map((w) => ({ label: String(w.weekNum), app: w.app, bat: w.bat }))); return; }
      if (this._period === "Year") { this._renderBars((this._year && this._year.months || new Array(12).fill({})).map((m, i) => ({ label: "JFMAMJJASOND"[i], app: m.app, bat: m.bat }))); return; }
      const { total, batt } = this._buildSeries();
      let maxV = 0; for (const p of total) if (p.v != null && p.v > maxV) maxV = p.v;
      let tMax = maxV > 0 ? maxV * 1.1 : 0; if (tMax < 100) tMax = 100;
      if (this._dispMax == null) this._dispMax = tMax; else this._dispMax += (tMax - this._dispMax) * EASE;
      this._render(total, batt);
      if (this._period === "Now" || Math.abs(tMax - this._dispMax) > 0.5) this._raf = requestAnimationFrame(() => this._frame());
    }
    _render(total, batt) {
      const c = this._cfg, W = this._wrap.clientWidth, H = c.height; if (!W || this._dispMax == null) return;
      const dpr = window.devicePixelRatio || 1, cv = this._canvas;
      const cw = Math.round(W * dpr), ch = Math.round(H * dpr); if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const isNow = this._period === "Now";
      const padL = 46, padR = 14, padT = 12, padB = isNow ? 10 : 22;
      const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
      let axisStart, axisEnd; if (isNow) { axisEnd = Date.now(); axisStart = axisEnd - WINDOW; } else { axisStart = this._dayStart(); axisEnd = axisStart + c.hours * 3600000; }
      const dMax = this._dispMax || 1;
      const X = (t) => x0 + ((t - axisStart) / (axisEnd - axisStart)) * (x1 - x0);
      const Y = (v) => y1 - (v / dMax) * (y1 - y0);
      ctx.font = "11px Inter, system-ui, sans-serif";
      const step = niceStep(dMax / 4) || 1;
      ctx.textBaseline = "middle"; ctx.textAlign = "right";
      for (let v = 0; v <= dMax + 1e-6; v += step) { const yy = Y(v); if (yy < y0 - 1) break; ctx.strokeStyle = v === 0 ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.06)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke(); ctx.fillStyle = "#cbc4d2"; ctx.fillText(fmtNum(v), x0 - 6, yy); }
      if (!isNow) { ctx.textBaseline = "alphabetic"; ctx.textAlign = "center"; ctx.fillStyle = "#cbc4d2"; for (const h of [2, 7, 12, 17, 22]) { const xx = X(axisStart + h * 3600000); if (xx < x0 || xx > x1) continue; ctx.fillText(String(h).padStart(2, "0") + ":00", xx, H - 6); } }
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      this._drawArea(ctx, total, X, Y, y1, y0, COL, 0.34, 0.02, 2, 1);          // magenta = total
      this._drawArea(ctx, batt, X, Y, y1, y0, COL2, 0.8, 0.8, 1.5, 1);           // purple = battery: solid opaque line + ~80% opaque fill
      ctx.restore();
      let any = false; for (const p of total) if (p.v != null) { any = true; break; }
      this._empty.style.display = any ? "none" : "flex"; if (!any) this._empty.textContent = isNow ? "Waiting for live data…" : "No data";
    }
    _trace(ctx, seg, X, Y) {   // smooth curve through the points (quadratic, midpoint method) - no overshoot
      const n = seg.length;
      if (n < 3) { for (let i = 1; i < n; i++) ctx.lineTo(X(seg[i].t), Y(seg[i].v)); return; }
      for (let i = 1; i < n - 2; i++) { const xc = (X(seg[i].t) + X(seg[i + 1].t)) / 2, yc = (Y(seg[i].v) + Y(seg[i + 1].v)) / 2; ctx.quadraticCurveTo(X(seg[i].t), Y(seg[i].v), xc, yc); }
      ctx.quadraticCurveTo(X(seg[n - 2].t), Y(seg[n - 2].v), X(seg[n - 1].t), Y(seg[n - 1].v));
    }
    _drawArea(ctx, pts, X, Y, yBase, y0, color, fillTop, fillBot, lineW, lineA) {
      const groups = []; let cur = []; for (const p of pts) { if (p.v == null) { if (cur.length) { groups.push(cur); cur = []; } } else cur.push(p); } if (cur.length) groups.push(cur);
      const g = ctx.createLinearGradient(0, y0, 0, yBase); g.addColorStop(0, hexA(color, fillTop)); g.addColorStop(1, hexA(color, fillBot));
      for (const seg of groups) {
        if (seg.length < 2) continue;
        ctx.beginPath(); ctx.moveTo(X(seg[0].t), yBase); ctx.lineTo(X(seg[0].t), Y(seg[0].v)); this._trace(ctx, seg, X, Y); ctx.lineTo(X(seg[seg.length - 1].t), yBase); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
        ctx.beginPath(); ctx.moveTo(X(seg[0].t), Y(seg[0].v)); this._trace(ctx, seg, X, Y); ctx.lineWidth = lineW; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = hexA(color, lineA); ctx.stroke();
      }
    }
    _roundBar(ctx, x, y, w, h, r) { r = Math.max(0, Math.min(r, w / 2, h)); ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h); ctx.closePath(); }
    _renderBars(slots) {
      const c = this._cfg, W = this._wrap.clientWidth, H = c.height; if (!W) return;
      const dpr = window.devicePixelRatio || 1, cv = this._canvas;
      const cw = Math.round(W * dpr), ch = Math.round(H * dpr); if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      if (!slots.length) slots = [{ label: "", app: null, bat: null }];
      const tot = (s) => (s.app > 0 ? s.app : 0) + (s.bat > 0 ? s.bat : 0);
      let mx = 0; for (const s of slots) { const t = tot(s); if (t > mx) mx = t; }
      const step = niceStep(mx / 5) || 1;
      const top = Math.max(step, Math.ceil(mx / (step / 2)) * (step / 2));
      const padL = 10, padR = 40, padT = 24, padB = 22, x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
      const Y = (v) => y1 - (v / top) * (y1 - y0);
      ctx.font = "11px Inter, system-ui, sans-serif";
      for (let v = 0; v <= top + 1e-6; v += step) { const yy = Y(v); ctx.strokeStyle = v === 0 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.06)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke(); ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(fmtNum(v), W - 6, yy); }
      const n = slots.length, slotW = (x1 - x0) / n, barW = Math.max(6, Math.min(26, slotW * 0.34));
      for (let i = 0; i < n; i++) {
        const cx = x0 + slotW * (i + 0.5), total = tot(slots[i]), bat = slots[i].bat > 0 ? slots[i].bat : 0;
        if (total > 0) {
          const bx = cx - barW / 2, by = Y(total), yBat = bat > 0 ? Y(bat) : y1;
          // appliance (magenta) stacked on top - rounded top corners
          if (yBat - by > 0.5) { const g = ctx.createLinearGradient(0, by, 0, y1); g.addColorStop(0, COL); g.addColorStop(1, hexA(COL, 0.45)); this._roundBar(ctx, bx, by, barW, yBat - by, 4); ctx.fillStyle = g; ctx.fill(); }
          // battery (purple) stacked at the base on bare background -> same true colour + 0.8 opacity as the Day view (not muddied by magenta underneath)
          if (bat > 0) { this._roundBar(ctx, bx, yBat, barW, y1 - yBat, yBat - by <= 0.5 ? 4 : 0); ctx.fillStyle = hexA(COL2, 0.8); ctx.fill(); }
          ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(fmtNum(total), cx, by - 5);
        }
        ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(slots[i].label, cx, H - 6);
      }
      const any = slots.some((s) => tot(s) > 0);
      this._empty.style.display = any ? "none" : "flex"; if (!any) this._empty.textContent = "No data";
    }

    disconnectedCallback() { this._stopLive(); if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } if (this._ro) { this._ro.disconnect(); this._ro = null; } }
  }

  if (!customElements.get(TAG)) {
    customElements.define(TAG, UsageCard);
    window.customCards = window.customCards || [];
    window.customCards.push({ type: TAG, name: "Power Usage Card", description: "Consumption with battery-charging breakdown: magenta total + purple battery within." });
    console.info("%c USAGE-CARD %c v2 ", "background:#e040fb;color:#fff", "background:#222;color:#e040fb");
  }
})();
