/*
 * battery-card  (v1)
 * HomeWizard Plug-In Battery, styled to match home-mains (magenta charge / green discharge)
 * with the HomeWizard app's dual-axis layout: battery POWER as a zero-crossing area on the
 * W axis (right, charge + above 0 / discharge - below 0) and CHARGE % as a white line on the
 * % axis (left, 0-100), overlaid. Week/Month/Year = grouped Charged + Discharged energy bars.
 * Data (reused verbatim from the old apexcharts card - it was correct):
 *   power = sensor.plug_in_battery_power            (+ charging / - discharging)
 *   soc   = sensor.plug_in_battery_state_of_charge  (%)
 *   today = sensor.battery_charged_daily / sensor.battery_discharged_daily
 *   stats = sensor.plug_in_battery_energy_import / _export (cumulative kWh -> period bars)
 */
(function () {
  const TAG = "battery-card";
  const CHG = "#e040fb", DIS = "#00e676", SOC_COL = "#ffffff";   // charge magenta / discharge green / soc white
  const WINDOW = 60000, EASE = 0.14;

  const ptTime = (p) => { let t = p.lu != null ? p.lu : (p.lc != null ? p.lc : (p.last_updated != null ? p.last_updated : p.last_changed)); if (t == null) return null; if (typeof t === "string") return Date.parse(t); return t < 1e12 ? t * 1000 : t; };
  const ptVal = (p) => parseFloat(p.s != null ? p.s : p.state);
  const num = (v) => { const f = parseFloat(v); return isFinite(f) ? f : null; };
  const niceCeil = (v) => { if (v <= 0) return 0; const e = Math.floor(Math.log10(v)), b = Math.pow(10, e), f = v / b; const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; return nf * b; };
  const niceStep = (v) => { if (v <= 0) return 1; const e = Math.floor(Math.log10(v)), b = Math.pow(10, e), f = v / b; const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; return nf * b; };
  const fmtW = (v) => Math.round(v).toLocaleString();
  const fmtPower = (w) => Math.abs(w) >= 1000 ? (w / 1000).toFixed(2) + " kW" : Math.round(w).toLocaleString() + " W";
  const fmtNum = (v) => v >= 10 ? Math.round(v).toString() : (v >= 1 ? (Math.round(v * 10) / 10).toString() : (Math.round(v * 100) / 100).toString());
  const mondayMs = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const isoWeek = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const w1 = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7); };
  function hexA(hex, a) { let h = (hex || "").trim().replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16); if (isNaN(n)) return "rgba(255,255,255," + a + ")"; return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; }

  class BatteryCard extends HTMLElement {
    constructor() {
      super(); this.attachShadow({ mode: "open" });
      this._period = "Day"; this._data = null; this._live = {}; this._dispM = null;
      this._archive = null; this._archiveDate = null; this._archiveCache = {};
      this._lastFetch = 0; this._fetching = false; this._built = false;
      this._raf = null; this._sampleTimer = null; this._ro = null;
    }
    setConfig(config) {
      this._cfg = {
        title: config.title || "HomeWizard Plug-In Battery",
        power_entity: config.power_entity || "sensor.plug_in_battery_power",
        soc_entity: config.soc_entity || "sensor.plug_in_battery_state_of_charge",
        charged_today: config.charged_today || "sensor.battery_charged_daily",
        discharged_today: config.discharged_today || "sensor.battery_discharged_daily",
        charged_stat: config.charged_stat || "sensor.plug_in_battery_energy_import",
        discharged_stat: config.discharged_stat || "sensor.plug_in_battery_energy_export",
        period_entity: config.period_entity || "input_select.energy_period",
        date_entity: config.date_entity || "input_datetime.energy_date",
        archive_base: config.archive_base || "/local/energy-archive",
        hours: Number(config.hours) > 0 ? Number(config.hours) : 24,
        bucket: Number(config.bucket_minutes) > 0 ? Number(config.bucket_minutes) : 10,
        height: Number(config.height) > 0 ? Number(config.height) : 250,
      };
      this._built = false; this._data = null; this._dispM = null;
    }
    getCardSize() { return Math.ceil(this._cfg.height / 50) + 2; }

    set hass(hass) {
      this._hass = hass; if (!this._built) this._build();
      const st = hass.states[this._cfg.period_entity];
      const per = st ? st.state : "Day";
      if (per !== this._period) this._setPeriod(per);
      if (this._period !== "Now") {
        const dst = hass.states[this._cfg.date_entity]; const dstr = dst ? dst.state : null;
        if (dstr !== this._selDate) { this._selDate = dstr; this._dispM = null; }
      }
      this._updateHeader();
      if (this._period === "Week") this._loadWeek();
      else if (this._period === "Month") this._loadMonth();
      else if (this._period === "Year") this._loadYear();
      else if (this._period !== "Now") this._loadDay();
    }

    _setPeriod(per) {
      this._period = per; this._dispM = null;
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
          .title{display:flex;align-items:center;gap:8px;font-size:17px;font-weight:500;color:#cbc4d2;margin:0 0 8px;}
          .title svg{width:22px;height:22px;flex:0 0 auto;}
          .readings{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;}
          .rd{display:flex;align-items:baseline;gap:6px;}
          .rlabel{font-size:13px;color:#fff;}
          .num{font-size:38px;font-weight:700;letter-spacing:-.02em;line-height:1;}
          .snum{font-size:22px;font-weight:700;letter-spacing:-.01em;line-height:1;}
          .unit{font-size:13px;color:#cbc4d2;}
          #socRd{gap:5px;}
          .bicon{width:24px;height:24px;flex:0 0 auto;align-self:center;}
          .legend{position:absolute;top:18px;right:56px;display:flex;flex-direction:column;gap:5px;align-items:flex-start;}
          .lg{display:flex;align-items:center;gap:8px;font-size:13px;color:#cbc4d2;white-space:nowrap;}
          .lg-name{display:flex;align-items:center;gap:6px;}
          .lg-val{width:84px;text-align:right;font-weight:700;}
          .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;}
          .live{display:none;align-items:center;gap:6px;font-size:12px;color:#0a84ff;margin-left:4px;}
          .live .d{width:8px;height:8px;border-radius:50%;background:#0a84ff;animation:bl 1s infinite;}
          @keyframes bl{50%{opacity:.25;}}
          .wrap{position:relative;width:100%;margin-top:12px;} canvas{display:block;width:100%;}
          .empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#cbc4d2;font-size:13px;}
        </style>
        <div class="card">
          <div class="title">
            <span>${c.title}</span><span class="live" id="live"><span class="d"></span>LIVE</span>
          </div>
          <div class="readings">
            <div class="rd"><span class="rlabel">Charged</span><span class="num" id="rChg" style="color:${CHG}">–</span><span class="unit">kWh</span></div>
            <div class="rd"><span class="rlabel">Discharged</span><span class="num" id="rDis" style="color:${DIS}">–</span><span class="unit">kWh</span></div>
            <div class="rd" id="socRd"><svg class="bicon" viewBox="0 0 24 24" fill="none"><rect x="2.5" y="7.5" width="15.5" height="9" rx="2.2" stroke="#cbc4d2" stroke-width="1.5"/><rect x="19.3" y="10.3" width="2" height="3.4" rx="1" fill="#cbc4d2"/><path id="bolt" d="M11.2 8.6l-3 4.1h2.3l-.6 2.7 3.1-4.2h-2.4l.6-2.6z" fill="#e040fb"/></svg><span class="snum" id="rSoc" style="color:${SOC_COL}">–</span><span class="unit">%</span></div>
          </div>
          <div class="legend" id="legend"></div>
          <div class="wrap"><canvas></canvas><div class="empty">Loading…</div></div>
        </div>`;
      this._el = { rChg: this.shadowRoot.getElementById("rChg"), rDis: this.shadowRoot.getElementById("rDis"), rSoc: this.shadowRoot.getElementById("rSoc"), socRd: this.shadowRoot.getElementById("socRd"), legend: this.shadowRoot.getElementById("legend"), bolt: this.shadowRoot.getElementById("bolt"), live: this.shadowRoot.getElementById("live") };
      this._canvas = this.shadowRoot.querySelector("canvas"); this._empty = this.shadowRoot.querySelector(".empty"); this._wrap = this.shadowRoot.querySelector(".wrap");
      this._canvas.style.height = c.height + "px"; this._wrap.style.height = c.height + "px";
      this._built = true;
      if (this._ro) this._ro.disconnect();
      this._ro = new ResizeObserver(() => this._animate()); this._ro.observe(this._wrap);
    }

    _powerDef() { return { entity: this._cfg.power_entity, pos: CHG, neg: DIS }; }
    _liveEntities() { return [this._cfg.power_entity, this._cfg.soc_entity]; }

    _updateHeader() {
      if (!this._hass || !this._el) return;
      this._el.live.style.display = this._period === "Now" ? "inline-flex" : "none";
      const barMode = this._period === "Week" || this._period === "Month" || this._period === "Year";
      const agg = this._period === "Week" ? this._week : (this._period === "Month" ? this._month : (this._period === "Year" ? this._year : null));
      const isToday = this._isToday();
      const pastDay = !barMode && this._period !== "Now" && !isToday;
      const useArch = pastDay && this._archive && this._archiveDate === this._selDate;
      let chg = null, dis = null, noData = false;
      if (barMode) { chg = agg ? agg.chgTotal : null; dis = agg ? agg.disTotal : null; }
      else if (!pastDay) { const a = this._hass.states[this._cfg.charged_today], b = this._hass.states[this._cfg.discharged_today]; chg = a ? num(a.state) : null; dis = b ? num(b.state) : null; }
      else if (useArch && this._archive.series && this._archive.series[this._cfg.power_entity]) {
        const arr = this._archive.series[this._cfg.power_entity], bm = this._archive.bucket_min || 5; let cs = 0, ds = 0;
        for (const x of arr) if (x != null) { if (x > 0) cs += x; else ds += -x; }                 // integrate 5-min W avgs -> kWh
        chg = cs * (bm / 60) / 1000; dis = ds * (bm / 60) / 1000;
      } else noData = true;
      this._el.rChg.textContent = noData ? "—" : (chg != null ? chg.toFixed(1) : "–");
      this._el.rDis.textContent = noData ? "—" : (dis != null ? dis.toFixed(1) : "–");
      const showLive = (this._period === "Now" || this._period === "Day") && !pastDay;   // live charge/discharge applies to Now + today only
      this._el.socRd.style.display = showLive ? "flex" : "none";
      const pw = this._hass.states[this._cfg.power_entity]; const pv = pw ? num(pw.state) : null;   // + charging / - discharging
      if (showLive) {
        const s = this._hass.states[this._cfg.soc_entity]; const v = s ? num(s.state) : null; this._el.rSoc.textContent = v != null ? Math.round(v) : "–";
        if (this._el.bolt && pv != null) this._el.bolt.setAttribute("fill", pv >= 0 ? CHG : DIS);   // bolt: magenta charging / green discharging
        const sp = `<span class="lg" style="visibility:hidden"><span class="lg-name"><span class="dot"></span>Discharge</span><b class="lg-val">0 W</b></span>`;   // 2 invisible rows drop the row onto the readings line (home-mains trick)
        if (pv == null) this._el.legend.innerHTML = "";
        else if (pv >= 0) this._el.legend.innerHTML = sp + sp + `<span class="lg"><span class="lg-name"><span class="dot" style="background:${CHG}"></span>Charge</span><b class="lg-val" style="color:${CHG}">${fmtPower(pv)}</b></span>`;
        else this._el.legend.innerHTML = sp + sp + `<span class="lg"><span class="lg-name"><span class="dot" style="background:${DIS}"></span>Discharge</span><b class="lg-val" style="color:${DIS}">${fmtPower(-pv)}</b></span>`;
      } else this._el.legend.innerHTML = "";
    }

    // ---- live (Now) ----
    _startLive() { this._stopLive(); this._live = {}; this._seedLive(); this._sampleTimer = setInterval(() => this._sample(), 500); this._sample(); this._animate(); }
    _stopLive() { if (this._sampleTimer) { clearInterval(this._sampleTimer); this._sampleTimer = null; } }
    async _seedLive() {
      try {
        const ids = this._liveEntities(); const now = Date.now(), start = now - WINDOW;
        const res = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(now - WINDOW - 8000).toISOString(), end_time: new Date(now).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true });
        ids.forEach((id) => { const raw = (res && res[id] ? res[id] : []).map((p) => ({ t: ptTime(p), v: ptVal(p) })).filter((p) => p.t != null && isFinite(p.v)); this._live[id] = this._resample(raw, start, now, 500); });
        this._animate();
      } catch (e) { /* sampling fills it */ }
    }
    _resample(raw, s, e, step) { const out = []; let i = 0, last = null; while (i < raw.length && raw[i].t <= s) { last = raw[i].v; i++; } for (let t = s; t <= e; t += step) { while (i < raw.length && raw[i].t <= t) { last = raw[i].v; i++; } if (last != null) out.push({ t, v: last }); } return out; }
    _sample() {
      if (!this._hass) return; const now = Date.now(), cutoff = now - WINDOW - 2000;
      this._liveEntities().forEach((id) => { const st = this._hass.states[id]; const v = st ? num(st.state) : null; if (!this._live[id]) this._live[id] = []; if (v != null) this._live[id].push({ t: now, v }); const a = this._live[id]; let i = 0; while (i < a.length && a[i].t < cutoff) i++; if (i) a.splice(0, i); });
      this._updateHeader();
    }

    _dayStart() { const s = this._selDate; const p = s ? String(s).split("-") : null; const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0) : new Date(new Date().setHours(0, 0, 0, 0)); return d.getTime(); }
    _isToday() { const today = new Date(); today.setHours(0, 0, 0, 0); return this._dayStart() === today.getTime(); }
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
      catch (e) { } finally { if (this._loadingArchive === want) this._loadingArchive = null; }
      if (this._selDate !== want) return;
      const cc = this._archiveCache[want]; this._archive = (cc && cc !== "nodata") ? cc : null; this._archiveDate = want;
      this._dispM = null; this._updateHeader(); this._animate();
    }
    async _fetchInto(ids) {
      if (!ids || !ids.length) return;
      const dayStart = this._dayStart(), dayEnd = Math.min(Date.now(), dayStart + this._cfg.hours * 3600000);
      const res = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(dayStart).toISOString(), end_time: new Date(dayEnd).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true });
      if (!this._data) this._data = {};
      ids.forEach((id) => { this._data[id] = (res && res[id] ? res[id] : []).map((p) => ({ t: ptTime(p), v: ptVal(p) })).filter((p) => p.t != null && isFinite(p.v)); });
    }
    async _maybeFetch() {
      if (!this._hass || this._fetching || this._period === "Now") return;
      const now = Date.now(); if (this._data && now - this._lastFetch < 30000) { this._animate(); return; }
      this._fetching = true;
      try {
        await this._fetchInto([this._cfg.power_entity]); this._lastFetch = Date.now(); this._animate();   // power first -> fast paint
        await this._fetchInto([this._cfg.soc_entity]); this._animate();                                    // soc line
      } catch (e) { if (this._empty) { this._empty.textContent = "History unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetching = false; }
    }

    // ---- week / month / year (grouped charged + discharged bars) ----
    _weekMonday() { const s = this._selDate; const p = s ? String(s).split("-") : null; const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
    async _loadWeek() {
      if (!this._hass || this._fetchingWeek) return; const mon = this._weekMonday();
      if (this._week && this._week.monday === mon && Date.now() - (this._weekFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingWeek = true;
      try {
        const end = Math.min(Date.now(), mon + 7 * 86400000);
        const res = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(mon).toISOString(), end_time: new Date(end).toISOString(), statistic_ids: [this._cfg.charged_stat, this._cfg.discharged_stat], period: "day" });
        const days = []; for (let i = 0; i < 7; i++) days.push({ charged: null, discharged: null });
        const put = (rows, key) => { (rows || []).forEach((e) => { const dd = new Date(e.start); dd.setHours(0, 0, 0, 0); const i = Math.round((dd.getTime() - mon) / 86400000); if (i >= 0 && i < 7 && e.change != null) days[i][key] = e.change; }); };
        put(res && res[this._cfg.charged_stat], "charged"); put(res && res[this._cfg.discharged_stat], "discharged");
        let ct = 0, dt = 0; days.forEach((d) => { if (d.charged > 0) ct += d.charged; if (d.discharged > 0) dt += d.discharged; });
        this._week = { monday: mon, days, chgTotal: ct, disTotal: dt }; this._weekFetch = Date.now();
        this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingWeek = false; }
    }
    _renderWeek() { const names = ["mo", "tu", "we", "th", "fr", "sa", "su"]; const days = (this._week && this._week.days) || names.map(() => ({ charged: null, discharged: null })); this._renderBars(days.map((d, i) => ({ label: names[i], charged: d.charged, discharged: d.discharged }))); }
    _monthRange() { const s = this._selDate; const p = s ? String(s).split("-") : null; const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date(); return { first: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), next: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(), key: d.getFullYear() + "-" + d.getMonth() }; }
    async _loadMonth() {
      if (!this._hass || this._fetchingMonth) return; const mr = this._monthRange();
      if (this._month && this._month.key === mr.key && Date.now() - (this._monthFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingMonth = true;
      try {
        const weeks = [], map = {};
        for (let wk = mondayMs(mr.first); wk < mr.next; wk += 7 * 86400000) { map[wk] = weeks.length; weeks.push({ weekNum: isoWeek(wk), charged: null, discharged: null }); }
        const end = Math.min(Date.now(), mr.next);
        const res = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(mr.first).toISOString(), end_time: new Date(end).toISOString(), statistic_ids: [this._cfg.charged_stat, this._cfg.discharged_stat], period: "day" });
        const add = (rows, key) => { (rows || []).forEach((e) => { const i = map[mondayMs(e.start)]; if (i != null && e.change != null) weeks[i][key] = (weeks[i][key] || 0) + e.change; }); };
        add(res && res[this._cfg.charged_stat], "charged"); add(res && res[this._cfg.discharged_stat], "discharged");
        let ct = 0, dt = 0; weeks.forEach((w) => { if (w.charged > 0) ct += w.charged; if (w.discharged > 0) dt += w.discharged; });
        this._month = { key: mr.key, weeks, chgTotal: ct, disTotal: dt }; this._monthFetch = Date.now();
        this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingMonth = false; }
    }
    _renderMonth() { const weeks = (this._month && this._month.weeks) || []; this._renderBars(weeks.map((w) => ({ label: String(w.weekNum), charged: w.charged, discharged: w.discharged }))); }
    _yearRange() { const s = this._selDate; const p = s ? String(s).split("-") : null; const y = (p && p.length >= 1 && +p[0]) ? +p[0] : new Date().getFullYear(); return { first: new Date(y, 0, 1).getTime(), next: new Date(y + 1, 0, 1).getTime(), year: y }; }
    async _loadYear() {
      if (!this._hass || this._fetchingYear) return; const yr = this._yearRange();
      if (this._year && this._year.year === yr.year && Date.now() - (this._yearFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingYear = true;
      try {
        const months = []; for (let m = 0; m < 12; m++) months.push({ charged: null, discharged: null });
        const end = Math.min(Date.now(), yr.next);
        const res = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(yr.first).toISOString(), end_time: new Date(end).toISOString(), statistic_ids: [this._cfg.charged_stat, this._cfg.discharged_stat], period: "month" });
        const add = (rows, key) => { (rows || []).forEach((e) => { const d = new Date(e.start); if (d.getFullYear() === yr.year && e.change != null) months[d.getMonth()][key] = e.change; }); };
        add(res && res[this._cfg.charged_stat], "charged"); add(res && res[this._cfg.discharged_stat], "discharged");
        let ct = 0, dt = 0; months.forEach((m) => { if (m.charged > 0) ct += m.charged; if (m.discharged > 0) dt += m.discharged; });
        this._year = { year: yr.year, months, chgTotal: ct, disTotal: dt }; this._yearFetch = Date.now();
        this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingYear = false; }
    }
    _renderYear() { const M = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"]; const months = (this._year && this._year.months) || M.map(() => ({ charged: null, discharged: null })); this._renderBars(months.map((m, i) => ({ label: M[i], charged: m.charged, discharged: m.discharged }))); }

    _roundBar(ctx, x, y, w, h, r) { r = Math.max(0, Math.min(r, w / 2, h)); ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h); ctx.closePath(); }
    _renderBars(slots) {
      const c = this._cfg, W = this._wrap.clientWidth, H = c.height; if (!W) return;
      const dpr = window.devicePixelRatio || 1, cv = this._canvas; const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      if (!slots.length) slots = [{ label: "", charged: null, discharged: null }];
      let mx = 0; for (const s of slots) { if (s.charged > mx) mx = s.charged; if (s.discharged > mx) mx = s.discharged; }
      const step = niceStep(mx / 5) || 1, top = Math.max(step, Math.ceil(mx / (step / 2)) * (step / 2));
      const padL = 10, padR = 40, padT = 24, padB = 22;
      const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB; const Y = (v) => y1 - (v / top) * (y1 - y0);
      ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
      for (let v = 0; v <= top + 1e-6; v += step) {
        const yy = Y(v);
        ctx.strokeStyle = v === 0 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.06)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
        ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "right"; ctx.fillText(fmtNum(v), W - 6, yy);            // kWh axis (right, like the other cards)
      }
      const n = slots.length, slotW = (x1 - x0) / n, barW = Math.max(5, Math.min(18, slotW * 0.28)), innerGap = Math.max(2, barW * 0.22), pairW = barW * 2 + innerGap;
      for (let i = 0; i < n; i++) {
        const cx = x0 + slotW * (i + 0.5), gx = cx - pairW / 2, sx = gx + barW + innerGap;
        const bars = [{ x: gx, v: slots[i].charged, col: CHG }, { x: sx, v: slots[i].discharged, col: DIS }];
        for (const b of bars) {
          if (b.v == null || b.v <= 0) continue;
          const by = Y(b.v), bh = y1 - by;
          const g = ctx.createLinearGradient(0, by, 0, y1); g.addColorStop(0, b.col); g.addColorStop(1, hexA(b.col, 0.5));
          this._roundBar(ctx, b.x, by, barW, bh, 4); ctx.fillStyle = g; ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = hexA(b.col, 0.85); this._roundBar(ctx, b.x + 0.5, by + 0.5, barW - 1, bh - 0.5, 3.5); ctx.stroke();   // subtle outline (HomeWizard look)
          if (n <= 16) { ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(fmtNum(b.v), b.x + barW / 2, by - 5); }
          ctx.textBaseline = "middle";
        }
        if (slots[i].label) { ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(slots[i].label, cx, H - 6); ctx.textBaseline = "middle"; }
      }
      const any = slots.some((s) => (s.charged > 0) || (s.discharged > 0));
      this._empty.style.display = any ? "none" : "flex"; if (!any) this._empty.textContent = "No data";
    }

    _bucketize(points, s, e, b) {
      const n = Math.max(1, Math.ceil((e - s) / b)); const su = new Array(n).fill(0), cn = new Array(n).fill(0); let last = null;
      for (const p of points) { if (p.t < s) { last = p.v; continue; } const i = Math.floor((p.t - s) / b); if (i < 0 || i >= n) continue; su[i] += p.v; cn[i]++; }
      const out = new Array(n); for (let i = 0; i < n; i++) { const t = s + i * b + b / 2; if (cn[i] > 0) { last = su[i] / cn[i]; out[i] = { t, v: last }; } else out[i] = { t, v: last != null ? last : null }; } return out;
    }
    _reBucketArchive(id) {
      const aStart = this._dayStart(), abms = (this._archive.bucket_min || 5) * 60000, f = Math.max(1, Math.round((this._cfg.bucket * 60000) / abms));
      const arr = (this._archive.series && this._archive.series[id]) || []; const pts = [];
      for (let i = 0; i < arr.length; i += f) { let su = 0, cn = 0; for (let k = i; k < i + f && k < arr.length; k++) if (arr[k] != null) { su += arr[k]; cn++; } pts.push({ t: aStart + (i + f / 2) * abms, v: cn > 0 ? su / cn : null }); }
      return pts;
    }
    _buildSeries() {
      const d = this._powerDef();
      if (this._period === "Now") { const buf = (this._live[d.entity] || []).slice(); const st = this._hass && this._hass.states[d.entity]; const lv = st ? num(st.state) : (buf.length ? buf[buf.length - 1].v : null); if (lv != null) buf.push({ t: Date.now(), v: lv }); return [{ def: d, pts: buf }]; }
      if (this._archive && this._archiveDate === this._selDate && this._archive.series) return [{ def: d, pts: this._reBucketArchive(d.entity) }];
      const axisStart = this._dayStart(), axisEnd = axisStart + this._cfg.hours * 3600000, dataEnd = Math.min(Date.now(), axisEnd), bms = this._cfg.bucket * 60000;
      return [{ def: d, pts: this._bucketize(this._data && this._data[d.entity] ? this._data[d.entity] : [], axisStart, dataEnd, bms) }];
    }
    _buildSoc() {
      const id = this._cfg.soc_entity;
      if (this._period === "Now") { const buf = (this._live[id] || []).slice(); const st = this._hass && this._hass.states[id]; const lv = st ? num(st.state) : (buf.length ? buf[buf.length - 1].v : null); if (lv != null) buf.push({ t: Date.now(), v: lv }); return buf; }
      if (this._archive && this._archiveDate === this._selDate && this._archive.series) return this._reBucketArchive(id);
      const axisStart = this._dayStart(), axisEnd = axisStart + this._cfg.hours * 3600000, dataEnd = Math.min(Date.now(), axisEnd), bms = this._cfg.bucket * 60000;
      return this._bucketize(this._data && this._data[id] ? this._data[id] : [], axisStart, dataEnd, bms);
    }

    _animate() { if (!this._raf) this._raf = requestAnimationFrame(() => this._frame()); }
    _frame() {
      this._raf = null; if (!this._built || !this._wrap.clientWidth) return;
      if (this._period === "Week") { this._renderWeek(); return; }
      if (this._period === "Month") { this._renderMonth(); return; }
      if (this._period === "Year") { this._renderYear(); return; }
      const series = this._buildSeries();
      let maxAbs = 0; for (const s of series) for (const p of s.pts) if (p.v != null) { const a = Math.abs(p.v); if (a > maxAbs) maxAbs = a; }
      let tM = maxAbs > 0 ? niceCeil(maxAbs * 1.1) : 0; if (tM < 100) tM = 100;     // symmetric W axis (0 in the middle), min 100 W
      if (this._dispM == null) this._dispM = tM; else this._dispM += (tM - this._dispM) * EASE;
      this._render(series);
      const easing = Math.abs(tM - this._dispM) > 0.5;
      if (this._period === "Now" || easing) this._raf = requestAnimationFrame(() => this._frame());
    }

    _render(series) {
      const c = this._cfg, W = this._wrap.clientWidth, H = c.height; if (!W || this._dispM == null) return;
      const dpr = window.devicePixelRatio || 1, cv = this._canvas; const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const isNow = this._period === "Now";
      const padL = 46, padR = 40, padT = 12, padB = isNow ? 12 : 22;
      const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
      let axisStart, axisEnd;
      if (isNow) { axisEnd = Date.now(); axisStart = axisEnd - WINDOW; } else { axisStart = this._dayStart(); axisEnd = axisStart + c.hours * 3600000; }
      const M = this._dispM;
      const X = (t) => x0 + ((t - axisStart) / (axisEnd - axisStart)) * (x1 - x0);
      const Y = (v) => y1 - ((v + M) / (2 * M)) * (y1 - y0);                          // symmetric: -M..+M -> y1..y0, 0 in the middle
      const Ysoc = (s) => y1 - (Math.max(0, Math.min(100, s)) / 100) * (y1 - y0);     // % 0..100 -> y1..y0 (full height)
      const yBase = Y(0);
      ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
      const levels = [M, M / 2, 0, -M / 2, -M], pcts = [100, 75, 50, 25, 0];
      for (let i = 0; i < levels.length; i++) {
        const w = levels[i], yy = Y(w);
        ctx.strokeStyle = w === 0 ? "rgba(255,255,255,0.30)" : "rgba(255,255,255,0.06)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
        ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "right"; ctx.fillText(fmtW(w), x0 - 6, yy);                      // W axis (left, like the other cards)
        if (!isNow && (i === 0 || i === 2 || i === 4)) { ctx.textAlign = "left"; ctx.fillText(pcts[i] + "%", x1 + 5, yy); }   // % axis (right, Day only): 100 / 50 / 0
      }
      if (!isNow) { ctx.textBaseline = "alphabetic"; ctx.textAlign = "center"; ctx.fillStyle = "#8a8a8e"; for (const h of [2, 7, 12, 17, 22]) { const t = axisStart + h * 3600000, xx = X(t); if (xx < x0 || xx > x1) continue; ctx.fillText(String(h).padStart(2, "0") + ":00", xx, H - 6); } }
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      for (const s of series) this._drawSeries(ctx, s.pts, X, Y, yBase, y0, y1, s.def.pos, s.def.neg);
      if (!isNow) {   // charge % line: Day view only (Now = power focus, no % line)
        const soc = this._buildSoc(); const segs = []; let cur = [];
        for (const p of soc) { if (p.v == null) { if (cur.length) { segs.push(cur); cur = []; } } else cur.push(p); } if (cur.length) segs.push(cur);
        ctx.lineWidth = 2; ctx.strokeStyle = SOC_COL; ctx.lineJoin = "round"; ctx.lineCap = "round";
        for (const seg of segs) { if (seg.length < 1) continue; ctx.beginPath(); ctx.moveTo(X(seg[0].t), Ysoc(seg[0].v)); this._trace(ctx, seg, X, Ysoc); ctx.stroke(); }
      }
      ctx.restore();
      let any = false; for (const s of series) for (const p of s.pts) if (p.v != null) { any = true; break; }
      this._empty.style.display = any ? "none" : "flex"; if (!any) this._empty.textContent = isNow ? "Waiting for live data…" : "No data";
    }

    _trace(ctx, seg, X, Y) {
      const n = seg.length; if (n < 3) { for (let i = 1; i < n; i++) ctx.lineTo(X(seg[i].t), Y(seg[i].v)); return; }
      for (let i = 1; i < n - 2; i++) { const xc = (X(seg[i].t) + X(seg[i + 1].t)) / 2, yc = (Y(seg[i].v) + Y(seg[i + 1].v)) / 2; ctx.quadraticCurveTo(X(seg[i].t), Y(seg[i].v), xc, yc); }
      ctx.quadraticCurveTo(X(seg[n - 2].t), Y(seg[n - 2].v), X(seg[n - 1].t), Y(seg[n - 1].v));
    }
    _drawSeries(ctx, pts, X, Y, yBase, y0, y1, posColor, negColor) {
      const groups = []; let cur = []; for (const p of pts) { if (p.v == null) { if (cur.length) { groups.push(cur); cur = []; } } else cur.push(p); } if (cur.length) groups.push(cur);
      const gPos = ctx.createLinearGradient(0, y0, 0, yBase); gPos.addColorStop(0, hexA(posColor, 0.34)); gPos.addColorStop(1, hexA(posColor, 0.02));
      const gNeg = ctx.createLinearGradient(0, yBase, 0, y1); gNeg.addColorStop(0, hexA(negColor, 0.02)); gNeg.addColorStop(1, hexA(negColor, 0.34));
      for (const seg of groups) {
        if (seg.length < 1) continue;
        const runs = []; let run = { sign: seg[0].v >= 0 ? 1 : -1, pts: [{ t: seg[0].t, v: seg[0].v }] };
        for (let i = 1; i < seg.length; i++) { const pr = seg[i - 1], a = seg[i], sp = pr.v >= 0 ? 1 : -1, sc = a.v >= 0 ? 1 : -1; if (sc === sp) run.pts.push({ t: a.t, v: a.v }); else { const zt = pr.t + (a.t - pr.t) * (pr.v / (pr.v - a.v)); run.pts.push({ t: zt, v: 0 }); runs.push(run); run = { sign: sc, pts: [{ t: zt, v: 0 }, { t: a.t, v: a.v }] }; } }
        runs.push(run);
        for (const r of runs) { if (r.pts.length < 2) continue; ctx.beginPath(); ctx.moveTo(X(r.pts[0].t), yBase); ctx.lineTo(X(r.pts[0].t), Y(r.pts[0].v)); this._trace(ctx, r.pts, X, Y); ctx.lineTo(X(r.pts[r.pts.length - 1].t), yBase); ctx.closePath(); ctx.fillStyle = r.sign >= 0 ? gPos : gNeg; ctx.fill(); }
        ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
        for (const r of runs) { if (r.pts.length < 2) continue; ctx.beginPath(); ctx.moveTo(X(r.pts[0].t), Y(r.pts[0].v)); this._trace(ctx, r.pts, X, Y); ctx.strokeStyle = r.sign >= 0 ? posColor : negColor; ctx.stroke(); }
      }
    }

    disconnectedCallback() { this._stopLive(); if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } if (this._ro) { this._ro.disconnect(); this._ro = null; } }
  }

  if (!customElements.get(TAG)) {
    customElements.define(TAG, BatteryCard);
    window.customCards = window.customCards || [];
    window.customCards.push({ type: TAG, name: "Battery Card", description: "HomeWizard plug-in battery: charge/discharge power area + charge % line (Now/Day), charged/discharged energy bars (Week/Month/Year)." });
    console.info("%c BATTERY-CARD %c v6 ", "background:#e040fb;color:#fff", "background:#00e676;color:#000");
  }
})();
