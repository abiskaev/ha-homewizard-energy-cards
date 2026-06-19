/* HomeWizard-style Energy Cards - bundled build: all 8 cards in one file.
   Per-card source lives in /src. MIT. https://github.com/abiskaev/ha-homewizard-energy-cards */

;/* ===================== home-mains-card.js ===================== */
/*
 * home-mains-card  (v3)
 * Live HA card styled after the Google Stitch "Home mains" design, real data, no chart lib.
 *  - Period (Now/Day/Week/Month/Year) read from input_select.energy_period (set by energy-header-card).
 *  - Day  = today's history (00:00 -> now), filled curve.
 *  - Now  = live ~60s window: sampled every 0.5s, scrolls right->left (rAF), no x-axis labels,
 *           values refresh ~every 0.5s. (Week/Month/Year fall back to Day until wired.)
 *  - Combined = net grid (magenta import / green surplus). Pill toggles to 3 phases.
 *  - Dynamic ASYMMETRIC y-axis: top = highest positive, bottom = lowest negative, eased smoothly.
 */
(function () {
  const TAG = "home-mains-card";
  const GRID_POS = "#e040fb", GRID_NEG = "#00e676";
  const WINDOW = 60000;           // live window length (ms)
  const EASE = 0.14;              // y-axis ease factor per frame

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

  class HomeMainsCard extends HTMLElement {
    constructor() {
      super(); this.attachShadow({ mode: "open" });
      this._mode = "combined"; this._period = "Day";
      this._data = null; this._live = {}; this._dispMax = null; this._dispMin = null; this._archive = null; this._archiveDate = null; this._archiveCache = {};
      this._lastFetch = 0; this._fetching = false; this._built = false;
      this._raf = null; this._sampleTimer = null; this._ro = null;
    }
    setConfig(config) {
      this._cfg = {
        title: config.title || "Home mains",
        power_entity: config.power_entity || "sensor.p1_meter_power",
        import_today: config.import_today || "sensor.grid_import_daily",
        export_today: config.export_today || "sensor.grid_export_daily",
        import_stat: config.import_stat || "sensor.p1_meter_energy_import",
        export_stat: config.export_stat || "sensor.p1_meter_energy_export",
        period_entity: config.period_entity || "input_select.energy_period",
        date_entity: config.date_entity || "input_datetime.energy_date",
        import_rate: config.import_rate != null ? Number(config.import_rate) : null,
        export_rate: config.export_rate != null ? Number(config.export_rate) : null,
        hours: Number(config.hours) > 0 ? Number(config.hours) : 24,
        bucket: Number(config.bucket_minutes) > 0 ? Number(config.bucket_minutes) : 10,
        height: Number(config.height) > 0 ? Number(config.height) : 250,
        phases: (config.phases && config.phases.length ? config.phases : [
          { entity: "sensor.p1_meter_power_phase_1", name: "Phase 1", color: "#e040fb", neg_color: "#00e676" },
          { entity: "sensor.p1_meter_power_phase_2", name: "Phase 2", color: "#7b1fa2", neg_color: "#00bfa5" },
          { entity: "sensor.p1_meter_power_phase_3", name: "Phase 3", color: "#00b0ff", neg_color: "#b2ff59" }
        ]).map((p) => ({ entity: p.entity, name: p.name || p.entity, color: p.color || "#e040fb", neg: p.neg_color || p.negColor || "#00e676" }))
      };
      this._built = false; this._data = null; this._dispMax = null; this._dispMin = null;
    }
    getCardSize() { return Math.ceil(this._cfg.height / 50) + 2; }

    set hass(hass) {
      this._hass = hass; if (!this._built) this._build();
      const st = hass.states[this._cfg.period_entity];
      const per = st ? st.state : "Day";
      if (per !== this._period) this._setPeriod(per);
      if (this._period !== "Now") {
        const dst = hass.states[this._cfg.date_entity]; const dstr = dst ? dst.state : null;
        if (dstr !== this._selDate) { this._selDate = dstr; this._dispMax = null; this._dispMin = null; }  // keep _data + _archiveCache so revisits stay instant
      }
      this._updateHeader();
      if (this._period === "Week") this._loadWeek();
      else if (this._period === "Month") this._loadMonth();
      else if (this._period === "Year") this._loadYear();
      else if (this._period !== "Now") this._loadDay();
    }

    _setPeriod(per) {
      this._period = per; this._dispMax = null; this._dispMin = null;
      if ((per === "Week" || per === "Month" || per === "Year") && this._el) { this._mode = "combined"; this._el.phaseBtn.classList.remove("on"); this._el.phaseBtn.textContent = "⚡ 3-phase distribution"; }
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
          .card{background:#1c1c1e;border:1px solid #3a3a3c;border-radius:16px;padding:18px 20px 12px;position:relative;
                font-family:Inter,Roboto,-apple-system,"Segoe UI",sans-serif;color:#e6e0e9;}
          .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;}
          .head-l{min-width:0;}
          .title{font-size:17px;font-weight:500;color:#cbc4d2;margin:0 0 6px;}
          .readings{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;}
          .rd{display:flex;align-items:baseline;gap:6px;}
          .rlabel{font-size:13px;color:#fff;}
          .num{font-size:38px;font-weight:700;letter-spacing:-.02em;line-height:1;}
          .unit{font-size:13px;color:#cbc4d2;} .cost{font-size:17px;color:#cbc4d2;margin-left:4px;}
          .legend{position:absolute;top:18px;right:56px;display:flex;flex-direction:column;gap:5px;align-items:flex-start;}
          .lg{display:flex;align-items:center;gap:8px;font-size:13px;color:#cbc4d2;white-space:nowrap;}
          .lg-name{display:flex;align-items:center;gap:6px;}
          .lg-val{width:84px;text-align:right;font-weight:700;}
          .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;}
          .wrap{position:relative;width:100%;margin-top:10px;} canvas{display:block;width:100%;}
          .empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#cbc4d2;font-size:13px;}
          .bottom{display:flex;align-items:center;justify-content:flex-end;margin-top:8px;padding-top:10px;border-top:1px solid #3a3a3c;}
          .pill{display:flex;align-items:center;gap:7px;background:#2c2c2e;border:1px solid #3a3a3c;border-radius:999px;padding:6px 13px;color:#cbc4d2;font:inherit;font-size:13px;cursor:pointer;}
          .pill.on{border-color:#7a7a7e;color:#fff;background:#38353c;}
          .pill:disabled{opacity:.4;cursor:default;}
          .live{display:none;align-items:center;gap:6px;font-size:12px;color:#0a84ff;margin-left:8px;}
          .live .d{width:8px;height:8px;border-radius:50%;background:#0a84ff;animation:bl 1s infinite;}
          @keyframes bl{50%{opacity:.25;}}
        </style>
        <div class="card">
          <div class="head">
            <div class="head-l">
              <div class="title">${c.title}<span class="live" id="live"><span class="d"></span>LIVE</span></div>
              <div class="readings">
                <div class="rd"><span class="rlabel">Grid</span><span class="num" id="r1" style="color:${GRID_POS}">–</span><span class="unit">kWh</span></div>
                <div class="rd"><span class="rlabel">Surplus</span><span class="num" id="r2" style="color:${GRID_NEG}">–</span><span class="unit">kWh</span></div>
                <span class="cost" id="cost"></span>
              </div>
            </div>
            <div class="legend" id="legend"></div>
          </div>
          <div class="wrap"><canvas></canvas><div class="empty">Loading…</div></div>
          <div class="bottom"><button class="pill" id="phaseBtn">⚡ 3-phase distribution</button></div>
        </div>`;
      this._el = { r1: this.shadowRoot.getElementById("r1"), r2: this.shadowRoot.getElementById("r2"), cost: this.shadowRoot.getElementById("cost"), legend: this.shadowRoot.getElementById("legend"), phaseBtn: this.shadowRoot.getElementById("phaseBtn"), live: this.shadowRoot.getElementById("live") };
      this._canvas = this.shadowRoot.querySelector("canvas"); this._empty = this.shadowRoot.querySelector(".empty"); this._wrap = this.shadowRoot.querySelector(".wrap");
      this._canvas.style.height = c.height + "px"; this._wrap.style.height = c.height + "px";
      this._el.phaseBtn.addEventListener("click", () => this._toggleMode());
      this._built = true;
      if (this._ro) this._ro.disconnect();
      this._ro = new ResizeObserver(() => this._animate()); this._ro.observe(this._wrap);
    }

    _toggleMode() {
      if (this._period === "Week") return;   // 3-phase distribution disabled in week view
      this._mode = this._mode === "combined" ? "phase" : "combined";
      this._el.phaseBtn.classList.toggle("on", this._mode === "phase");
      this._el.phaseBtn.textContent = this._mode === "phase" ? "⚡ Phases Aggregation" : "⚡ 3-phase distribution";
      this._dispMax = null; this._dispMin = null; this._updateHeader();
      if (this._period === "Now") { this._stopLive(); this._startLive(); }
      else { this._loadDay(); }   // data already cached (all entities) -> instant re-render
    }

    _seriesDefs() {
      if (this._mode === "phase") return this._cfg.phases.map((p) => ({ entity: p.entity, name: p.name, pos: p.color, neg: p.neg }));
      return [{ entity: this._cfg.power_entity, name: "Grid", pos: GRID_POS, neg: GRID_NEG }];
    }

    _updateHeader() {
      if (!this._hass || !this._el) return;
      this._el.live.style.display = this._period === "Now" ? "inline-flex" : "none";
      this._el.phaseBtn.disabled = this._period === "Week" || this._period === "Month" || this._period === "Year";   // 3-phase disabled in bar views
      const agg = this._period === "Week" ? this._week : (this._period === "Month" ? this._month : (this._period === "Year" ? this._year : null));
      const barMode = this._period === "Week" || this._period === "Month" || this._period === "Year";
      const isToday = this._isToday();
      const pastDay = !barMode && this._period !== "Now" && !isToday;
      const useArch = pastDay && this._archive && this._archiveDate === this._selDate;
      let iv = null, ev = null, noData = false;
      if (barMode) { iv = agg ? agg.gridTotal : null; ev = agg ? agg.surplusTotal : null; }
      else if (!pastDay) { const imp = this._hass.states[this._cfg.import_today], exp = this._hass.states[this._cfg.export_today]; iv = imp ? num(imp.state) : null; ev = exp ? num(exp.state) : null; }
      else if (useArch) { iv = num(this._archive.import_kwh); ev = num(this._archive.export_kwh); }
      else noData = true; // past day with no stored data -> dashes, so it's clearly empty
      this._el.r1.textContent = noData ? "—" : (iv != null ? iv.toFixed(1) : "–");
      this._el.r2.textContent = noData ? "—" : (ev != null ? ev.toFixed(1) : "–");
      if (!noData && this._cfg.import_rate != null && iv != null) { const er = this._cfg.export_rate != null ? this._cfg.export_rate : 0; this._el.cost.textContent = "€" + (iv * this._cfg.import_rate - (ev != null ? ev * er : 0)).toFixed(2); }
      else this._el.cost.textContent = "";
      if (this._mode === "phase") {
        this._el.legend.innerHTML = this._cfg.phases.map((p) => {
          if (pastDay) {   // historical day: show that day's net energy per phase in kWh (signed), same colours as Today
            let kwh = null;
            if (useArch && this._archive.series && this._archive.series[p.entity]) { const arr = this._archive.series[p.entity], bm = this._archive.bucket_min || 5; let sum = 0, any = false; for (const x of arr) if (x != null) { sum += x; any = true; } if (any) kwh = sum * (bm / 60) / 1000; }
            const col = kwh == null ? "#cbc4d2" : (kwh < 0 ? p.neg : p.color);
            return `<span class="lg"><span class="lg-name"><span class="dot" style="background:${p.color}"></span>${p.name}</span><b class="lg-val" style="color:${col}">${kwh == null ? "—" : kwh.toFixed(2) + " kWh"}</b></span>`;
          }
          const s = this._hass.states[p.entity]; const v = s ? num(s.state) : null; const col = v == null ? "#cbc4d2" : (v < 0 ? p.neg : p.color);
          return `<span class="lg"><span class="lg-name"><span class="dot" style="background:${p.color}"></span>${p.name}</span><b class="lg-val" style="color:${col}">${v == null ? "—" : fmtW(v) + " W"}</b></span>`;
        }).join("");
      } else if (this._period === "Now" || this._period === "Day") {
        const s = this._hass.states[this._cfg.power_entity]; const v = s ? num(s.state) : null;
        const sp = `<span class="lg" style="visibility:hidden"><span class="lg-name"><span class="dot"></span>Phase 3</span><b class="lg-val">0 W</b></span>`; // 2 invisible rows drop Grid/Surplus onto Phase 3's row
        if (v == null) this._el.legend.innerHTML = "";
        else if (v >= 0) this._el.legend.innerHTML = sp + sp + `<span class="lg"><span class="lg-name"><span class="dot" style="background:${GRID_POS}"></span>Grid</span><b class="lg-val" style="color:${GRID_POS}">${fmtPower(v)}</b></span>`;
        else this._el.legend.innerHTML = sp + sp + `<span class="lg"><span class="lg-name"><span class="dot" style="background:${GRID_NEG}"></span>Surplus</span><b class="lg-val" style="color:${GRID_NEG}">${fmtPower(-v)}</b></span>`;
      } else {
        this._el.legend.innerHTML = ""; // Day/Week/Month/Year aggregated view: no dot-legend (labels are on the numbers)
      }
    }

    // ---- live (Now) ----
    _startLive() {
      this._stopLive(); this._live = {};
      this._seedLive();
      this._sampleTimer = setInterval(() => this._sample(), 500);
      this._sample(); this._animate();
    }
    _stopLive() { if (this._sampleTimer) { clearInterval(this._sampleTimer); this._sampleTimer = null; } }
    async _seedLive() {
      try {
        const ids = this._seriesDefs().map((s) => s.entity);
        const now = Date.now(), start = now - WINDOW;
        const res = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(now - WINDOW - 8000).toISOString(), end_time: new Date(now).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true });
        ids.forEach((id) => {
          const raw = (res && res[id] ? res[id] : []).map((p) => ({ t: ptTime(p), v: ptVal(p) })).filter((p) => p.t != null && isFinite(p.v));
          this._live[id] = this._resample(raw, start, now, 500); // even 0.5s grid -> trimming removes tiny steps, no left-edge jumps
        });
        this._animate();
      } catch (e) { /* sampling will fill it */ }
    }
    _resample(raw, s, e, step) {
      const out = []; let i = 0, last = null;
      while (i < raw.length && raw[i].t <= s) { last = raw[i].v; i++; }
      for (let t = s; t <= e; t += step) { while (i < raw.length && raw[i].t <= t) { last = raw[i].v; i++; } if (last != null) out.push({ t, v: last }); }
      return out;
    }
    _sample() {
      if (!this._hass) return; const now = Date.now(), cutoff = now - WINDOW - 2000;
      this._seriesDefs().forEach((s) => {
        const st = this._hass.states[s.entity]; const v = st ? num(st.state) : null;
        if (!this._live[s.entity]) this._live[s.entity] = [];
        if (v != null) this._live[s.entity].push({ t: now, v });
        const a = this._live[s.entity]; let i = 0; while (i < a.length && a[i].t < cutoff) i++; if (i) a.splice(0, i);
      });
      this._updateHeader();
    }

    _dayStart() {
      const s = this._selDate; const p = s ? String(s).split("-") : null;
      const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0) : new Date(new Date().setHours(0, 0, 0, 0));
      return d.getTime();
    }
    _isToday() {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      return this._dayStart() === today.getTime();
    }
    _loadDay() {
      if (this._isToday()) { this._archive = null; this._archiveDate = null; this._maybeFetch(); return; }
      const cached = this._archiveCache[this._selDate];
      if (cached !== undefined) { this._archive = cached === "nodata" ? null : cached; this._archiveDate = this._selDate; this._updateHeader(); this._animate(); return; }  // revisit -> instant from memory
      if (this._loadingArchive === this._selDate) return;                                       // fetch in flight
      this._loadingArchive = this._selDate; this._loadArchive(this._selDate);
    }
    async _loadArchive(dateStr) {
      const want = dateStr;
      if (!dateStr) { this._maybeFetch(); return; }
      try {
        const r = await fetch(`/local/energy-archive/${dateStr}.json`, { cache: "no-cache" });
        this._archiveCache[dateStr] = r.ok ? await r.json() : "nodata";                          // cache result (real data or "no data") for instant revisits
      } catch (e) { /* leave uncached so it can retry */ }
      finally { if (this._loadingArchive === want) this._loadingArchive = null; }
      if (this._selDate !== want) return;                                                         // user navigated away mid-load
      const c = this._archiveCache[want];
      this._archive = (c && c !== "nodata") ? c : null; this._archiveDate = want;
      this._dispMax = null; this._dispMin = null; this._updateHeader(); this._animate();
    }
    // ---- day (history) ----
    _allEntities() { return [this._cfg.power_entity].concat(this._cfg.phases.map((p) => p.entity)).filter((e, i, a) => a.indexOf(e) === i); }
    async _fetchInto(ids) {
      if (!ids || !ids.length) return;
      const dayStart = this._dayStart(), dayEnd = Math.min(Date.now(), dayStart + this._cfg.hours * 3600000);
      const res = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(dayStart).toISOString(), end_time: new Date(dayEnd).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true });
      if (!this._data) this._data = {};
      ids.forEach((id) => { this._data[id] = (res && res[id] ? res[id] : []).map((p) => ({ t: ptTime(p), v: ptVal(p) })).filter((p) => p.t != null && isFinite(p.v)); });
    }
    async _maybeFetch() {
      if (!this._hass || this._fetching || this._period === "Now") return;
      const now = Date.now(); if (this._data && now - this._lastFetch < 30000) { this._animate(); return; }  // throttle to 30s; prefetch keeps all views ready
      this._fetching = true;
      try {
        const all = this._allEntities(), cur = this._seriesDefs().map((s) => s.entity);
        await this._fetchInto(cur); this._lastFetch = Date.now(); this._animate();        // current view first -> fast first paint
        const rest = all.filter((e) => cur.indexOf(e) < 0);
        if (rest.length) { await this._fetchInto(rest); this._animate(); }                // prefetch the other view -> instant toggle
      } catch (e) { if (this._empty) { this._empty.textContent = "History unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetching = false; }
    }
    // ---- week (daily-statistics bar chart) ----
    _weekMonday() {
      const s = this._selDate; const p = s ? String(s).split("-") : null;
      const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date();
      d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
      return d.getTime();
    }
    async _loadWeek() {
      if (!this._hass || this._fetchingWeek) return;
      const mon = this._weekMonday();
      if (this._week && this._week.monday === mon && Date.now() - (this._weekFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingWeek = true;
      try {
        const end = Math.min(Date.now(), mon + 7 * 86400000);
        const res = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(mon).toISOString(), end_time: new Date(end).toISOString(), statistic_ids: [this._cfg.import_stat, this._cfg.export_stat], period: "day" });
        const days = []; for (let i = 0; i < 7; i++) days.push({ grid: null, surplus: null });
        const put = (rows, key) => { (rows || []).forEach((e) => { const dd = new Date(e.start); dd.setHours(0, 0, 0, 0); const i = Math.round((dd.getTime() - mon) / 86400000); if (i >= 0 && i < 7 && e.change != null) days[i][key] = e.change; }); };
        put(res && res[this._cfg.import_stat], "grid"); put(res && res[this._cfg.export_stat], "surplus");
        let gt = 0, st = 0; days.forEach((d) => { if (d.grid > 0) gt += d.grid; if (d.surplus > 0) st += d.surplus; });
        this._week = { monday: mon, days, gridTotal: gt, surplusTotal: st }; this._weekFetch = Date.now();
        this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingWeek = false; }
    }
    _roundBar(ctx, x, y, w, h, r) {
      r = Math.max(0, Math.min(r, w / 2, h));
      ctx.beginPath();
      ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
      ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
      ctx.lineTo(x + w, y + h); ctx.closePath();
    }
    _renderWeek() {
      const names = ["mo", "tu", "we", "th", "fr", "sa", "su"];
      const days = (this._week && this._week.days) || names.map(() => ({ grid: null, surplus: null }));
      this._renderBars(days.map((d, i) => ({ label: names[i], grid: d.grid, surplus: d.surplus })));
    }
    _monthRange() {
      const s = this._selDate; const p = s ? String(s).split("-") : null;
      const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date();
      return { first: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), next: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(), key: d.getFullYear() + "-" + d.getMonth() };
    }
    async _loadMonth() {
      if (!this._hass || this._fetchingMonth) return;
      const mr = this._monthRange();
      if (this._month && this._month.key === mr.key && Date.now() - (this._monthFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingMonth = true;
      try {
        const weeks = [], map = {};
        for (let wk = mondayMs(mr.first); wk < mr.next; wk += 7 * 86400000) { map[wk] = weeks.length; weeks.push({ weekNum: isoWeek(wk), grid: null, surplus: null }); }
        const end = Math.min(Date.now(), mr.next);
        const res = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(mr.first).toISOString(), end_time: new Date(end).toISOString(), statistic_ids: [this._cfg.import_stat, this._cfg.export_stat], period: "day" });
        const add = (rows, key) => { (rows || []).forEach((e) => { const i = map[mondayMs(e.start)]; if (i != null && e.change != null) weeks[i][key] = (weeks[i][key] || 0) + e.change; }); };
        add(res && res[this._cfg.import_stat], "grid"); add(res && res[this._cfg.export_stat], "surplus");
        let gt = 0, st = 0; weeks.forEach((w) => { if (w.grid > 0) gt += w.grid; if (w.surplus > 0) st += w.surplus; });
        this._month = { key: mr.key, weeks, gridTotal: gt, surplusTotal: st }; this._monthFetch = Date.now();
        this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingMonth = false; }
    }
    _renderMonth() {
      const weeks = (this._month && this._month.weeks) || [];
      this._renderBars(weeks.map((w) => ({ label: String(w.weekNum), grid: w.grid, surplus: w.surplus })));
    }
    _yearRange() {
      const s = this._selDate; const p = s ? String(s).split("-") : null;
      const y = (p && p.length >= 1 && +p[0]) ? +p[0] : new Date().getFullYear();
      return { first: new Date(y, 0, 1).getTime(), next: new Date(y + 1, 0, 1).getTime(), year: y };
    }
    async _loadYear() {
      if (!this._hass || this._fetchingYear) return;
      const yr = this._yearRange();
      if (this._year && this._year.year === yr.year && Date.now() - (this._yearFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingYear = true;
      try {
        const months = []; for (let m = 0; m < 12; m++) months.push({ grid: null, surplus: null });
        const end = Math.min(Date.now(), yr.next);
        const res = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(yr.first).toISOString(), end_time: new Date(end).toISOString(), statistic_ids: [this._cfg.import_stat, this._cfg.export_stat], period: "month" });
        const add = (rows, key) => { (rows || []).forEach((e) => { const d = new Date(e.start); if (d.getFullYear() === yr.year && e.change != null) months[d.getMonth()][key] = e.change; }); };
        add(res && res[this._cfg.import_stat], "grid"); add(res && res[this._cfg.export_stat], "surplus");
        let gt = 0, st = 0; months.forEach((m) => { if (m.grid > 0) gt += m.grid; if (m.surplus > 0) st += m.surplus; });
        this._year = { year: yr.year, months, gridTotal: gt, surplusTotal: st }; this._yearFetch = Date.now();
        this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingYear = false; }
    }
    _renderYear() {
      const M = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
      const months = (this._year && this._year.months) || M.map(() => ({ grid: null, surplus: null }));
      this._renderBars(months.map((m, i) => ({ label: M[i], grid: m.grid, surplus: m.surplus })));
    }
    _renderBars(slots) {
      const c = this._cfg, W = this._wrap.clientWidth, H = c.height; if (!W) return;
      const dpr = window.devicePixelRatio || 1, cv = this._canvas;
      const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      if (!slots.length) slots = [{ label: "", grid: null, surplus: null }];
      let mx = 0; for (const s of slots) { if (s.grid > mx) mx = s.grid; if (s.surplus > mx) mx = s.surplus; }
      const step = niceStep(mx / 5) || 1;
      const top = Math.max(step, Math.ceil(mx / (step / 2)) * (step / 2));   // tight axis (half-step granularity) so the tallest bar fills the height
      const padL = 10, padR = 40, padT = 24, padB = 22;
      const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
      const Y = (v) => y1 - (v / top) * (y1 - y0);
      ctx.font = "11px Inter, system-ui, sans-serif";
      for (let v = 0; v <= top + 1e-6; v += step) {
        const yy = Y(v);
        ctx.strokeStyle = v === 0 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
        ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(fmtNum(v), W - 6, yy);
      }
      const n = slots.length, slotW = (x1 - x0) / n;
      const barW = Math.max(6, Math.min(20, slotW * 0.2)), innerGap = 4, pairW = barW * 2 + innerGap;
      for (let i = 0; i < n; i++) {
        const cx = x0 + slotW * (i + 0.5), gx = cx - pairW / 2, sx = gx + barW + innerGap;
        const bars = [{ x: gx, v: slots[i].grid, col: GRID_POS }, { x: sx, v: slots[i].surplus, col: GRID_NEG }];
        for (const b of bars) {
          if (b.v == null || b.v <= 0) continue;
          const by = Y(b.v), bh = y1 - by;
          const g = ctx.createLinearGradient(0, by, 0, y1); g.addColorStop(0, b.col); g.addColorStop(1, hexA(b.col, 0.45));
          this._roundBar(ctx, b.x, by, barW, bh, 4); ctx.fillStyle = g; ctx.fill();
          ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(fmtNum(b.v), b.x + barW / 2, by - 5);
        }
        ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(slots[i].label, cx, H - 6);
      }
      const any = slots.some((s) => (s.grid > 0) || (s.surplus > 0));
      this._empty.style.display = any ? "none" : "flex"; if (!any) this._empty.textContent = "No data";
    }
    _bucketize(points, s, e, b) {
      const n = Math.max(1, Math.ceil((e - s) / b)); const su = new Array(n).fill(0), cn = new Array(n).fill(0); let last = null;
      for (const p of points) { if (p.t < s) { last = p.v; continue; } const i = Math.floor((p.t - s) / b); if (i < 0 || i >= n) continue; su[i] += p.v; cn[i]++; }
      const out = new Array(n); for (let i = 0; i < n; i++) { const t = s + i * b + b / 2; if (cn[i] > 0) { last = su[i] / cn[i]; out[i] = { t, v: last }; } else out[i] = { t, v: last != null ? last : null }; } return out;
    }

    _buildSeries() {
      const defs = this._seriesDefs();
      if (this._period === "Now") return defs.map((d) => {
        const buf = (this._live[d.entity] || []).slice();
        const st = this._hass && this._hass.states[d.entity]; const lv = st ? num(st.state) : (buf.length ? buf[buf.length - 1].v : null);
        if (lv != null) buf.push({ t: Date.now(), v: lv }); // anchor live value to the right edge -> new data leads
        return { def: d, pts: buf };
      });
      if (this._archive && this._archiveDate === this._selDate && this._archive.series) {        // past day from long-term archive (5-min, kept ~20y)
        const aStart = this._dayStart(), abms = (this._archive.bucket_min || 5) * 60000;
        const f = Math.max(1, Math.round((this._cfg.bucket * 60000) / abms));   // re-bucket archive to the display interval (e.g. 2x5min -> 10min)
        return defs.map((d) => { const arr = this._archive.series[d.entity] || []; const pts = []; for (let i = 0; i < arr.length; i += f) { let su = 0, cn = 0; for (let k = i; k < i + f && k < arr.length; k++) if (arr[k] != null) { su += arr[k]; cn++; } pts.push({ t: aStart + (i + f / 2) * abms, v: cn > 0 ? su / cn : null }); } return { def: d, pts }; });
      }
      const axisStart = this._dayStart();
      const axisEnd = axisStart + this._cfg.hours * 3600000, dataEnd = Math.min(Date.now(), axisEnd), bms = this._cfg.bucket * 60000;
      return defs.map((d) => ({ def: d, pts: this._bucketize(this._data && this._data[d.entity] ? this._data[d.entity] : [], axisStart, dataEnd, bms) }));
    }

    // ---- animation + render ----
    _animate() { if (!this._raf) this._raf = requestAnimationFrame(() => this._frame()); }
    _frame() {
      this._raf = null; if (!this._built || !this._wrap.clientWidth) return;
      if (this._period === "Week") { this._renderWeek(); return; }   // bar chart, no easing loop
      if (this._period === "Month") { this._renderMonth(); return; }
      if (this._period === "Year") { this._renderYear(); return; }
      const series = this._buildSeries();
      let maxPos = 0, maxNeg = 0;
      for (const s of series) for (const p of s.pts) if (p.v != null) { if (p.v > maxPos) maxPos = p.v; if (-p.v > maxNeg) maxNeg = -p.v; }
      let tMax = maxPos > 0 ? maxPos * 1.1 : 0, tMin = maxNeg > 0 ? -maxNeg * 1.1 : 0; // proportional headroom -> smooth scaling
      if (tMax < 0) tMax = 0; if (tMin > 0) tMin = 0;
      if (tMax - tMin < 100) tMax = tMin + 100;
      if (this._dispMax == null) { this._dispMax = tMax; this._dispMin = tMin; }
      else { this._dispMax += (tMax - this._dispMax) * EASE; this._dispMin += (tMin - this._dispMin) * EASE; }
      this._render(series);
      const easing = Math.abs(tMax - this._dispMax) > 0.5 || Math.abs(tMin - this._dispMin) > 0.5;
      if (this._period === "Now" || easing) this._raf = requestAnimationFrame(() => this._frame());
    }

    _render(series) {
      const c = this._cfg, W = this._wrap.clientWidth, H = c.height; if (!W || this._dispMax == null) return;
      const dpr = window.devicePixelRatio || 1, cv = this._canvas;
      const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; } // only resize on real change -> no per-frame flicker
      const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const isNow = this._period === "Now";
      const padL = 46, padR = 14, padT = 10, padB = isNow ? 10 : 22;
      const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
      let axisStart, axisEnd;
      if (isNow) { axisEnd = Date.now(); axisStart = axisEnd - WINDOW; }
      else { axisStart = this._dayStart(); axisEnd = axisStart + c.hours * 3600000; }
      const dMax = this._dispMax, dMin = this._dispMin;
      const X = (t) => x0 + ((t - axisStart) / (axisEnd - axisStart)) * (x1 - x0);
      const Y = (v) => y1 - ((v - dMin) / (dMax - dMin)) * (y1 - y0);
      const yBase = Y(0);
      ctx.font = "11px Inter, system-ui, sans-serif";
      // grid + labels (nice steps, includes 0)
      const step = niceStep((dMax - dMin) / 4) || 1;
      ctx.textBaseline = "middle"; ctx.textAlign = "right";
      for (let k = Math.ceil(dMin / step); k * step <= dMax + 1e-6; k++) {
        const v = k * step, yy = Y(v); if (yy < y0 - 1 || yy > y1 + 1) continue;
        ctx.strokeStyle = v === 0 ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
        ctx.fillStyle = "#cbc4d2"; ctx.fillText(fmtW(v), x0 - 6, yy);
      }
      // x labels (day only)
      if (!isNow) { ctx.textBaseline = "alphabetic"; ctx.textAlign = "center"; ctx.fillStyle = "#cbc4d2"; for (const h of [2, 7, 12, 17, 22]) { const t = axisStart + h * 3600000, xx = X(t); if (xx < x0 || xx > x1) continue; ctx.fillText(String(h).padStart(2, "0") + ":00", xx, H - 6); } }
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      for (const s of series) this._drawSeries(ctx, s.pts, X, Y, yBase, y0, y1, s.def.pos, s.def.neg);
      ctx.restore();
      let any = false; for (const s of series) for (const p of s.pts) if (p.v != null) { any = true; break; }
      this._empty.style.display = any ? "none" : "flex"; if (!any) this._empty.textContent = isNow ? "Waiting for live data…" : "No data";
    }

    _trace(ctx, seg, X, Y) {   // smooth curve through the points (quadratic, midpoint method) - no overshoot past the data
      const n = seg.length;
      if (n < 3) { for (let i = 1; i < n; i++) ctx.lineTo(X(seg[i].t), Y(seg[i].v)); return; }
      for (let i = 1; i < n - 2; i++) { const xc = (X(seg[i].t) + X(seg[i + 1].t)) / 2, yc = (Y(seg[i].v) + Y(seg[i + 1].v)) / 2; ctx.quadraticCurveTo(X(seg[i].t), Y(seg[i].v), xc, yc); }
      ctx.quadraticCurveTo(X(seg[n - 2].t), Y(seg[n - 2].v), X(seg[n - 1].t), Y(seg[n - 1].v));
    }
    _drawSeries(ctx, pts, X, Y, yBase, y0, y1, posColor, negColor) {
      const groups = []; let cur = [];
      for (const p of pts) { if (p.v == null) { if (cur.length) { groups.push(cur); cur = []; } } else cur.push(p); }
      if (cur.length) groups.push(cur);
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
    customElements.define(TAG, HomeMainsCard);
    window.customCards = window.customCards || [];
    window.customCards.push({ type: TAG, name: "Home Mains Card", description: "Stitch-styled mains energy card: live Now + Day, dynamic axis (import magenta / export green)." });
    console.info("%c HOME-MAINS-CARD %c v3 live+dynamic ", "background:#e040fb;color:#fff", "background:#00e676;color:#000");
  }
})();


;/* ===================== phase-mains-card.js ===================== */
/*
 * phase-mains-card
 * Custom Lovelace card (no chart library) for the energy-pro dashboard.
 * Per-phase power: each phase keeps its colour above zero and turns its own
 * shade of green below zero (line AND fill), split exactly at zero-crossings.
 *
 * Follows HA's energy date-selection widget (hass.connection._energy) so the
 * Day/Week/Month/Year picker + date navigation drive this chart, exactly like
 * the built-in Energy dashboard. Raw history for short ranges, long-term
 * statistics (hourly/daily means) for longer ranges.
 *
 * Config:
 *   type: custom:phase-mains-card
 *   title: Home mains — per phase
 *   hours: 24                 # fallback window when no energy picker present
 *   bucket_minutes: 5         # history averaging bucket
 *   height: 220
 *   follow_energy_date: true  # subscribe to the energy date picker
 *   label_hours: [2,7,12,17,22]
 *   phases:
 *     - entity: sensor.p1_meter_power_phase_1
 *       name: Phase 1
 *       color: '#e040fb'
 *       neg_color: '#00e676'
 */
(function () {
  const TAG = 'phase-mains-card';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;

  const pad2 = (n) => String(n).padStart(2, '0');

  function ptTime(pt) {
    let t = pt.lu != null ? pt.lu : (pt.lc != null ? pt.lc : (pt.last_updated != null ? pt.last_updated : pt.last_changed));
    if (t == null) return null;
    if (typeof t === 'string') return Date.parse(t);
    return t < 1e12 ? t * 1000 : t;
  }
  function ptVal(pt) {
    return parseFloat(pt.s != null ? pt.s : pt.state);
  }
  function niceCeil(v) {
    if (v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const f = v / base;
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * base;
  }
  function niceStep(v) {
    if (v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const f = v / base;
    const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    return nf * base;
  }
  function hexA(hex, a) {
    let h = (hex || '').trim();
    if (h[0] === '#') h = h.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n)) return 'rgba(255,255,255,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function fmtW(v) {
    return Math.round(v).toLocaleString();
  }

  function pickXLabels(axisStart, axisEnd, labelHours) {
    const range = axisEnd - axisStart;
    const out = [];
    const sd = new Date(axisStart);
    const isMidnightDay = Math.abs(range - DAY) < HOUR && sd.getHours() === 0 && sd.getMinutes() === 0;
    if (isMidnightDay) {
      for (const hh of labelHours) if (hh >= 0 && hh <= 24) out.push({ t: axisStart + hh * HOUR, txt: pad2(hh) + ':00' });
    } else if (range <= 2.5 * DAY) {
      const stepH = Math.max(1, Math.round((range / HOUR) / 6));
      for (let t = axisStart; t <= axisEnd + 1; t += stepH * HOUR) out.push({ t, txt: pad2(new Date(t).getHours()) + ':00' });
    } else if (range <= 35 * DAY) {
      for (let i = 0; i <= 5; i++) { const t = axisStart + (i / 5) * range; const d = new Date(t); out.push({ t, txt: pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) }); }
    } else {
      for (let i = 0; i <= 5; i++) { const t = axisStart + (i / 5) * range; out.push({ t, txt: MONTHS[new Date(t).getMonth()] }); }
    }
    return out;
  }

  class PhaseMainsCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._data = null;
      this._lastFetch = 0;
      this._fetching = false;
      this._built = false;
      this._ro = null;
      this._mode = 'history';
      this._winStart = 0;
      this._winEnd = 0;
      this._energyUnsub = null;
      this._energyStart = null;
      this._energyEnd = null;
      this._energyTimer = null;
      this._energyTries = 0;
    }

    setConfig(config) {
      if (!config || !Array.isArray(config.phases) || config.phases.length === 0) {
        throw new Error('phase-mains-card: "phases" must be a non-empty list');
      }
      this._config = {
        title: config.title || 'Home mains — per phase',
        hours: Number(config.hours) > 0 ? Number(config.hours) : 24,
        bucket: Number(config.bucket_minutes) > 0 ? Number(config.bucket_minutes) : 5,
        height: Number(config.height) > 0 ? Number(config.height) : 220,
        labelHours: Array.isArray(config.label_hours) ? config.label_hours : [2, 7, 12, 17, 22],
        followEnergy: config.follow_energy_date !== false,
        phases: config.phases.map((p) => ({
          entity: p.entity,
          name: p.name || p.entity,
          color: p.color || '#e040fb',
          negColor: p.neg_color || p.negColor || '#00e676',
        })),
      };
      this._built = false;
      this._data = null;
      this._lastFetch = 0;
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._built) this._build();
      this._updateHeader();
      this._ensureEnergy();
      this._maybeFetch(false);
    }

    getCardSize() {
      return Math.ceil((this._config ? this._config.height : 220) / 50) + 1;
    }

    _build() {
      const c = this._config;
      this.shadowRoot.innerHTML =
        '<style>' +
        'ha-card{padding:10px 14px 8px;}' +
        '.hdr{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px;}' +
        '.title{font-size:14px;font-weight:500;color:var(--primary-text-color);}' +
        '.states{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--secondary-text-color);}' +
        '.st{display:flex;align-items:center;gap:5px;white-space:nowrap;}' +
        '.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:0 0 auto;}' +
        '.st b{font-weight:500;}' +
        '.wrap{position:relative;width:100%;}' +
        'canvas{display:block;width:100%;}' +
        '.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--secondary-text-color);font-size:13px;}' +
        '</style>' +
        '<ha-card>' +
        '<div class="hdr"><div class="title"></div><div class="states"></div></div>' +
        '<div class="wrap"><canvas></canvas><div class="empty">Loading…</div></div>' +
        '</ha-card>';
      this._titleEl = this.shadowRoot.querySelector('.title');
      this._statesEl = this.shadowRoot.querySelector('.states');
      this._canvas = this.shadowRoot.querySelector('canvas');
      this._emptyEl = this.shadowRoot.querySelector('.empty');
      this._wrap = this.shadowRoot.querySelector('.wrap');
      this._titleEl.textContent = c.title;
      this._canvas.style.height = c.height + 'px';
      this._wrap.style.height = c.height + 'px';
      this._built = true;
      if (this._ro) this._ro.disconnect();
      this._ro = new ResizeObserver(() => this._render());
      this._ro.observe(this._wrap);
    }

    _updateHeader() {
      if (!this._statesEl || !this._hass) return;
      this._statesEl.innerHTML = this._config.phases.map((p) => {
        const st = this._hass.states[p.entity];
        const v = st ? Number(st.state) : NaN;
        const ok = isFinite(v);
        const col = ok ? (v < 0 ? p.negColor : p.color) : 'var(--secondary-text-color)';
        const txt = ok ? fmtW(v) + ' W' : '—';
        return '<span class="st"><span class="dot" style="background:' + p.color + '"></span>' +
          p.name + ' <b style="color:' + col + '">' + txt + '</b></span>';
      }).join('');
    }

    _ensureEnergy() {
      if (!this._config.followEnergy || this._energyUnsub) return;
      const coll = this._hass && this._hass.connection && this._hass.connection._energy;
      if (!coll) {
        if (this._energyTries < 30) {
          this._energyTries++;
          clearTimeout(this._energyTimer);
          this._energyTimer = setTimeout(() => this._ensureEnergy(), 500);
        }
        return;
      }
      const apply = (d) => {
        if (d && d.start) {
          this._energyStart = d.start;
          this._energyEnd = d.end || null;
          this._lastFetch = 0;
          this._maybeFetch(true);
        }
      };
      try {
        this._energyUnsub = coll.subscribe(apply);
        if (coll.state) apply(coll.state);
      } catch (e) {
        console.error('[phase-mains-card] energy subscribe failed', e);
      }
    }

    _resolveWindow() {
      if (this._energyStart) {
        const start = this._energyStart.getTime ? this._energyStart.getTime() : +this._energyStart;
        let end = this._energyEnd ? (this._energyEnd.getTime ? this._energyEnd.getTime() : +this._energyEnd) : start + DAY;
        if (!(end > start)) end = start + DAY;
        return { start, end };
      }
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
      return { start, end: start + this._config.hours * HOUR };
    }

    async _maybeFetch(force) {
      if (!this._hass || this._fetching) return;
      const now = Date.now();
      if (!force && this._data && now - this._lastFetch < 30000) return;
      this._fetching = true;
      try {
        const { start, end } = this._resolveWindow();
        const dataEnd = Math.min(now, end);
        const rangeMs = end - start;
        const ids = this._config.phases.map((p) => p.entity);
        const parsed = {};
        let mode;
        if (rangeMs <= 36 * HOUR) {
          mode = 'history';
          const res = await this._hass.callWS({
            type: 'history/history_during_period',
            start_time: new Date(start).toISOString(),
            end_time: new Date(dataEnd).toISOString(),
            entity_ids: ids, minimal_response: true, no_attributes: true,
          });
          for (const id of ids) {
            const arr = res && res[id] ? res[id] : [];
            parsed[id] = arr.map((pt) => ({ t: ptTime(pt), v: ptVal(pt) })).filter((p) => p.t != null && isFinite(p.v));
          }
        } else {
          mode = 'stats';
          const period = rangeMs <= 70 * DAY ? 'hour' : 'day';
          const res = await this._hass.callWS({
            type: 'recorder/statistics_during_period',
            start_time: new Date(start).toISOString(),
            end_time: new Date(dataEnd).toISOString(),
            statistic_ids: ids, period, types: ['mean'],
          });
          for (const id of ids) {
            const arr = res && res[id] ? res[id] : [];
            parsed[id] = arr.map((s) => ({ t: (typeof s.start === 'number' ? s.start : Date.parse(s.start)), v: Number(s.mean) }))
              .filter((p) => p.t != null && isFinite(p.v));
          }
        }
        this._data = parsed;
        this._mode = mode;
        this._winStart = start;
        this._winEnd = end;
        this._lastFetch = now;
        this._render();
      } catch (e) {
        if (this._emptyEl) { this._emptyEl.textContent = 'Data unavailable'; this._emptyEl.style.display = 'flex'; }
        console.error('[phase-mains-card] fetch error', e);
      } finally {
        this._fetching = false;
      }
    }

    _bucketize(points, startMs, endMs, bucketMs) {
      const n = Math.max(1, Math.ceil((endMs - startMs) / bucketMs));
      const sums = new Array(n).fill(0);
      const cnts = new Array(n).fill(0);
      let last = null;
      for (const p of points) {
        if (p.t < startMs) { last = p.v; continue; }
        const idx = Math.floor((p.t - startMs) / bucketMs);
        if (idx < 0 || idx >= n) continue;
        sums[idx] += p.v; cnts[idx] += 1;
      }
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const t = startMs + i * bucketMs + bucketMs / 2;
        if (cnts[i] > 0) { last = sums[i] / cnts[i]; out[i] = { t, v: last }; }
        else if (last != null) { out[i] = { t, v: last }; }
        else { out[i] = { t, v: null }; }
      }
      return out;
    }

    _render() {
      if (!this._built || !this._canvas || !this._data || !this._winEnd) return;
      const cfg = this._config;
      const W = this._wrap.clientWidth;
      const H = cfg.height;
      if (!W) return;

      const cs = getComputedStyle(this._canvas);
      const txtCol = (cs.getPropertyValue('--secondary-text-color') || '#8a8a8a').trim() || '#8a8a8a';
      const gridCol = (cs.getPropertyValue('--divider-color') || 'rgba(255,255,255,0.08)').trim() || 'rgba(255,255,255,0.08)';

      const dpr = window.devicePixelRatio || 1;
      const cv = this._canvas;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const padL = 14, padR = 50, padT = 8, padB = 22;
      const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
      const axisStart = this._winStart;
      const axisEnd = this._winEnd;
      const dataEnd = Math.min(Date.now(), axisEnd);
      const bucketMs = cfg.bucket * 60 * 1000;

      const series = cfg.phases.map((p) => ({
        p,
        pts: this._mode === 'stats'
          ? (this._data[p.entity] || [])
          : this._bucketize(this._data[p.entity] || [], axisStart, dataEnd, bucketMs),
      }));

      let maxAbs = 0;
      for (const s of series) for (const pt of s.pts) if (pt.v != null) maxAbs = Math.max(maxAbs, Math.abs(pt.v));
      const yMax = niceCeil(maxAbs || 100);
      const yMin = -yMax;

      const X = (t) => x0 + ((t - axisStart) / (axisEnd - axisStart)) * (x1 - x0);
      const Y = (v) => y1 - ((v - yMin) / (yMax - yMin)) * (y1 - y0);
      const yBase = Y(0);

      ctx.font = '11px system-ui, -apple-system, Roboto, sans-serif';

      const step = niceStep(yMax / 2.2);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (let v = 0; v <= yMax + 1; v += step) {
        for (const sv of (v === 0 ? [0] : [v, -v])) {
          const yy = Y(sv);
          ctx.strokeStyle = gridCol;
          ctx.lineWidth = 1;
          ctx.globalAlpha = sv === 0 ? 0 : 1;
          ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = txtCol;
          ctx.fillText(fmtW(sv), x1 + 6, yy);
        }
      }

      ctx.strokeStyle = txtCol;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, yBase); ctx.lineTo(x1, yBase); ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'center';
      ctx.fillStyle = txtCol;
      for (const lab of pickXLabels(axisStart, axisEnd, cfg.labelHours)) {
        if (lab.t < axisStart || lab.t > axisEnd) continue;
        ctx.fillText(lab.txt, X(lab.t), H - 6);
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      for (const s of series) this._drawPhase(ctx, s.pts, X, Y, yBase, s.p.color, s.p.negColor);
      ctx.restore();

      let any = false;
      for (const s of series) for (const pt of s.pts) if (pt.v != null) { any = true; break; }
      this._emptyEl.style.display = any ? 'none' : 'flex';
      if (!any) this._emptyEl.textContent = 'No data';
    }

    _drawPhase(ctx, pts, X, Y, yBase, posColor, negColor) {
      const groups = [];
      let cur = [];
      for (const p of pts) {
        if (p.v == null) { if (cur.length) { groups.push(cur); cur = []; } }
        else cur.push(p);
      }
      if (cur.length) groups.push(cur);

      for (const seg of groups) {
        if (seg.length === 0) continue;
        const runs = [];
        let run = { sign: seg[0].v >= 0 ? 1 : -1, pts: [{ t: seg[0].t, v: seg[0].v }] };
        for (let i = 1; i < seg.length; i++) {
          const prev = seg[i - 1], a = seg[i];
          const sp = prev.v >= 0 ? 1 : -1, sc = a.v >= 0 ? 1 : -1;
          if (sc === sp) {
            run.pts.push({ t: a.t, v: a.v });
          } else {
            const frac = prev.v / (prev.v - a.v);
            const zt = prev.t + (a.t - prev.t) * frac;
            run.pts.push({ t: zt, v: 0 });
            runs.push(run);
            run = { sign: sc, pts: [{ t: zt, v: 0 }, { t: a.t, v: a.v }] };
          }
        }
        runs.push(run);

        for (const r of runs) {
          if (r.pts.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(X(r.pts[0].t), yBase);
          for (const q of r.pts) ctx.lineTo(X(q.t), Y(q.v));
          ctx.lineTo(X(r.pts[r.pts.length - 1].t), yBase);
          ctx.closePath();
          ctx.fillStyle = hexA(r.sign >= 0 ? posColor : negColor, 0.16);
          ctx.fill();
        }
        ctx.lineWidth = 1.8;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const r of runs) {
          if (r.pts.length < 2) continue;
          ctx.beginPath();
          r.pts.forEach((q, i) => (i ? ctx.lineTo(X(q.t), Y(q.v)) : ctx.moveTo(X(q.t), Y(q.v))));
          ctx.strokeStyle = r.sign >= 0 ? posColor : negColor;
          ctx.stroke();
        }
      }
    }

    connectedCallback() {
      this._energyTries = 0;
      if (this._hass) this._ensureEnergy();
      if (this._wrap) {
        if (this._ro) this._ro.disconnect();
        this._ro = new ResizeObserver(() => this._render());
        this._ro.observe(this._wrap);
        this._render();
      }
    }

    disconnectedCallback() {
      if (this._energyUnsub) { try { this._energyUnsub(); } catch (e) { /* noop */ } this._energyUnsub = null; }
      clearTimeout(this._energyTimer);
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
    }
  }

  if (!customElements.get(TAG)) {
    customElements.define(TAG, PhaseMainsCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
      type: TAG,
      name: 'Phase Mains Card',
      description: 'Per-phase power; green below zero; follows the energy date picker.',
    });
    console.info('%c PHASE-MAINS-CARD %c v5 energy-linked ', 'background:#e040fb;color:#fff', 'background:#00e676;color:#000');
  }
})();


;/* ===================== self-sufficient-card.js ===================== */
/*
 * self-sufficient-card  (v1)
 * Consumption + Production overlaid (HomeWizard "Self-sufficient"):
 *   at each instant  self-sufficient = min(consumption, production)   -> CYAN  (overlap)
 *                    grid            = consumption above production    -> MAGENTA
 *                    surplus         = production above consumption    -> GREEN
 *   Now/Day = layered areas (green production, magenta consumption, cyan overlap on top).
 *   Week/Month/Year = stacked self-sufficient/grid/surplus energy bars from selfsuff_daily.json
 *   (the overlap isn't a long-term statistic, so the archiver stores a daily total).
 * Data: home_consumption_power + total_solar_power (both archived).
 */
(function () {
  const TAG = "self-sufficient-card";
  const SS = "#00c8e0", GRID = "#e040fb", SURP = "#00e676";   // cyan self-sufficient / magenta grid / green surplus
  const SS_LINE = "#00b0ff";   // self-sufficient outline colour = Home mains "Phase 3" blue
  const WINDOW = 60000, EASE = 0.14;

  const ptTime = (p) => { let t = p.lu != null ? p.lu : (p.lc != null ? p.lc : (p.last_updated != null ? p.last_updated : p.last_changed)); if (t == null) return null; if (typeof t === "string") return Date.parse(t); return t < 1e12 ? t * 1000 : t; };
  const ptVal = (p) => parseFloat(p.s != null ? p.s : p.state);
  const num = (v) => { const f = parseFloat(v); return isFinite(f) ? f : null; };
  const niceStep = (v) => { if (v <= 0) return 1; const e = Math.floor(Math.log10(v)), b = Math.pow(10, e), f = v / b; const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; return nf * b; };
  const fmtW = (v) => Math.round(v).toLocaleString();
  const fmtPower = (w) => Math.abs(w) >= 1000 ? (w / 1000).toFixed(2) + " kW" : Math.round(w).toLocaleString() + " W";
  const fmtNum = (v) => v >= 10 ? Math.round(v).toString() : (v >= 1 ? (Math.round(v * 10) / 10).toString() : (Math.round(v * 100) / 100).toString());
  const mondayMs = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const isoWeek = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const w1 = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7); };
  function hexA(hex, a) { let h = (hex || "").trim().replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16); if (isNaN(n)) return "rgba(0,200,224," + a + ")"; return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; }
  const isoDate = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

  class SelfSufficientCard extends HTMLElement {
    constructor() {
      super(); this.attachShadow({ mode: "open" });
      this._period = "Day"; this._data = null; this._live = {}; this._dispMax = null;
      this._archive = null; this._archiveDate = null; this._archiveCache = {}; this._summary = null;
      this._lastFetch = 0; this._fetching = false; this._built = false;
      this._raf = null; this._sampleTimer = null; this._ro = null;
    }
    setConfig(config) {
      this._cfg = {
        title: config.title || "Self-sufficient",
        cons_entity: config.cons_entity || "sensor.home_consumption_power",
        grid_entity: config.grid_entity || "sensor.p1_meter_power",        // signed: + import / - export
        cons_today: config.cons_today || "sensor.home_consumption_today",
        import_today: config.import_today || "sensor.grid_import_daily",
        export_today: config.export_today || "sensor.grid_export_daily",
        period_entity: config.period_entity || "input_select.energy_period",
        date_entity: config.date_entity || "input_datetime.energy_date",
        archive_base: config.archive_base || "/local/energy-archive",
        summary_url: config.summary_url || "/local/energy-archive/selfsuff_daily.json",
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
      if (this._period === "Week") this._loadBars("week");
      else if (this._period === "Month") this._loadBars("month");
      else if (this._period === "Year") this._loadBars("year");
      else if (this._period !== "Now") this._loadDay();
    }

    _setPeriod(per) {
      this._period = per; this._dispMax = null;
      if (per === "Now") this._startLive();
      else if (per === "Week") { this._stopLive(); this._loadBars("week"); }
      else if (per === "Month") { this._stopLive(); this._loadBars("month"); }
      else if (per === "Year") { this._stopLive(); this._loadBars("year"); }
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
          .readings{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;}
          .rd{display:flex;align-items:baseline;gap:6px;}
          .rlabel{font-size:13px;color:#fff;}
          .num{font-size:38px;font-weight:700;letter-spacing:-.02em;line-height:1;}
          .snum{font-size:22px;font-weight:700;letter-spacing:-.01em;line-height:1;}
          .unit{font-size:13px;color:#cbc4d2;}
          #ssPctRd{gap:5px;}
          .sicon{width:24px;height:24px;flex:0 0 auto;align-self:center;}
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
            <div class="rd"><span class="rlabel">Self-sufficient</span><span class="num" id="rSs" style="color:${SS}">–</span><span class="unit">kWh</span></div>
            <div class="rd"><span class="rlabel">Grid</span><span class="num" id="rGrid" style="color:${GRID}">–</span><span class="unit">kWh</span></div>
            <div class="rd"><span class="rlabel">Surplus</span><span class="num" id="rSurp" style="color:${SURP}">–</span><span class="unit">kWh</span></div>
            <div class="rd" id="ssPctRd"><svg class="sicon" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.2" stroke="${SS}" stroke-width="1.5"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7" stroke="${SS}" stroke-width="1.5" stroke-linecap="round"/></svg><span class="snum" id="rPct" style="color:${SS}">–</span><span class="unit" style="color:${SS}">%</span></div>
          </div>
          <div class="wrap"><canvas></canvas><div class="empty">Loading…</div></div>
        </div>`;
      this._el = { rSs: this.shadowRoot.getElementById("rSs"), rPct: this.shadowRoot.getElementById("rPct"), rGrid: this.shadowRoot.getElementById("rGrid"), rSurp: this.shadowRoot.getElementById("rSurp"), live: this.shadowRoot.getElementById("live") };
      this._canvas = this.shadowRoot.querySelector("canvas"); this._empty = this.shadowRoot.querySelector(".empty"); this._wrap = this.shadowRoot.querySelector(".wrap");
      this._canvas.style.height = c.height + "px"; this._wrap.style.height = c.height + "px";
      this._built = true;
      if (this._ro) this._ro.disconnect();
      this._ro = new ResizeObserver(() => this._animate()); this._ro.observe(this._wrap);
    }

    _liveEntities() { return [this._cfg.cons_entity, this._cfg.grid_entity]; }

    _updateHeader() {
      if (!this._hass || !this._el) return;
      this._el.live.style.display = this._period === "Now" ? "inline-flex" : "none";
      const barMode = this._period === "Week" || this._period === "Month" || this._period === "Year";
      const isToday = this._isToday();
      let ss = null, grid = null, surp = null;
      if (barMode) { const b = this._bars; if (b) { ss = b.ssTotal; grid = b.gridTotal; surp = b.surpTotal; } }
      else if (this._period === "Now" || isToday) {
        const co = this._hass.states[this._cfg.cons_today], gi = this._hass.states[this._cfg.import_today], ge = this._hass.states[this._cfg.export_today];
        grid = gi ? num(gi.state) : null; surp = ge ? num(ge.state) : null;
        const cons = co ? num(co.state) : null; ss = (cons != null && grid != null) ? Math.max(0, cons - grid) : null;   // self-sufficient = consumption - grid import
      }
      else if (this._archive && this._archiveDate === this._selDate) { ss = num(this._archive.self_sufficient_kwh); grid = num(this._archive.ss_grid_kwh); surp = num(this._archive.ss_surplus_kwh); }
      this._el.rSs.textContent = ss != null ? ss.toFixed(1) : "—";
      this._el.rGrid.textContent = grid != null ? grid.toFixed(1) : "—";
      this._el.rSurp.textContent = surp != null ? surp.toFixed(1) : "—";
      const cons = (ss != null && grid != null) ? ss + grid : null;   // consumption = self-sufficient + grid import
      const pct = (cons != null && cons > 0) ? Math.round(ss / cons * 100) : null;
      this._el.rPct.textContent = pct != null ? pct : "–";             // self-sufficient % (unit "%" rendered by the .unit span)
    }
    _overlayTotals(sd) {
      if (!sd || !sd.lo || !sd.lo.length) return { ss: null, grid: null, surp: null };
      const h = this._cfg.bucket / 60;
      let ss = 0, g = 0, s = 0;
      for (let i = 0; i < sd.lo.length; i++) { const c = sd.cons[i] && sd.cons[i].v, p = sd.prod[i] && sd.prod[i].v; if (c == null || p == null) continue; const m = Math.min(c, p); ss += m; g += Math.max(0, c - m); s += Math.max(0, p - m); }
      return { ss: ss * h / 1000, grid: g * h / 1000, surp: s * h / 1000 };
    }
    _todayOverlay() {   // today's bucketed consumption/production (Now + today-Day header totals come from real history, not the 60s live buffer)
      const cE = this._cfg.cons_entity, pE = this._cfg.prod_entity;
      const aStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime(), dEnd = Date.now(), bms = this._cfg.bucket * 60000;
      const cons = this._bucketize(this._data && this._data[cE] ? this._data[cE] : [], aStart, dEnd, bms);
      const prod = this._bucketize(this._data && this._data[pE] ? this._data[pE] : [], aStart, dEnd, bms);
      const n = Math.min(cons.length, prod.length), lo = [];
      for (let i = 0; i < n; i++) { const cv = cons[i].v, pv = prod[i].v; lo.push({ t: cons[i].t, v: (cv != null && pv != null) ? Math.min(cv, pv) : null }); }
      return { cons, prod, lo };
    }

    // ---- live (Now) ----
    _startLive() { this._stopLive(); this._live = {}; this._seedLive(); this._maybeFetch(); this._sampleTimer = setInterval(() => this._sample(), 500); this._sample(); this._animate(); }
    _stopLive() { if (this._sampleTimer) { clearInterval(this._sampleTimer); this._sampleTimer = null; } }
    async _seedLive() {
      try {
        const ids = this._liveEntities(); const now = Date.now(), start = now - WINDOW;
        const res = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(now - WINDOW - 8000).toISOString(), end_time: new Date(now).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true });
        ids.forEach((id) => { const raw = (res && res[id] ? res[id] : []).map((p) => ({ t: ptTime(p), v: ptVal(p) })).filter((p) => p.t != null && isFinite(p.v)); this._live[id] = this._resample(raw, start, now, 500); });
        this._animate();
      } catch (e) { }
    }
    _resample(raw, s, e, step) { const out = []; let i = 0, last = null; while (i < raw.length && raw[i].t <= s) { last = raw[i].v; i++; } for (let t = s; t <= e; t += step) { while (i < raw.length && raw[i].t <= t) { last = raw[i].v; i++; } if (last != null) out.push({ t, v: last }); } return out; }
    _sample() {
      if (!this._hass) return; const now = Date.now(), cutoff = now - WINDOW - 2000;
      this._liveEntities().forEach((id) => { const st = this._hass.states[id]; const v = st ? num(st.state) : null; if (!this._live[id]) this._live[id] = []; if (v != null) this._live[id].push({ t: now, v }); const a = this._live[id]; let i = 0; while (i < a.length && a[i].t < cutoff) i++; if (i) a.splice(0, i); });
      this._animate();
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
      this._dispMax = null; this._updateHeader(); this._animate();
    }
    async _fetchInto(ids) {
      if (!ids || !ids.length) return;
      const dayStart = this._dayStart(), dayEnd = Math.min(Date.now(), dayStart + this._cfg.hours * 3600000);
      const res = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(dayStart).toISOString(), end_time: new Date(dayEnd).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true });
      if (!this._data) this._data = {};
      ids.forEach((id) => { this._data[id] = (res && res[id] ? res[id] : []).map((p) => ({ t: ptTime(p), v: ptVal(p) })).filter((p) => p.t != null && isFinite(p.v)); });
    }
    async _maybeFetch() {
      if (!this._hass || this._fetching) return;
      const now = Date.now(); if (this._data && this._dataDay === this._dayStart() && now - this._lastFetch < 30000) { this._animate(); this._updateHeader(); return; }
      this._fetching = true;
      try { this._data = {}; this._dataDay = this._dayStart(); await this._fetchInto(this._liveEntities()); this._lastFetch = Date.now(); this._updateHeader(); this._animate(); }
      catch (e) { if (this._empty) { this._empty.textContent = "History unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetching = false; }
    }

    // ---- week / month / year (stacked self-sufficient / grid / surplus bars from the daily summary) ----
    async _summaryData() {
      if (this._summary && Date.now() - (this._summaryFetch || 0) < 60000) return this._summary;
      try { const r = await fetch(this._cfg.summary_url, { cache: "no-cache" }); this._summary = r.ok ? await r.json() : {}; }
      catch (e) { this._summary = this._summary || {}; }
      this._summaryFetch = Date.now(); return this._summary;
    }
    async _loadBars(kind) {
      if (this._fetchingBars) return; this._fetchingBars = true;
      try {
        const sum = await this._summaryData(); const slots = [];
        const get = (d) => sum[isoDate(d)] || null;
        const refMs = this._dayStart();
        if (kind === "week") {
          const mon = mondayMs(refMs); const names = ["mo", "tu", "we", "th", "fr", "sa", "su"];
          for (let i = 0; i < 7; i++) { const v = get(mon + i * 86400000); slots.push({ label: names[i], ss: v ? v[0] : null, grid: v ? v[1] : null, surp: v ? v[2] : null }); }
        } else if (kind === "month") {
          // weeks, not days: one bar-group per ISO week, summing the daily summary for that week's days within the month (matches the battery card)
          const dd = new Date(refMs), firstMs = new Date(dd.getFullYear(), dd.getMonth(), 1).getTime(), nextMs = new Date(dd.getFullYear(), dd.getMonth() + 1, 1).getTime();
          for (let wk = mondayMs(firstMs); wk < nextMs; wk += 7 * 86400000) {
            let ss = null, grid = null, surp = null;
            for (let k = 0; k < 7; k++) { const d = wk + k * 86400000; if (d < firstMs || d >= nextMs) continue; const v = get(d); if (v) { ss = (ss || 0) + v[0]; grid = (grid || 0) + v[1]; surp = (surp || 0) + v[2]; } }
            slots.push({ label: String(isoWeek(wk)), ss, grid, surp });
          }
        } else {
          const dd = new Date(refMs), y = dd.getFullYear(), M = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"], agg = Array.from({ length: 12 }, () => ({ ss: 0, grid: 0, surp: 0, any: false }));
          for (const k in sum) { const p = k.split("-"); if (+p[0] === y) { const m = +p[1] - 1, v = sum[k]; agg[m].ss += v[0]; agg[m].grid += v[1]; agg[m].surp += v[2]; agg[m].any = true; } }
          for (let i = 0; i < 12; i++) slots.push({ label: M[i], ss: agg[i].any ? agg[i].ss : null, grid: agg[i].any ? agg[i].grid : null, surp: agg[i].any ? agg[i].surp : null });
        }
        let st = 0, gt = 0, pt = 0; slots.forEach((s) => { if (s.ss > 0) st += s.ss; if (s.grid > 0) gt += s.grid; if (s.surp > 0) pt += s.surp; });
        this._bars = { kind, slots, ssTotal: st, gridTotal: gt, surpTotal: pt };
        this._updateHeader(); this._animate();
      } finally { this._fetchingBars = false; }
    }
    _roundBar(ctx, x, y, w, h, r) { r = Math.max(0, Math.min(r, w / 2, h)); ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h); ctx.closePath(); }
    _renderBars() {
      const c = this._cfg, W = this._wrap.clientWidth, H = c.height; if (!W) return;
      const slots = (this._bars && this._bars.slots) || [{ label: "", ss: null, grid: null, surp: null }];
      const dpr = window.devicePixelRatio || 1, cv = this._canvas; const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      let mx = 0; for (const s of slots) for (const v of [s.ss, s.grid, s.surp]) { if (v > mx) mx = v; }   // GROUPED: axis = largest single bar (not the stacked total)
      const step = niceStep(mx / 5) || 1, top = Math.max(step, Math.ceil(mx / (step / 2)) * (step / 2));
      const padL = 40, padR = 12, padT = 22, padB = 22;
      const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB; const Y = (v) => y1 - (v / top) * (y1 - y0);
      ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
      for (let v = 0; v <= top + 1e-6; v += step) { const yy = Y(v); ctx.strokeStyle = v === 0 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.06)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke(); ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "right"; ctx.fillText(fmtNum(v), x0 - 6, yy); }
      const n = slots.length, slotW = (x1 - x0) / n;
      const groupW = Math.min(slotW * 0.7, 66), sub = groupW / 3, barW = Math.max(3, sub * 0.82);   // 3 bars side by side per slot
      const showVals = sub >= 15;                       // per-bar value labels only when each lane is wide enough (Week/Year; not dense Month)
      for (let i = 0; i < n; i++) {
        const cx = x0 + slotW * (i + 0.5), gx0 = cx - groupW / 2;
        const segs = [{ v: slots[i].ss, col: SS }, { v: slots[i].grid, col: GRID }, { v: slots[i].surp, col: SURP }];
        for (let k = 0; k < 3; k++) {
          const sv = segs[k].v; if (!(sv > 0)) continue;
          const bx = gx0 + sub * k + (sub - barW) / 2, ny = Y(sv);
          ctx.save(); this._roundBar(ctx, bx, ny, barW, y1 - ny, Math.min(4, barW / 2)); ctx.clip();
          const g = ctx.createLinearGradient(0, ny, 0, y1); g.addColorStop(0, segs[k].col); g.addColorStop(1, hexA(segs[k].col, 0.6)); ctx.fillStyle = g; ctx.fillRect(bx, ny, barW, y1 - ny);
          ctx.restore();
          if (showVals) { ctx.fillStyle = "#e6e0e9"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(fmtNum(sv), bx + barW / 2, ny - 5); ctx.textBaseline = "middle"; }
        }
        if (slots[i].label) { ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(slots[i].label, cx, H - 6); ctx.textBaseline = "middle"; }
      }
      const any = slots.some((s) => s.ss > 0 || s.grid > 0 || s.surp > 0);
      this._empty.style.display = any ? "none" : "flex"; if (!any) this._empty.textContent = "No data yet";
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
      const cE = this._cfg.cons_entity, gE = this._cfg.grid_entity;
      let cons, grid;
      if (this._period === "Now") {
        const mk = (id) => { const buf = (this._live[id] || []).slice(); const st = this._hass && this._hass.states[id]; const lv = st ? num(st.state) : (buf.length ? buf[buf.length - 1].v : null); if (lv != null) buf.push({ t: Date.now(), v: lv }); return buf; };
        cons = mk(cE); grid = mk(gE);
      } else if (this._archive && this._archiveDate === this._selDate && this._archive.series) {
        cons = this._reBucketArchive(cE); grid = this._reBucketArchive(gE);
      } else {
        const aStart = this._dayStart(), aEnd = aStart + this._cfg.hours * 3600000, dEnd = Math.min(Date.now(), aEnd), bms = this._cfg.bucket * 60000;
        cons = this._bucketize(this._data && this._data[cE] ? this._data[cE] : [], aStart, dEnd, bms);
        grid = this._bucketize(this._data && this._data[gE] ? this._data[gE] : [], aStart, dEnd, bms);
      }
      const n = Math.min(cons.length, grid.length), ss = [], pTop = [], gTop = [];   // blue base, grid-import top (ss+gi), surplus-export top (ss+ge)
      for (let i = 0; i < n; i++) {
        const t = cons[i].t, cv = cons[i].v, p1 = grid[i].v;
        if (cv == null || p1 == null) { ss.push({ t, v: null }); pTop.push({ t, v: null }); gTop.push({ t, v: null }); continue; }
        const c = Math.max(0, cv), gi = Math.max(0, p1), ge = Math.max(0, -p1), s = Math.max(0, c - gi);
        ss.push({ t, v: s }); pTop.push({ t, v: s + gi }); gTop.push({ t, v: s + ge });
      }
      return { ss, pTop, gTop };
    }

    _animate() { if (!this._raf) this._raf = requestAnimationFrame(() => this._frame()); }
    _frame() {
      this._raf = null; if (!this._built || !this._wrap.clientWidth) return;
      if (this._period === "Week" || this._period === "Month" || this._period === "Year") { this._renderBars(); return; }
      const sd = this._buildSeries();
      let mx = 0; for (const arr of [sd.pTop, sd.gTop]) for (const p of arr) if (p.v != null && p.v > mx) mx = p.v;
      let tM = mx > 0 ? mx * 1.12 : 100; if (tM < 100) tM = 100;
      if (this._dispMax == null) this._dispMax = tM; else this._dispMax += (tM - this._dispMax) * EASE;
      this._render(sd);
      const easing = Math.abs(tM - this._dispMax) > 0.5;
      if (this._period === "Now" || easing) this._raf = requestAnimationFrame(() => this._frame());
    }
    _render(sd) {
      const c = this._cfg, W = this._wrap.clientWidth, H = c.height; if (!W || this._dispMax == null) return;
      const dpr = window.devicePixelRatio || 1, cv = this._canvas; const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const isNow = this._period === "Now";
      const padL = 46, padR = 14, padT = 12, padB = isNow ? 12 : 22;
      const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
      let axisStart, axisEnd;
      if (isNow) { axisEnd = Date.now(); axisStart = axisEnd - WINDOW; } else { axisStart = this._dayStart(); axisEnd = axisStart + c.hours * 3600000; }
      const M = this._dispMax;
      const X = (t) => x0 + ((t - axisStart) / (axisEnd - axisStart)) * (x1 - x0);
      const Y = (v) => y1 - (Math.max(0, v) / M) * (y1 - y0);
      ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
      const step = niceStep(M / 4) || 1;
      for (let v = 0; v <= M + 1e-6; v += step) { const yy = Y(v); if (yy < y0 - 1) continue; ctx.strokeStyle = v === 0 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.06)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke(); ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "right"; ctx.fillText(fmtW(v), x0 - 6, yy); }
      if (!isNow) { ctx.textBaseline = "alphabetic"; ctx.textAlign = "center"; ctx.fillStyle = "#8a8a8e"; for (const h of [2, 7, 12, 17, 22]) { const t = axisStart + h * 3600000, xx = X(t); if (xx < x0 || xx > x1) continue; ctx.fillText(String(h).padStart(2, "0") + ":00", xx, H - 6); } ctx.textBaseline = "middle"; }
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      // Self-sufficient = the OVERLAP = area under BOTH curves = 0 -> min(consumption, production) = sd.ss.
      this._drawArea(ctx, sd.ss, X, Y, y1, SS, 0.85, false);     // cyan fill only (top edge is the lower of the two lines)
      // Wedges between the two curves: where consumption(pTop) > production(gTop) you're importing (magenta);
      // where production(gTop) > consumption(pTop) you're exporting (green). They alternate, so each is fill-only.
      this._drawBand(ctx, sd.ss, sd.pTop, X, Y, GRID, y0, y1);    // grid-import wedge — soft translucent fill
      this._drawBand(ctx, sd.ss, sd.gTop, X, Y, SURP, y0, y1);    // surplus wedge — soft translucent fill
      // Magenta/green wedges stay outline-free; the self-sufficient (blue) area gets a solid outline in the
      // Home mains "Phase 3" blue. (_upperLines stays parked so v7's full coloured lines can be restored.)
      this._drawLine(ctx, sd.ss, X, Y, SS_LINE, 2);              // blue outline of the self-sufficient area (Phase 3 blue)
      ctx.restore();
      let any = false; for (const p of sd.pTop) if (p.v != null) { any = true; break; }
      this._empty.style.display = any ? "none" : "flex"; if (!any) this._empty.textContent = isNow ? "Waiting for live data…" : "No data";
    }
    _trace(ctx, seg, X, Y) {
      const n = seg.length; if (n < 3) { for (let i = 1; i < n; i++) ctx.lineTo(X(seg[i].t), Y(seg[i].v)); return; }
      for (let i = 1; i < n - 2; i++) { const xc = (X(seg[i].t) + X(seg[i + 1].t)) / 2, yc = (Y(seg[i].v) + Y(seg[i + 1].v)) / 2; ctx.quadraticCurveTo(X(seg[i].t), Y(seg[i].v), xc, yc); }
      ctx.quadraticCurveTo(X(seg[n - 2].t), Y(seg[n - 2].v), X(seg[n - 1].t), Y(seg[n - 1].v));
    }
    _drawArea(ctx, pts, X, Y, yBase, color, aTop, stroke = true) {
      const groups = []; let cur = []; for (const p of pts) { if (p.v == null) { if (cur.length) { groups.push(cur); cur = []; } } else cur.push(p); } if (cur.length) groups.push(cur);
      for (const seg of groups) {
        if (seg.length < 1) continue;
        ctx.beginPath(); ctx.moveTo(X(seg[0].t), yBase); ctx.lineTo(X(seg[0].t), Y(seg[0].v)); this._trace(ctx, seg, X, Y); ctx.lineTo(X(seg[seg.length - 1].t), yBase); ctx.closePath(); ctx.fillStyle = hexA(color, aTop); ctx.fill();
        if (stroke) { ctx.beginPath(); ctx.moveTo(X(seg[0].t), Y(seg[0].v)); this._trace(ctx, seg, X, Y); ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = color; ctx.stroke(); }
      }
    }
    _drawBand(ctx, lower, upper, X, Y, color, y0, yBase) {   // translucent wedge between two curves (fill only; the continuous line carries the edge)
      const g = ctx.createLinearGradient(0, y0, 0, yBase); g.addColorStop(0, hexA(color, 0.92)); g.addColorStop(1, hexA(color, 0.11));
      const groups = []; let cur = [];
      for (let i = 0; i < lower.length && i < upper.length; i++) { const lo = lower[i], up = upper[i]; if (!lo || !up || lo.v == null || up.v == null || up.v <= lo.v + 0.5) { if (cur.length) { groups.push(cur); cur = []; } } else cur.push({ t: lo.t, l: lo.v, u: up.v }); }
      if (cur.length) groups.push(cur);
      for (const seg of groups) {
        if (seg.length < 2) continue;
        const upPts = seg.map((p) => ({ t: p.t, v: p.u })), loRev = seg.map((p) => ({ t: p.t, v: p.l })).reverse();
        ctx.beginPath(); ctx.moveTo(X(upPts[0].t), Y(upPts[0].v)); this._trace(ctx, upPts, X, Y); ctx.lineTo(X(loRev[0].t), Y(loRev[0].v)); this._trace(ctx, loRev, X, Y); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      }
    }
    _drawLine(ctx, pts, X, Y, color, width) {   // ONE continuous smoothed line across the whole day (breaks only on real data gaps)
      const groups = []; let cur = []; for (const p of pts) { if (!p || p.v == null) { if (cur.length) { groups.push(cur); cur = []; } } else cur.push(p); } if (cur.length) groups.push(cur);
      ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = color;
      for (const seg of groups) { if (seg.length < 1) continue; ctx.beginPath(); ctx.moveTo(X(seg[0].t), Y(seg[0].v)); this._trace(ctx, seg, X, Y); ctx.stroke(); }
    }
    _upperLines(sd) {   // split the two curves into their UPPER-envelope portions: magenta where consumption>production, green where production>consumption
      const p = sd.pTop, g = sd.gTop, n = Math.min(p.length, g.length), mag = new Array(n), grn = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = p[i], b = g[i], t = a ? a.t : (b ? b.t : 0);
        mag[i] = { t, v: null }; grn[i] = { t, v: null };
        if (!a || !b || a.v == null || b.v == null) continue;
        if (a.v > b.v) mag[i].v = a.v;          // consumption is the upper curve -> magenta
        else if (b.v > a.v) grn[i].v = b.v;     // production is the upper curve -> green
      }
      // extend each coloured run by one bucket so the line dips to the blue (min) line exactly at the crossing
      const ext = (arr, src) => { const o = arr.map((q) => ({ t: q.t, v: q.v })); for (let i = 0; i < n; i++) { if (arr[i].v == null && src[i] && src[i].v != null && ((i > 0 && arr[i - 1].v != null) || (i < n - 1 && arr[i + 1].v != null))) o[i].v = src[i].v; } return o; };
      return { mag: ext(mag, p), grn: ext(grn, g) };
    }

    disconnectedCallback() { this._stopLive(); if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } if (this._ro) { this._ro.disconnect(); this._ro = null; } }
  }

  if (!customElements.get(TAG)) {
    customElements.define(TAG, SelfSufficientCard);
    window.customCards = window.customCards || [];
    window.customCards.push({ type: TAG, name: "Self-sufficient Card", description: "Consumption + production overlaid: overlap = self-sufficient (cyan), grid (magenta), surplus (green)." });
    console.info("%c SELF-SUFFICIENT-CARD %c v19 ", "background:#00c8e0;color:#003", "background:#222;color:#00c8e0");
  }
})();


;/* ===================== battery-card.js ===================== */
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


;/* ===================== production-card.js ===================== */
/*
 * production-card  (v1)
 * "Total production" - all solar sources consolidated into one green line/area.
 *  Green (#00e676) = same as Home mains "Surplus". Single series, 10-min intervals, smooth curve.
 *   Now  = live sensor.total_solar_power (Growatt gated + SMA), streaming + anchored to the right edge.
 *   Day  = that day's production curve (today/recent from history; older from the long-term archive).
 *   Week/Month/Year = production ENERGY bars from the solar cumulative-counter statistics.
 *  Same chrome/behaviour as usage-card (blue LIVE badge, shared Now/Day/Week/Month/Year selector).
 */
(function () {
  const TAG = "production-card";
  const COL = "#00e676";          // green = production (matches Home mains surplus)
  const WINDOW = 60000, EASE = 0.14;

  const ptTime = (p) => { let t = p.lu != null ? p.lu : (p.lc != null ? p.lc : (p.last_updated != null ? p.last_updated : p.last_changed)); if (t == null) return null; if (typeof t === "string") return Date.parse(t); return t < 1e12 ? t * 1000 : t; };
  const ptVal = (p) => parseFloat(p.s != null ? p.s : p.state);
  const num = (v) => { const f = parseFloat(v); return isFinite(f) ? f : null; };
  const niceStep = (v) => { if (v <= 0) return 1; const e = Math.floor(Math.log10(v)), b = Math.pow(10, e), f = v / b; const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; return nf * b; };
  const fmtPower = (w) => Math.abs(w) >= 1000 ? (w / 1000).toFixed(2) + " kW" : Math.round(w).toLocaleString() + " W";
  const fmtNum = (v) => v >= 10 ? Math.round(v).toString() : (v >= 1 ? (Math.round(v * 10) / 10).toString() : (Math.round(v * 100) / 100).toString());
  const mondayMs = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const isoWeek = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const w1 = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7); };
  function hexA(hex, a) { let h = (hex || "").trim().replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16); if (isNaN(n)) return "rgba(0,230,118," + a + ")"; return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; }

  // production energy = sum of the solar cumulative counters' change over the period
  const PROD = [
    { id: "sensor.growatt_lifetime_energy_output", s: 1 },   // Growatt solar production
    { id: "sensor.sma_total_yield", s: 1 },        // SMA solar production
  ];

  class ProductionCard extends HTMLElement {
    constructor() {
      super(); this.attachShadow({ mode: "open" });
      this._period = "Day"; this._data = null; this._live = {}; this._dispMax = null;
      this._lastFetch = 0; this._fetching = false; this._built = false;
      this._raf = null; this._sampleTimer = null; this._ro = null; this._archive = null; this._archiveDate = null; this._archiveCache = {};
    }
    setConfig(config) {
      this._cfg = {
        title: config.title || "Total production",
        power_entity: config.power_entity || "sensor.total_solar_power",      // live W (all solar)
        today_entity: config.today_entity || "sensor.total_production_today", // kWh today
        prod: (Array.isArray(config.prod) && config.prod.length) ? config.prod : PROD, // period-bar energy = sum of these cumulative counters' change
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
          .head-l{min-width:0;}
          .title{font-size:17px;font-weight:500;color:#cbc4d2;margin:0 0 6px;}
          .readings{display:flex;align-items:baseline;gap:6px;}
          .rlabel{font-size:13px;color:#fff;}
          .num{font-size:38px;font-weight:700;letter-spacing:-.02em;line-height:1;}
          .unit{font-size:13px;color:#cbc4d2;}
          .now{position:absolute;top:17px;right:56px;display:flex;flex-direction:column;gap:5px;align-items:flex-start;}
          .lg{display:flex;align-items:center;gap:8px;font-size:13px;color:#cbc4d2;white-space:nowrap;}
          .lg-name{display:flex;align-items:center;gap:6px;}
          .lg-val{width:84px;text-align:right;font-weight:700;}
          .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;}
          .live{display:none;align-items:center;gap:6px;font-size:12px;color:#0a84ff;margin-left:8px;}
          .live .d{width:8px;height:8px;border-radius:50%;background:#0a84ff;animation:bl 1s infinite;}
          @keyframes bl{50%{opacity:.25;}}
          .wrap{position:relative;width:100%;margin-top:12px;} canvas{display:block;width:100%;}
          .empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#cbc4d2;font-size:13px;}
        </style>
        <div class="card">
          <div class="head">
            <div class="head-l">
              <div class="title">${c.title}<span class="live" id="live"><span class="d"></span>LIVE</span></div>
              <div class="readings"><span class="rlabel">Production</span><span class="num" id="r1" style="color:${COL}">–</span><span class="unit">kWh</span></div>
            </div>
            <div class="now" id="now"></div>
          </div>
          <div class="wrap"><canvas></canvas><div class="empty">Loading…</div></div>
        </div>`;
      this._el = { r1: this.shadowRoot.getElementById("r1"), live: this.shadowRoot.getElementById("live"), now: this.shadowRoot.getElementById("now") };
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
      let iv = null;
      if (this._period === "Week") iv = this._week ? this._week.total : null;
      else if (this._period === "Month") iv = this._month ? this._month.total : null;
      else if (this._period === "Year") iv = this._year ? this._year.total : null;
      else if (this._period === "Now" || isToday) { const s = this._hass.states[this._cfg.today_entity]; iv = s ? num(s.state) : null; }
      else if (this._archive && this._archiveDate === this._selDate) iv = this._archiveTotal();
      this._el.r1.textContent = iv != null ? iv.toFixed(1) : "—";
      const showNow = this._period === "Now" || (this._period === "Day" && isToday);
      const s = showNow ? this._hass.states[this._cfg.power_entity] : null, v = s ? num(s.state) : null;
      if (showNow && v != null) {
        // Exactly like Home mains: an absolute legend box (top:18px) with two invisible
        // spacer rows that drop "Production" onto the 3rd row, which lines up with the big number.
        const sp = `<span class="lg" style="visibility:hidden"><span class="lg-name"><span class="dot"></span>Production</span><b class="lg-val">0 W</b></span>`;
        this._el.now.innerHTML = sp + sp + `<span class="lg"><span class="lg-name"><span class="dot" style="background:${COL}"></span>Production</span><b class="lg-val" style="color:${COL}">${fmtPower(Math.max(0, v))}</b></span>`;
      } else this._el.now.innerHTML = "";
    }
    _archiveTotal() {
      if (!this._archive || !this._archive.series) return null;
      const arr = this._archive.series[this._cfg.power_entity]; if (!arr) return null;
      const bm = this._archive.bucket_min || 5; let s = 0;
      for (const v of arr) if (v != null && v > 0) s += v;
      return s * (bm / 60) / 1000;
    }

    // ---- live (Now) ----
    _startLive() { this._stopLive(); this._live = {}; this._seedLive(); this._sampleTimer = setInterval(() => this._sample(), 500); this._sample(); this._animate(); }
    _stopLive() { if (this._sampleTimer) { clearInterval(this._sampleTimer); this._sampleTimer = null; } }
    async _seedLive() {
      try {
        const id = this._cfg.power_entity, now = Date.now(), start = now - WINDOW;
        const res = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(now - WINDOW - 8000).toISOString(), end_time: new Date(now).toISOString(), entity_ids: [id], minimal_response: true, no_attributes: true });
        const raw = (res && res[id] ? res[id] : []).map((p) => ({ t: ptTime(p), v: ptVal(p) })).filter((p) => p.t != null && isFinite(p.v));
        this._live[id] = this._resample(raw, start, now, 500);
        this._animate();
      } catch (e) { /* sampling fills it */ }
    }
    _resample(raw, s, e, step) { const out = []; let i = 0, last = null; while (i < raw.length && raw[i].t <= s) { last = raw[i].v; i++; } for (let t = s; t <= e; t += step) { while (i < raw.length && raw[i].t <= t) { last = raw[i].v; i++; } if (last != null) out.push({ t, v: Math.max(0, last) }); } return out; }
    _sample() {
      if (!this._hass) return; const id = this._cfg.power_entity, now = Date.now(), cutoff = now - WINDOW - 2000;
      const st = this._hass.states[id]; const v = st ? num(st.state) : null;
      if (!this._live[id]) this._live[id] = [];
      if (v != null) this._live[id].push({ t: now, v: Math.max(0, v) });
      const a = this._live[id]; let i = 0; while (i < a.length && a[i].t < cutoff) i++; if (i) a.splice(0, i);
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
        const id = this._cfg.power_entity, dayStart = this._dayStart(), dayEnd = Math.min(Date.now(), dayStart + this._cfg.hours * 3600000);
        const res = await this._hass.callWS({ type: "history/history_during_period", start_time: new Date(dayStart).toISOString(), end_time: new Date(dayEnd).toISOString(), entity_ids: [id], minimal_response: true, no_attributes: true });
        this._data = { [id]: (res && res[id] ? res[id] : []).map((p) => ({ t: ptTime(p), v: ptVal(p) })).filter((p) => p.t != null && isFinite(p.v)) };
        this._lastFetch = Date.now(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "History unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetching = false; }
    }
    _bucketize(points, s, e, b) {
      const n = Math.max(1, Math.ceil((e - s) / b)); const su = new Array(n).fill(0), cn = new Array(n).fill(0); let last = null;
      for (const p of points) { const val = Math.max(0, p.v); if (p.t < s) { last = val; continue; } const i = Math.floor((p.t - s) / b); if (i < 0 || i >= n) continue; su[i] += val; cn[i]++; }
      const out = new Array(n); for (let i = 0; i < n; i++) { const t = s + i * b + b / 2; if (cn[i] > 0) { last = su[i] / cn[i]; out[i] = { t, v: last }; } else out[i] = { t, v: last != null ? last : null }; } return out;
    }
    _buildSeries() {
      const id = this._cfg.power_entity;
      if (this._period === "Now") {
        const buf = (this._live[id] || []).slice();
        const st = this._hass && this._hass.states[id]; let lv = st ? num(st.state) : (buf.length ? buf[buf.length - 1].v : null); if (lv != null) lv = Math.max(0, lv);
        if (lv != null) buf.push({ t: Date.now(), v: lv });   // anchor to right edge -> smooth lead (no jerk)
        return [{ pts: buf }];
      }
      if (this._archive && this._archiveDate === this._selDate && this._archive.series) {
        const aStart = this._dayStart(), abms = (this._archive.bucket_min || 5) * 60000, arr = this._archive.series[id] || [];
        const f = Math.max(1, Math.round((this._cfg.bucket * 60000) / abms));   // re-bucket archive to display interval (e.g. 2x5min -> 10min)
        const pts = [];
        for (let i = 0; i < arr.length; i += f) { let su = 0, cn = 0; for (let k = i; k < i + f && k < arr.length; k++) if (arr[k] != null) { su += Math.max(0, arr[k]); cn++; } pts.push({ t: aStart + (i + f / 2) * abms, v: cn > 0 ? su / cn : null }); }
        return [{ pts }];
      }
      const axisStart = this._dayStart(), axisEnd = axisStart + this._cfg.hours * 3600000, dataEnd = Math.min(Date.now(), axisEnd), bms = this._cfg.bucket * 60000;
      return [{ pts: this._bucketize(this._data && this._data[id] ? this._data[id] : [], axisStart, dataEnd, bms) }];
    }

    // ---- week / month / year (production energy bars) ----
    async _fetchProduction(start, end, period) {
      const src = this._cfg.prod;
      const ids = src.map((c) => c.id);
      const res = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), statistic_ids: ids, period });
      const by = {};
      src.forEach((c) => { (res && res[c.id] ? res[c.id] : []).forEach((e) => { if (e.change != null) { const k = +new Date(e.start); by[k] = (by[k] || 0) + c.s * e.change; } }); });
      return by;
    }
    _weekMonday() { const s = this._selDate, p = s ? String(s).split("-") : null; const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
    async _loadWeek() {
      if (!this._hass || this._fetchingBars) return; const mon = this._weekMonday();
      if (this._week && this._week.monday === mon && Date.now() - (this._barsFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingBars = true;
      try {
        const end = Math.min(Date.now(), mon + 7 * 86400000); const by = await this._fetchProduction(mon, end, "day");
        const days = []; for (let i = 0; i < 7; i++) { const v = by[mon + i * 86400000]; days.push({ value: v != null ? v : null }); }
        let tot = 0; days.forEach((d) => { if (d.value > 0) tot += d.value; });
        this._week = { monday: mon, days, total: tot }; this._barsFetch = Date.now(); this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingBars = false; }
    }
    _monthRange() { const s = this._selDate, p = s ? String(s).split("-") : null; const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date(); return { first: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), next: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(), key: d.getFullYear() + "-" + d.getMonth() }; }
    async _loadMonth() {
      if (!this._hass || this._fetchingBars) return; const mr = this._monthRange();
      if (this._month && this._month.key === mr.key && Date.now() - (this._barsFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingBars = true;
      try {
        const weeks = [], map = {}; for (let wk = mondayMs(mr.first); wk < mr.next; wk += 7 * 86400000) { map[wk] = weeks.length; weeks.push({ weekNum: isoWeek(wk), value: null }); }
        const end = Math.min(Date.now(), mr.next); const by = await this._fetchProduction(mr.first, end, "day");
        Object.keys(by).forEach((k) => { const i = map[mondayMs(+k)]; if (i != null) weeks[i].value = (weeks[i].value || 0) + by[k]; });
        let tot = 0; weeks.forEach((w) => { if (w.value > 0) tot += w.value; });
        this._month = { key: mr.key, weeks, total: tot }; this._barsFetch = Date.now(); this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingBars = false; }
    }
    _yearRange() { const s = this._selDate, p = s ? String(s).split("-") : null; const y = (p && p.length >= 1 && +p[0]) ? +p[0] : new Date().getFullYear(); return { first: new Date(y, 0, 1).getTime(), next: new Date(y + 1, 0, 1).getTime(), year: y }; }
    async _loadYear() {
      if (!this._hass || this._fetchingBars) return; const yr = this._yearRange();
      if (this._year && this._year.year === yr.year && Date.now() - (this._barsFetch || 0) < 30000) { this._animate(); return; }
      this._fetchingBars = true;
      try {
        const end = Math.min(Date.now(), yr.next); const by = await this._fetchProduction(yr.first, end, "month");
        const months = []; for (let m = 0; m < 12; m++) months.push({ value: null });
        Object.keys(by).forEach((k) => { const d = new Date(+k); if (d.getFullYear() === yr.year) months[d.getMonth()].value = by[k]; });
        let tot = 0; months.forEach((m) => { if (m.value > 0) tot += m.value; });
        this._year = { year: yr.year, months, total: tot }; this._barsFetch = Date.now(); this._updateHeader(); this._animate();
      } catch (e) { if (this._empty) { this._empty.textContent = "Statistics unavailable"; this._empty.style.display = "flex"; } }
      finally { this._fetchingBars = false; }
    }

    // ---- animation + render ----
    _animate() { if (!this._raf) this._raf = requestAnimationFrame(() => this._frame()); }
    _frame() {
      this._raf = null; if (!this._built || !this._wrap.clientWidth) return;
      if (this._period === "Week") { this._renderBars((this._week && this._week.days || new Array(7).fill({})).map((d, i) => ({ label: ["mo", "tu", "we", "th", "fr", "sa", "su"][i], value: d.value }))); return; }
      if (this._period === "Month") { this._renderBars((this._month && this._month.weeks || []).map((w) => ({ label: String(w.weekNum), value: w.value }))); return; }
      if (this._period === "Year") { this._renderBars((this._year && this._year.months || new Array(12).fill({})).map((m, i) => ({ label: "JFMAMJJASOND"[i], value: m.value }))); return; }
      const series = this._buildSeries();
      let maxV = 0; for (const s of series) for (const p of s.pts) if (p.v != null && p.v > maxV) maxV = p.v;
      let tMax = maxV > 0 ? maxV * 1.1 : 0; if (tMax < 100) tMax = 100;
      if (this._dispMax == null) this._dispMax = tMax; else this._dispMax += (tMax - this._dispMax) * EASE;
      this._render(series);
      if (this._period === "Now" || Math.abs(tMax - this._dispMax) > 0.5) this._raf = requestAnimationFrame(() => this._frame());
    }
    _render(series) {
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
      for (const s of series) this._drawArea(ctx, s.pts, X, Y, y1, y0, COL, 0.34, 0.02, 2, 1);
      ctx.restore();
      let any = false; for (const s of series) for (const p of s.pts) if (p.v != null) { any = true; break; }
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
      if (!slots.length) slots = [{ label: "", value: null }];
      let mx = 0; for (const s of slots) if (s.value > mx) mx = s.value;
      const step = niceStep(mx / 5) || 1;
      const top = Math.max(step, Math.ceil(mx / (step / 2)) * (step / 2));
      const padL = 10, padR = 40, padT = 24, padB = 22, x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
      const Y = (v) => y1 - (v / top) * (y1 - y0);
      ctx.font = "11px Inter, system-ui, sans-serif";
      for (let v = 0; v <= top + 1e-6; v += step) { const yy = Y(v); ctx.strokeStyle = v === 0 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.06)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke(); ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(fmtNum(v), W - 6, yy); }
      const n = slots.length, slotW = (x1 - x0) / n, barW = Math.max(6, Math.min(26, slotW * 0.34));
      for (let i = 0; i < n; i++) {
        const cx = x0 + slotW * (i + 0.5), v = slots[i].value;
        if (v != null && v > 0) {
          const bx = cx - barW / 2, by = Y(v), bh = y1 - by;
          const g = ctx.createLinearGradient(0, by, 0, y1); g.addColorStop(0, COL); g.addColorStop(1, hexA(COL, 0.45));
          this._roundBar(ctx, bx, by, barW, bh, 4); ctx.fillStyle = g; ctx.fill();
          ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(fmtNum(v), cx, by - 5);
        }
        ctx.fillStyle = "#8a8a8e"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillText(slots[i].label, cx, H - 6);
      }
      const any = slots.some((s) => s.value > 0);
      this._empty.style.display = any ? "none" : "flex"; if (!any) this._empty.textContent = "No data";
    }

    disconnectedCallback() { this._stopLive(); if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } if (this._ro) { this._ro.disconnect(); this._ro = null; } }
  }

  if (!customElements.get(TAG)) {
    customElements.define(TAG, ProductionCard);
    window.customCards = window.customCards || [];
    window.customCards.push({ type: TAG, name: "Total Production Card", description: "Green single-series solar production: live Now + Day + Week/Month/Year bars." });
    console.info("%c PRODUCTION-CARD %c v8 ", "background:#00e676;color:#0b3a1d", "background:#222;color:#00e676");
  }
})();


;/* ===================== homewizard-today-card.js ===================== */
/*
 * homewizard-today-card
 * -----------------------------------------------------------------------------
 * A polished, app-like "Today" energy overview card for Home Assistant, visually
 * inspired by the HomeWizard Energy "Today" home screen. Today-only: no period
 * switching, navigation or graphs. 100% original SVG/CSS illustration (no
 * HomeWizard assets) + animated energy-flow lines driven by live power sensors.
 *
 * Pattern matches the other cards in config/www/ (vanilla Web Component, shadow
 * DOM, setConfig / set hass / getCardSize, window.customCards registration).
 *
 * Example Lovelace YAML (all entity ids have sensible defaults for THIS install):
 *
 *   type: custom:homewizard-today-card
 *   title: Today
 *   entities:
 *     production_today:  sensor.total_production_today
 *     consumption_today: sensor.home_consumption_today   # derives self-sufficient
 *     grid_today:        sensor.grid_import_daily
 *     surplus_today:     sensor.grid_export_daily
 *     # self_sufficient_today / self_sufficient_percent: optional, derived if omitted
 *   cost:
 *     import_entity:       sensor.p1_meter_energy_import_cost
 *     compensation_entity: sensor.p1_meter_energy_export_compensation
 *     mode: net            # net (import - compensation) | gross (import only)
 *   flows:
 *     solar_power:   sensor.total_solar_power
 *     home_power:    sensor.home_consumption_power
 *     grid_power:    sensor.p1_meter_power          # signed: + import / - export
 *     battery_power: sensor.plug_in_battery_power   # signed: + charge / - discharge
 *     battery_soc:   sensor.plug_in_battery_state_of_charge
 *   format:
 *     energy_decimals: 1
 *     cost_decimals: 2
 *     currency: "€"
 * -----------------------------------------------------------------------------
 */
(function () {
  "use strict";
  const TAG = "homewizard-today-card";

  /* ------------------------------ value helpers --------------------------- */
  const MISSING = ["", "unknown", "unavailable", "none", "null", "nan", "undefined"];
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const DAY = 86400000;
  const mondayOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const isoWeek = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const w1 = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - w1) / DAY - 3 + ((w1.getDay() + 6) % 7)) / 7); };
  const parseDate = (s) => { const p = s ? String(s).split("-") : null; const d = (p && p.length >= 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date(); d.setHours(0, 0, 0, 0); return d; };

  // Raw entity state string (or undefined).
  function getEntityState(hass, id) {
    if (!hass || !id) return undefined;
    const st = hass.states[id];
    return st ? st.state : undefined;
  }
  // Parse a state to a finite number, or null if missing/non-numeric.
  function parseNumber(v) {
    if (v === null || v === undefined) return null;
    const t = String(v).trim().toLowerCase();
    if (MISSING.includes(t)) return null;
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  /* ------------------------------ formatters ------------------------------ */
  function formatEnergy(n, decimals) {
    return n == null ? "--" : n.toFixed(decimals);
  }
  function formatCost(n, decimals) {
    return n == null ? "--" : n.toFixed(decimals);
  }
  function formatPercent(n) {
    return n == null ? "--" : Math.round(n) + "%";
  }

  /* ------------------------------ flow helpers ---------------------------- */
  // Normalise a power sensor to Watts (handles W and kW). -> {w, valid}.
  function getPowerWatts(hass, id) {
    if (!hass || !id) return { w: 0, valid: false };
    const st = hass.states[id];
    if (!st) return { w: 0, valid: false };
    const n = parseNumber(st.state);
    if (n == null) return { w: 0, valid: false };
    const unit = String(st.attributes && st.attributes.unit_of_measurement || "").trim();
    const w = unit.toLowerCase() === "kw" ? n * 1000 : n; // kWh never appears for power
    return { w, valid: true };
  }
  // Map |Watts| -> visible flow opacity (0 when negligible, else 0.20..1).
  function getFlowIntensity(absW, maxW) {
    if (!(absW > 12)) return 0;
    return clamp(0.2 + 0.8 * (absW / maxW), 0.2, 1);
  }
  // Map |Watts| -> animation duration in seconds (more power = faster).
  function getFlowSpeed(absW, maxW) {
    return clamp(3.4 - 2.6 * (absW / maxW), 0.8, 3.4);
  }

  /* ------------------------- SVG illustration geometry -------------------- */
  // viewBox is 0 0 440 410 (ratio ~1.073, near the reference screenshot).
  // Oblique "cabinet" projection: vertical edges stay vertical, depth goes
  // up-right by (+38,-38).
  const P = (x, y) => `${x},${y}`;
  // Roof / solar-panel plane corners (mono-pitch, sloping up to the back ridge):
  // A front-eave-left, B front-eave-right, C back-ridge-right, D back-ridge-left.
  const A = [152, 198], B = [256, 212], C = [292, 174], D = [188, 160];
  // Bilinear interpolation across the panel plane (u: A->B, v: A->D).
  function bilerp(u, v) {
    const ab = [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u];
    const dc = [D[0] + (C[0] - D[0]) * u, D[1] + (C[1] - D[1]) * u];
    return [ab[0] + (dc[0] - ab[0]) * v, ab[1] + (dc[1] - ab[1]) * v];
  }
  // Solar-cell grid lines on the panel plane.
  function panelGrid(nx, ny) {
    let s = "";
    const ln = (p, q) =>
      `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}"/>`;
    for (let i = 1; i < nx; i++) s += ln(bilerp(i / nx, 0), bilerp(i / nx, 1));
    for (let j = 1; j < ny; j++) s += ln(bilerp(0, j / ny), bilerp(1, j / ny));
    return s;
  }

  // Battery geometry (small device on the floor, right of the energy hub).
  const BAT = { x: 237, y: 283, w: 17, h: 31, pad: 2.4 };
  const BAT_INNER = {
    x: BAT.x + BAT.pad,
    w: BAT.w - 2 * BAT.pad,
    top: BAT.y + BAT.pad,
    bottom: BAT.y + BAT.h - BAT.pad,
    h: BAT.h - 2 * BAT.pad,
  };

  /* --------------------------------- styles ------------------------------- */
  const STYLE = `
    :host{display:block;}
    *{box-sizing:border-box;}
    .card{position:relative;width:100%;max-width:580px;margin:0 auto;aspect-ratio:44/41;
      border-radius:var(--ha-card-border-radius,24px);overflow:hidden;container-type:inline-size;
      color:#fff;font-family:Inter,Roboto,-apple-system,"Segoe UI",sans-serif;
      box-shadow:0 10px 30px rgba(8,15,30,.34);
      -webkit-user-select:none;user-select:none;}
    svg.scene{position:absolute;inset:0;width:100%;height:100%;display:block;}

    /* --- top title --- */
    .title{position:absolute;top:4.6%;left:5.5%;z-index:3;font-size:8.4cqw;font-weight:800;
      letter-spacing:-.025em;line-height:1;text-shadow:0 2px 14px rgba(8,16,34,.30);}

    /* --- top metrics floating over the sky --- */
    .metrics{position:absolute;top:17%;left:0;right:0;z-index:3;display:flex;align-items:flex-start;
      justify-content:space-around;gap:2cqw;pointer-events:none;}
    .metric{display:flex;flex-direction:column;align-items:center;gap:.9cqw;text-align:center;min-width:0;}
    .metric .label{font-size:3.4cqw;font-weight:600;color:rgba(255,255,255,.82);letter-spacing:.005em;
      text-shadow:0 1px 8px rgba(8,16,34,.24);}
    .metric .val{display:flex;align-items:baseline;gap:1cqw;text-shadow:0 2px 12px rgba(8,16,34,.28);}
    .num{font-weight:800;line-height:.95;letter-spacing:-.02em;}
    .metric .num{font-size:9cqw;}
    .unit{font-weight:600;color:rgba(255,255,255,.82);}
    .metric .unit{font-size:3.8cqw;}
    .pct{font-size:4.6cqw;font-weight:700;color:rgba(255,255,255,.92);margin-left:.3cqw;}
    .vdiv{width:1px;height:12cqw;margin-top:1.4cqw;align-self:flex-start;
      background:linear-gradient(rgba(255,255,255,0),rgba(255,255,255,.35),rgba(255,255,255,0));}

    /* --- bottom dark panel stats --- */
    .bottom{position:absolute;left:0;right:0;bottom:0;height:22%;z-index:3;display:flex;
      align-items:center;padding:0 2cqw 1.6cqw;}
    .col{flex:1;display:flex;flex-direction:column;align-items:center;gap:.7cqw;text-align:center;min-width:0;}
    .blabel{font-size:3.2cqw;font-weight:600;color:rgba(255,255,255,.62);letter-spacing:.02em;}
    .bval{display:flex;align-items:baseline;gap:.8cqw;}
    .bval .num{font-size:8.2cqw;}
    .bval .unit{font-size:3.6cqw;}
    .cur{font-size:5cqw;font-weight:700;color:rgba(255,255,255,.9);margin-right:.1cqw;}

    /* --- energy-flow animation (moving glowing particles) --- */
    .flow{fill:none;stroke-linecap:round;stroke-width:3.6;stroke-dasharray:0.1 12.9;
      filter:url(#fglow);animation:hwflow var(--spd,2.2s) linear infinite;will-change:stroke-dashoffset;}
    .flow.rev{animation-name:hwflowrev;}
    .flow.off{opacity:.04 !important;animation-play-state:paused;}
    @keyframes hwflow{to{stroke-dashoffset:-26;}}
    @keyframes hwflowrev{to{stroke-dashoffset:26;}}

    @media (prefers-reduced-motion: reduce){
      .flow{animation:none !important;stroke-dasharray:none;stroke-width:2.6;}
      .flow.off{opacity:.16 !important;}
    }`;

  /* --------------------------- the SVG scene markup ----------------------- */
  function sceneSVG() {
    return `
    <svg class="scene" viewBox="0 0 440 410" preserveAspectRatio="xMidYMid slice"
         xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6ea7dc"/><stop offset=".5" stop-color="#9ec6e3"/>
          <stop offset="1" stop-color="#c7dde5"/>
        </linearGradient>
        <radialGradient id="sun" cx=".78" cy=".1" r=".55">
          <stop offset="0" stop-color="#fff5dd" stop-opacity=".55"/>
          <stop offset="1" stop-color="#fff5dd" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="hillBack" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9ecb80"/><stop offset="1" stop-color="#7bb466"/>
        </linearGradient>
        <linearGradient id="hillFront" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#5aa258"/><stop offset="1" stop-color="#3c8446"/>
        </linearGradient>
        <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#0f2e2a" stop-opacity="0"/>
          <stop offset=".42" stop-color="#0d2925" stop-opacity=".92"/>
          <stop offset="1" stop-color="#071c19" stop-opacity=".98"/>
        </linearGradient>
        <linearGradient id="divider" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
          <stop offset=".5" stop-color="#ffffff" stop-opacity=".18"/>
          <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="roof" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#243450"/><stop offset="1" stop-color="#0c1322"/>
        </linearGradient>
        <linearGradient id="panelSheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#d6ecff" stop-opacity=".22"/>
          <stop offset=".5" stop-color="#d6ecff" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="wallFront" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#3b4350"/><stop offset="1" stop-color="#242b34"/>
        </linearGradient>
        <linearGradient id="wallSide" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#4b5560"/><stop offset="1" stop-color="#363e49"/>
        </linearGradient>
        <radialGradient id="hubBody" cx=".4" cy=".34" r=".75">
          <stop offset="0" stop-color="#2c333b"/><stop offset=".6" stop-color="#141a1f"/>
          <stop offset="1" stop-color="#090c10"/>
        </radialGradient>
        <radialGradient id="hubGlow" cx=".5" cy=".5" r=".5">
          <stop offset="0" stop-color="#57f0c2" stop-opacity=".5"/>
          <stop offset="1" stop-color="#57f0c2" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="winWarm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffe7ad"/><stop offset="1" stop-color="#f3bd66"/>
        </linearGradient>
        <radialGradient id="winGlow" cx=".5" cy=".5" r=".5">
          <stop offset="0" stop-color="#ffd98f" stop-opacity=".5"/>
          <stop offset="1" stop-color="#ffd98f" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="batBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2c333d"/><stop offset="1" stop-color="#1a1f26"/>
        </linearGradient>
        <filter id="blurS" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5"/></filter>
        <filter id="hubShadow" x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000000" flood-opacity=".42"/>
        </filter>
        <filter id="fglow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.8" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      <!-- sky + soft sun glow -->
      <rect x="0" y="0" width="440" height="410" fill="url(#sky)"/>
      <circle cx="350" cy="34" r="150" fill="url(#sun)"/>

      <!-- soft layered clouds -->
      <g filter="url(#blurS)">
        <g fill="#ffffff" opacity=".55"><ellipse cx="96" cy="116" rx="40" ry="13"/><ellipse cx="124" cy="108" rx="26" ry="14"/><ellipse cx="72" cy="120" rx="22" ry="10"/></g>
        <g fill="#ffffff" opacity=".4"><ellipse cx="330" cy="92" rx="34" ry="11"/><ellipse cx="356" cy="86" rx="22" ry="12"/></g>
        <g fill="#ffffff" opacity=".28"><ellipse cx="226" cy="150" rx="30" ry="9"/></g>
      </g>

      <!-- rolling hills + faint horizon mist -->
      <path d="M0 266 Q120 234 250 256 T440 250 L440 410 L0 410 Z" fill="url(#hillBack)"/>
      <rect x="0" y="242" width="440" height="26" fill="#ffffff" opacity=".09" filter="url(#blurS)"/>
      <path d="M0 292 Q140 262 270 286 T440 286 L440 410 L0 410 Z" fill="url(#hillFront)"/>
      <g fill="#347a43" opacity=".92"><ellipse cx="56" cy="300" rx="20" ry="13"/><ellipse cx="80" cy="296" rx="14" ry="10"/><ellipse cx="392" cy="299" rx="18" ry="12"/><ellipse cx="414" cy="303" rx="12" ry="9"/></g>

      <!-- bottom dark scrim (fades in over the hills) + hairline divider -->
      <rect x="0" y="284" width="440" height="126" fill="url(#scrim)"/>
      <rect x="0" y="311.4" width="440" height="1.4" fill="url(#divider)"/>

      <!-- ================= HOUSE ================= -->
      <!-- right side wall (3D depth) -->
      <polygon points="${P(256,212)} ${P(292,174)} ${P(292,288)} ${P(256,312)}" fill="url(#wallSide)"/>
      <!-- front wall -->
      <polygon points="${P(152,198)} ${P(256,212)} ${P(256,312)} ${P(152,312)}" fill="url(#wallFront)"/>
      <!-- front-right corner highlight -->
      <line x1="256" y1="212" x2="256" y2="312" stroke="#5d6877" stroke-width="1.1" opacity=".5"/>

      <!-- warm-lit window -->
      <circle cx="196" cy="262" r="42" fill="url(#winGlow)"/>
      <rect x="174" y="234" width="44" height="56" rx="5" fill="url(#winWarm)"/>
      <line x1="196" y1="234" x2="196" y2="290" stroke="#c79c54" stroke-width="1" opacity=".4"/>
      <line x1="174" y1="261" x2="218" y2="261" stroke="#c79c54" stroke-width="1" opacity=".4"/>
      <rect x="174" y="234" width="44" height="56" rx="5" fill="none" stroke="#10151b" stroke-width="1.6" opacity=".5"/>

      <!-- roof / solar panel plane -->
      <polygon points="${P(...A)} ${P(...B)} ${P(...C)} ${P(...D)}" fill="url(#roof)"/>
      <g stroke="#3b5078" stroke-width=".8" opacity=".5">${panelGrid(7, 4)}</g>
      <polygon points="${P(...A)} ${P(...B)} ${P(...C)} ${P(...D)}" fill="url(#panelSheen)"/>
      <polygon points="${P(...A)} ${P(...B)} ${P(...C)} ${P(...D)}" fill="none" stroke="#0a0f1a" stroke-width="1.6" stroke-linejoin="round"/>

      <!-- ================= ENERGY FLOWS (under the hub) ================= -->
      <!-- grid corridor into the ground: import (up) + export (down) -->
      <path id="f-gridImp" class="flow rev" d="M202 318 L202 336" stroke="#e46bf0"/>
      <path id="f-gridExp" class="flow"     d="M202 318 L202 336" stroke="#5fe08a"/>
      <!-- solar: panel -> hub -->
      <path id="f-solar" class="flow" d="M222 190 C216 222 209 256 204 286" stroke="#6ff0a6"/>
      <!-- home: hub -> room -->
      <path id="f-home" class="flow" d="M201 290 C198 280 197 272 196 264" stroke="#a9ecbf"/>
      <!-- battery: hub <-> battery -->
      <path id="f-batChg" class="flow"     d="M219 300 L240 300" stroke="#5fe08a"/>
      <path id="f-batDis" class="flow rev" d="M219 300 L240 300" stroke="#57f0c2"/>

      <!-- ================= BATTERY ================= -->
      <g id="batteryGroup">
        <rect x="${BAT.x + 5}" y="${BAT.y - 3.5}" width="7" height="4" rx="1.4" fill="#39414d"/>
        <rect x="${BAT.x}" y="${BAT.y}" width="${BAT.w}" height="${BAT.h}" rx="4" fill="url(#batBody)" stroke="#10151b" stroke-opacity=".6" stroke-width="1"/>
        <rect id="batFill" x="${BAT_INNER.x}" y="${BAT_INNER.bottom}" width="${BAT_INNER.w}" height="0" rx="2.4" fill="#5fe08a"/>
        <rect x="${BAT_INNER.x}" y="${BAT.y + 2.5}" width="${BAT_INNER.w}" height="3" rx="1.5" fill="#ffffff" opacity=".1"/>
        <rect x="${BAT.x}" y="${BAT.y}" width="${BAT.w}" height="${BAT.h}" rx="4" fill="none" stroke="#6ff0b0" stroke-opacity=".5" stroke-width="1.2"/>
      </g>

      <!-- ================= ENERGY HUB ================= -->
      <circle cx="202" cy="298" r="30" fill="url(#hubGlow)"/>
      <circle cx="202" cy="298" r="19.5" fill="url(#hubBody)" stroke="#0b1a17" stroke-width="1.2" filter="url(#hubShadow)"/>
      <ellipse cx="202" cy="291" rx="11" ry="5.5" fill="#ffffff" opacity=".06"/>
      <path d="M205 287 l-9 13 h5 l-3 11 11 -15 h-6 z" fill="#5ff0c2"/>
    </svg>`;
  }

  /* ------------------------------ the element ----------------------------- */
  class HomeWizardTodayCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._built = false;
      this._period = "Now";
      this._selDate = null;
      this._range = null;
      this._periodTotals = null;
      this._statsCache = {};
      this._fetchingKey = null;
    }

    setConfig(config) {
      const c = config || {};
      const e = c.entities || {};
      const f = c.flows || {};
      const cost = c.cost || {};
      const fmt = c.format || {};
      const stats = c.stats || {};
      const pick = (v, d) => (v === undefined ? d : v);
      this._cfg = {
        title: pick(c.title, "Today"),
        entities: {
          production_today: pick(e.production_today, "sensor.total_production_today"),
          consumption_today: pick(e.consumption_today, "sensor.home_consumption_today"),
          grid_today: pick(e.grid_today, "sensor.grid_import_daily"),
          surplus_today: pick(e.surplus_today, "sensor.grid_export_daily"),
          self_sufficient_today: pick(e.self_sufficient_today, null),
          self_sufficient_percent: pick(e.self_sufficient_percent, null),
        },
        cost: {
          entity: pick(cost.entity, null), // direct single-sensor override
          import_entity: pick(cost.import_entity, "sensor.p1_meter_energy_import_cost"),
          compensation_entity: pick(cost.compensation_entity, "sensor.p1_meter_energy_export_compensation"),
          mode: pick(cost.mode, "net"), // "compute" | "net" | "gross"
          // "compute" = today's grid energy x tariff price (uses the daily-reset
          // utility_meter energy, so it can't drift like a running cost sensor).
          import_energy: pick(cost.import_energy, null), // defaults to entities.grid_today
          export_energy: pick(cost.export_energy, null), // defaults to entities.surplus_today
          import_price: pick(cost.import_price, "sensor.vrijopnaam_stroomprijs"),
          feedin_price: pick(cost.feedin_price, "sensor.vrijopnaam_teruglevertarief"),
          subtract_feedin: pick(cost.subtract_feedin, false), // false = gross import cost
        },
        flows: {
          solar_power: pick(f.solar_power, "sensor.total_solar_power"),
          home_power: pick(f.home_power, "sensor.home_consumption_power"),
          grid_power: pick(f.grid_power, "sensor.p1_meter_power"),
          grid_import_power: pick(f.grid_import_power, null),
          grid_export_power: pick(f.grid_export_power, null),
          battery_power: pick(f.battery_power, "sensor.plug_in_battery_power"),
          battery_soc: pick(f.battery_soc, "sensor.plug_in_battery_state_of_charge"),
          battery_invert: pick(f.battery_invert, false),
        },
        format: {
          energy_decimals: pick(fmt.energy_decimals, 1),
          cost_decimals: pick(fmt.cost_decimals, 2),
          currency: pick(fmt.currency, "€"),
          power_max: pick(fmt.power_max, 3500), // W at which a flow reaches full intensity
        },
        // Follow the dashboard period picker (Now/Day/Week/Month/Year). For non-today
        // ranges the metrics come from long-term statistics (sum of per-bucket "change").
        follow_period: pick(c.follow_period, true),
        period_entity: pick(c.period_entity, "input_select.energy_period"),
        date_entity: pick(c.date_entity, "input_datetime.energy_date"),
        stats: {
          production: stats.production || ["sensor.growatt_lifetime_total_solar_energy", "sensor.sma_total_yield"],
          import: pick(stats.import, "sensor.p1_meter_energy_import"),
          export: pick(stats.export, "sensor.p1_meter_energy_export"),
          battery_charge: pick(stats.battery_charge, "sensor.plug_in_battery_energy_import"),
          battery_discharge: pick(stats.battery_discharge, "sensor.plug_in_battery_energy_export"),
          cost_import: pick(stats.cost_import, "sensor.p1_meter_energy_import_cost"),
          cost_export: pick(stats.cost_export, "sensor.p1_meter_energy_export_compensation"),
        },
      };
      this._built = false;
      this._range = null;
      if (this.shadowRoot) this._maybeBuild();
    }

    getCardSize() { return 6; }

    set hass(hass) {
      this._hass = hass;
      this._maybeBuild();
      this._syncPeriod();
      this._update();
    }

    _maybeBuild() {
      if (this._built || !this._cfg) return;
      this.shadowRoot.innerHTML = `
        <style>${STYLE}</style>
        <div class="card">
          ${sceneSVG()}
          <div class="title">${this._esc(this._cfg.title)}</div>
          <div class="metrics">
            <div class="metric">
              <div class="label">Production</div>
              <div class="val"><span class="num" id="prodNum">--</span><span class="unit">kWh</span></div>
            </div>
            <div class="vdiv"></div>
            <div class="metric">
              <div class="label">Self-sufficient</div>
              <div class="val">
                <span class="num" id="selfNum">--</span><span class="unit">kWh</span>
                <span class="pct" id="selfPct">--</span>
              </div>
            </div>
          </div>
          <div class="bottom">
            <div class="col"><div class="blabel">Grid</div>
              <div class="bval"><span class="num" id="gridNum">--</span><span class="unit">kWh</span></div></div>
            <div class="col"><div class="blabel">Costs</div>
              <div class="bval"><span class="cur">${this._esc(this._cfg.format.currency)}</span><span class="num" id="costNum">--</span></div></div>
            <div class="col"><div class="blabel">Surplus</div>
              <div class="bval"><span class="num" id="surNum">--</span><span class="unit">kWh</span></div></div>
          </div>
        </div>`;
      const $ = (id) => this.shadowRoot.getElementById(id);
      this._els = {
        title: this.shadowRoot.querySelector(".title"),
        prodNum: $("prodNum"), selfNum: $("selfNum"), selfPct: $("selfPct"),
        gridNum: $("gridNum"), costNum: $("costNum"), surNum: $("surNum"),
        batteryGroup: $("batteryGroup"), batFill: $("batFill"),
        solar: $("f-solar"), home: $("f-home"),
        gridImp: $("f-gridImp"), gridExp: $("f-gridExp"),
        batChg: $("f-batChg"), batDis: $("f-batDis"),
      };
      this._built = true;
    }

    _esc(s) { return String(s).replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m])); }

    _num(id) { return parseNumber(getEntityState(this._hass, id)); }

    // Read the picker (input_select.energy_period + input_datetime.energy_date),
    // resolve the active range, and kick off a statistics fetch for non-today ranges.
    _syncPeriod() {
      const C = this._cfg;
      let period = "Now", dateStr = null;
      if (C.follow_period && this._hass) {
        const pst = this._hass.states[C.period_entity];
        period = pst ? pst.state : "Now";
        const dst = this._hass.states[C.date_entity];
        dateStr = dst ? dst.state : null;
      }
      if (period !== this._period || dateStr !== this._selDate || !this._range) {
        this._period = period;
        this._selDate = dateStr;
        this._range = this._resolveRange(period, dateStr);
        const c = this._statsCache[this._range.key];
        this._periodTotals = c ? c.totals : null;
      }
      if (!this._range.metricsLive) this._fetchStats(this._range);
    }

    // -> { key, start, end, statPeriod, metricsLive, label }
    // metricsLive: read today's live sensors (else the period's statistics totals).
    // (Flows always show live power regardless of period, so there's no flow flag here.)
    _resolveRange(period, dateStr) {
      const now = new Date();
      const today = new Date(now); today.setHours(0, 0, 0, 0);
      const d = parseDate(dateStr);
      const todayLabel = this._cfg.title || "Today";
      if (period === "Week") {
        const start = mondayOf(d), end = new Date(start.getTime() + 7 * DAY);
        const diff = Math.round((mondayOf(now).getTime() - start.getTime()) / (7 * DAY));
        const label = diff === 0 ? "This Week" : diff === 1 ? "Last Week" : "Week " + isoWeek(start.getTime());
        return { key: "w" + start.getTime(), start, end, statPeriod: "day", metricsLive: false, label };
      }
      if (period === "Month") {
        const start = new Date(d.getFullYear(), d.getMonth(), 1), end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        const label = start.toLocaleDateString(undefined, { month: "long" }) + (start.getFullYear() !== now.getFullYear() ? " " + start.getFullYear() : "");
        return { key: "m" + start.getTime(), start, end, statPeriod: "day", metricsLive: false, label };
      }
      if (period === "Year") {
        const start = new Date(d.getFullYear(), 0, 1), end = new Date(d.getFullYear() + 1, 0, 1);
        return { key: "y" + d.getFullYear(), start, end, statPeriod: "month", metricsLive: false, label: String(d.getFullYear()) };
      }
      // Now, or Day. Today (or "Now") uses the live sensors directly.
      if (period === "Now" || d.getTime() === today.getTime()) {
        return { key: "today", metricsLive: true, label: todayLabel };
      }
      const start = d, end = new Date(d.getTime() + DAY);
      const yest = new Date(today.getTime() - DAY);
      const label = d.getTime() === yest.getTime() ? "Yesterday" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
      return { key: "d" + start.getTime(), start, end, statPeriod: "day", metricsLive: false, label };
    }

    _fetchStats(range) {
      const cached = this._statsCache[range.key];
      // past ranges cache forever; a current (flowsLive) range refreshes every 60s
      if (cached && (!range.flowsLive || Date.now() - cached.ts < 60000)) { this._periodTotals = cached.totals; return; }
      if (this._fetchingKey === range.key) return;
      this._fetchingKey = range.key;
      this._doFetch(range).finally(() => { if (this._fetchingKey === range.key) this._fetchingKey = null; });
    }

    async _doFetch(range) {
      const S = this._cfg.stats;
      const ids = [].concat(S.production, [S.import, S.export, S.battery_charge, S.battery_discharge, S.cost_import, S.cost_export]).filter(Boolean);
      try {
        const res = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: range.start.toISOString(), end_time: range.end.toISOString(),
          statistic_ids: ids, period: range.statPeriod,
        });
        // statistics_during_period also returns the bucket that starts exactly at end_time
        // (next-day/next-period midnight). Count only buckets whose start is inside [start, end)
        // so a single day isn't summed together with the following one.
        const startMs = range.start.getTime(), endMs = range.end.getTime();
        const agg = (id) => {
          const rows = res && res[id];
          if (!rows || !rows.length) return { v: 0, has: false };
          let s = 0, has = false;
          for (const r of rows) {
            const t = new Date(r.start).getTime();
            if (t < startMs || t >= endMs) continue;
            has = true;
            if (r.change != null && r.change > 0) s += r.change;
          }
          return { v: s, has };
        };
        let prodV = 0, prodHas = false;
        for (const pid of S.production) { const a = agg(pid); prodV += a.v; prodHas = prodHas || a.has; }
        const imp = agg(S.import), exp = agg(S.export), bc = agg(S.battery_charge), bd = agg(S.battery_discharge);
        const ci = agg(S.cost_import), ce = agg(S.cost_export);
        const anyEnergy = prodHas || imp.has || exp.has;
        const totals = {
          key: range.key,
          prod: prodHas ? prodV : null,
          imp: imp.has ? imp.v : null,
          exp: exp.has ? exp.v : null,
          cons: anyEnergy ? Math.max(prodV + imp.v - exp.v - bc.v + bd.v, 0) : null,
          cost: ci.has ? ci.v - (this._cfg.cost.subtract_feedin ? ce.v : 0) : null,
        };
        this._statsCache[range.key] = { totals, ts: Date.now() };
        if (this._range && this._range.key === range.key) { this._periodTotals = totals; this._update(); }
      } catch (e) { /* leave metrics as "--" */ }
    }

    // Today's live cost (compute | direct | net | gross).
    _liveCost() {
      const C = this._cfg, E = C.entities, CT = C.cost;
      if (CT.mode === "compute") {
        const ik = this._num(CT.import_energy || E.grid_today);
        const ek = this._num(CT.export_energy || E.surplus_today);
        const ip = this._num(CT.import_price);
        const fp = this._num(CT.feedin_price);
        if (ik == null || ip == null) return null;
        let c = ik * ip;
        if (CT.subtract_feedin && ek != null && fp != null) c -= ek * fp;
        return c;
      }
      if (CT.entity) return this._num(CT.entity);
      const ci = this._num(CT.import_entity);
      if (CT.mode === "gross") return ci;
      return ci != null ? ci - (this._num(CT.compensation_entity) || 0) : null;
    }

    // Toggle/scale one animated flow path from an absolute Watt value.
    _setFlow(el, absW) {
      if (!el) return;
      const max = this._cfg.format.power_max;
      const inten = getFlowIntensity(absW, max);
      if (inten <= 0) {
        el.classList.add("off");
        el.style.opacity = "";
        return;
      }
      el.classList.remove("off");
      el.style.opacity = inten.toFixed(2);
      el.style.setProperty("--spd", getFlowSpeed(absW, max).toFixed(2) + "s");
    }

    _update() {
      if (!this._built || !this._hass) return;
      const C = this._cfg, E = C.entities, F = C.flows, FT = C.format, els = this._els;

      /* ---- metrics: live "today", or the selected period's statistics totals ---- */
      const range = this._range || { metricsLive: true, label: C.title };
      let prod = null, imp = null, exp = null, ssk = null, ssp = null, cost = null;
      if (range.metricsLive) {
        prod = this._num(E.production_today);
        const cons = this._num(E.consumption_today);
        imp = this._num(E.grid_today);
        exp = this._num(E.surplus_today);
        ssk = this._num(E.self_sufficient_today);
        if (ssk == null && cons != null && imp != null) ssk = Math.max(cons - imp, 0);
        ssp = this._num(E.self_sufficient_percent);
        if (ssp == null && cons != null && imp != null && cons > 0) ssp = clamp((cons - imp) / cons * 100, 0, 100);
        cost = this._liveCost();
      } else {
        const t = this._periodTotals;
        if (t && t.key === range.key) {
          prod = t.prod; imp = t.imp; exp = t.exp; cost = t.cost;
          const cons = t.cons;
          if (cons != null && imp != null) {
            ssk = Math.max(cons - imp, 0);
            ssp = cons > 0 ? clamp((cons - imp) / cons * 100, 0, 100) : null;
          }
        }
      }

      if (els.title) els.title.textContent = range.label;
      els.prodNum.textContent = formatEnergy(prod, FT.energy_decimals);
      els.selfNum.textContent = formatEnergy(ssk, FT.energy_decimals);
      els.selfPct.textContent = formatPercent(ssp);
      els.gridNum.textContent = formatEnergy(imp, FT.energy_decimals);
      els.costNum.textContent = formatCost(cost, FT.cost_decimals);
      els.surNum.textContent = formatEnergy(exp, FT.energy_decimals);

      /* ---- live power flows ---- */
      const solar = getPowerWatts(this._hass, F.solar_power);
      const home = getPowerWatts(this._hass, F.home_power);

      // Grid: prefer split sensors, else a single signed sensor (+import / -export).
      let impW = 0, expW = 0;
      if (F.grid_import_power || F.grid_export_power) {
        impW = getPowerWatts(this._hass, F.grid_import_power).w || 0;
        expW = getPowerWatts(this._hass, F.grid_export_power).w || 0;
      } else {
        const g = getPowerWatts(this._hass, F.grid_power);
        const w = g.valid ? g.w : 0;
        impW = Math.max(w, 0);
        expW = Math.max(-w, 0);
      }

      // Battery: signed (+charge / -discharge), optional inversion.
      let chgW = 0, disW = 0;
      const b = getPowerWatts(this._hass, F.battery_power);
      if (b.valid) {
        let bw = F.battery_invert ? -b.w : b.w;
        chgW = Math.max(bw, 0);
        disW = Math.max(-bw, 0);
      }

      // Flows always reflect what's happening right now (current power), whatever period is
      // selected — the metrics above show the period, the house stays live.
      this._setFlow(els.solar, solar.valid ? solar.w : 0);
      this._setFlow(els.home, home.valid ? home.w : 0);
      this._setFlow(els.gridImp, impW);
      this._setFlow(els.gridExp, expW);
      this._setFlow(els.batChg, chgW);
      this._setFlow(els.batDis, disW);

      /* ---- battery presence + state-of-charge fill ---- */
      const batConfigured = !!(F.battery_power || F.battery_soc);
      els.batteryGroup.style.display = batConfigured ? "" : "none";
      if (batConfigured && els.batFill) {
        const soc = this._num(F.battery_soc);
        if (soc == null) {
          els.batFill.setAttribute("height", "0");
          els.batFill.setAttribute("y", BAT_INNER.bottom);
        } else {
          const fh = clamp(soc / 100, 0, 1) * BAT_INNER.h;
          els.batFill.setAttribute("height", fh.toFixed(1));
          els.batFill.setAttribute("y", (BAT_INNER.bottom - fh).toFixed(1));
          // tint amber when low
          els.batFill.setAttribute("fill", soc < 20 ? "#ffb25a" : "#5fe08a");
        }
      }
    }
  }

  if (!customElements.get(TAG)) {
    customElements.define(TAG, HomeWizardTodayCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
      type: TAG,
      name: "HomeWizard Today Card",
      preview: false,
      description: "A scenic Today energy overview (production, self-sufficient, grid, costs, surplus) with animated energy flows.",
    });
  }
})();


;/* ===================== usage-card.js ===================== */
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


;/* ===================== energy-header-card.js ===================== */
/*
 * energy-header-card
 * Date picker (📅 calendar + ‹ › ›| nav) + Now/Day/Week/Month/Year tabs,
 * wired to input_datetime.energy_date + input_select.energy_period.
 *
 * Pinning: the bar is rendered into a page-level fixed element (appended to <body>, above all
 * section cards) and anchored at the header's at-rest position with a CONSTANT top, so it never
 * moves while the graphs scroll behind it. (HA's sections view bounds position:sticky to a card's
 * own section and paints later sections on top, so a normal sticky/CSS approach can't do this.)
 */
(function () {
  const TAG = "energy-header-card";
  const pad = (n) => String(n).padStart(2, "0");
  const toStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { if (!s) return null; const p = String(s).split("-"); if (p.length < 3) return null; const d = new Date(+p[0], +p[1] - 1, +p[2]); return isNaN(d) ? null : d; };
  const midnight = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const mondayOf = (d) => { const x = midnight(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.getTime(); };
  const isoWeek = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const w1 = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7); };

  const STYLE = `
    .bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;color:#e6e0e9;
         background:rgba(24,24,27,0.58);
         -webkit-backdrop-filter:blur(16px) saturate(150%);backdrop-filter:blur(16px) saturate(150%);
         border:1px solid rgba(255,255,255,0.09);border-radius:16px;padding:12px 18px;
         font-family:Inter,Roboto,-apple-system,"Segoe UI",sans-serif;
         box-shadow:0 -6px 18px rgba(0,0,0,0.40),0 14px 36px rgba(0,0,0,0.62);}
    .left{display:flex;align-items:center;gap:3px;}
    .calwrap{position:relative;display:flex;align-items:center;margin-right:3px;}
    .date{font-size:20px;font-weight:600;min-width:78px;text-align:center;}
    .navbtn{background:none;border:none;color:#cbc4d2;font:inherit;font-size:22px;line-height:1;cursor:pointer;
            padding:2px 7px;border-radius:8px;display:flex;align-items:center;justify-content:center;}
    .navbtn.cal{font-size:18px;}
    .navbtn:hover:not(:disabled){background:#2c2c2e;color:#fff;}
    .navbtn:disabled{opacity:.3;cursor:default;}
    .navbtn ha-icon{--mdc-icon-size:24px;display:block;color:currentColor;}
    .seg{margin-left:auto;background:#2c2c2e;border-radius:999px;padding:3px;display:flex;gap:2px;}
    .seg button{background:none;border:none;color:#cbc4d2;font:inherit;font-size:13px;font-weight:500;padding:6px 16px;border-radius:999px;cursor:pointer;transition:background .15s,color .15s;}
    .seg button:hover{color:#fff;} .seg button.on{background:#48454e;color:#fff;} .seg button.now.on{background:#0a84ff;color:#fff;}
    .calpop{position:absolute;top:38px;left:0;z-index:30;background:#2c2c2e;border:1px solid #3a3a3c;border-radius:12px;
         padding:10px;display:none;box-shadow:0 10px 30px rgba(0,0,0,.55);width:244px;}
    .cal-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:14px;font-weight:600;color:#e6e0e9;}
    .cal-nav{background:none;border:none;color:#cbc4d2;font-size:18px;cursor:pointer;padding:0 9px;border-radius:6px;line-height:1;}
    .cal-nav:hover{background:#38353c;color:#fff;}
    .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;}
    .cal-wd{font-size:11px;color:#8a8a8e;text-align:center;padding:2px 0;}
    .cal-day{background:none;border:none;color:#e6e0e9;font:inherit;font-size:13px;padding:6px 0;border-radius:7px;cursor:pointer;}
    .cal-day:hover:not(:disabled){background:#48454e;}
    .cal-day:disabled{color:#48484a;cursor:default;}
    .cal-day.sel{background:#0a84ff;color:#fff;}`;

  const BAR = `
    <div class="bar">
      <div class="left" id="left">
        <span class="calwrap">
          <button class="navbtn cal" id="calBtn" title="Pick a date">📅</button>
          <div class="calpop" id="cal"></div>
        </span>
        <button class="navbtn" id="prev" title="Previous"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
        <span class="date" id="date">—</span>
        <button class="navbtn" id="next" title="Next"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
        <button class="navbtn today" id="today" title="Jump to current"><ha-icon icon="mdi:page-last"></ha-icon></button>
      </div>
      <div class="seg" id="seg"></div>
    </div>`;

  class EnergyHeaderCard extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }); this._built = false; this._avail = null; this._calOpen = false; this._scroller = undefined; }
    setConfig(c) {
      this._cfg = {
        period_entity: (c && c.period_entity) || "input_select.energy_period",
        date_entity: (c && c.date_entity) || "input_datetime.energy_date",
        periods: (c && c.periods) || ["Now", "Day", "Week", "Month", "Year"],
        archive_base: (c && c.archive_base) || "/local/energy-archive",
      };
      this._built = false;
    }
    getCardSize() { return 1; }
    set hass(h) { this._hass = h; if (!this._built) this._build(); this._update(); this._sync(); }

    _build() {
      this.shadowRoot.innerHTML = `<style>:host{display:block;}.ph{width:100%;}</style><div class="ph"></div>`;
      this._ph = this.shadowRoot.querySelector(".ph");
      this._fix = document.createElement("div");
      this._fix.style.cssText = "position:fixed;z-index:7;left:0;top:-999px;width:0;box-sizing:border-box;";
      this._fsr = this._fix.attachShadow({ mode: "open" });
      this._fsr.innerHTML = `<style>${STYLE}</style>${BAR}`;
      document.body.appendChild(this._fix);
      const seg = this._fsr.getElementById("seg");
      this._cfg.periods.forEach((p) => { const b = document.createElement("button"); b.textContent = p; b.dataset.p = p; if (p === "Now") b.classList.add("now"); b.addEventListener("click", () => this._set(p)); seg.appendChild(b); });
      this._left = this._fsr.getElementById("left");
      this._dateEl = this._fsr.getElementById("date");
      this._prev = this._fsr.getElementById("prev");
      this._next = this._fsr.getElementById("next");
      this._today = this._fsr.getElementById("today");
      this._calBtn = this._fsr.getElementById("calBtn");
      this._calwrap = this._fsr.querySelector(".calwrap");
      this._cal = this._fsr.getElementById("cal");
      this._prev.addEventListener("click", () => this._shift(-1));
      this._next.addEventListener("click", () => this._shift(1));
      this._today.addEventListener("click", () => this._goToday());
      this._calBtn.addEventListener("click", (e) => { e.stopPropagation(); this._toggleCal(); });
      this._onDocClick = (e) => { if (this._calOpen && !e.composedPath().includes(this._calwrap)) this._closeCal(); };
      document.addEventListener("click", this._onDocClick);
      this._onResize = () => { this._atRest = null; this._sync(); };
      window.addEventListener("resize", this._onResize, true);
      this._built = true;
      // re-sync as the layout settles (no scroll listener needed: the bar is truly fixed)
      this._sync(); requestAnimationFrame(() => this._sync());
      [150, 500, 1200].forEach((t) => setTimeout(() => this._sync(), t));
    }
    disconnectedCallback() {
      window.removeEventListener("resize", this._onResize, true);
      if (this._onDocClick) document.removeEventListener("click", this._onDocClick);
      if (this._fix && this._fix.parentNode) this._fix.parentNode.removeChild(this._fix);
    }
    _sync() {
      if (!this._built || !this._ph || !this._fix) return;
      const bar = this._fsr.querySelector(".bar");
      const h = bar ? bar.offsetHeight : 0;
      if (h) this._ph.style.height = h + "px";                                   // reserve the bar's height in-flow
      const r = this._ph.getBoundingClientRect();
      if (r.width < 10) { this._fix.style.visibility = "hidden"; return; }
      this._fix.style.visibility = "";
      // at-rest top = placeholder's top at scroll 0 = the largest top we ever observe (scrolling
      // only moves it up). Pin the bar there permanently so it never moves; graphs scroll behind.
      this._atRest = (this._atRest == null) ? r.top : Math.max(this._atRest, r.top);
      this._fix.style.top = this._atRest + "px";
      this._fix.style.left = r.left + "px";
      this._fix.style.width = r.width + "px";
    }

    _set(p) {
      if (!this._hass) return;
      const cur = (this._hass.states[this._cfg.period_entity] || {}).state;
      // switching to a different view always snaps back to the current day/week/month/year
      if (cur !== p) this._hass.callService("input_datetime", "set_datetime", { entity_id: this._cfg.date_entity, date: toStr(new Date()) });
      this._hass.callService("input_select", "select_option", { entity_id: this._cfg.period_entity, option: p });
    }
    _shift(delta) {
      if (!this._hass) return;
      const st = this._hass.states[this._cfg.date_entity];
      const cur = (st && parse(st.state)) || new Date();
      const pst = this._hass.states[this._cfg.period_entity]; const per = pst ? pst.state : "Day";
      if (per === "Year") { cur.setMonth(0, 1); cur.setFullYear(cur.getFullYear() + delta); }
      else if (per === "Month") { cur.setDate(1); cur.setMonth(cur.getMonth() + delta); }
      else cur.setDate(cur.getDate() + delta * (per === "Week" ? 7 : 1));
      const now = new Date();
      const future = per === "Year" ? cur.getFullYear() > now.getFullYear()
                   : per === "Month" ? (cur.getFullYear() > now.getFullYear() || (cur.getFullYear() === now.getFullYear() && cur.getMonth() > now.getMonth()))
                   : per === "Week" ? mondayOf(cur) > mondayOf(now) : midnight(cur) > midnight(now);
      if (future) return;
      this._hass.callService("input_datetime", "set_datetime", { entity_id: this._cfg.date_entity, date: toStr(cur) });
    }
    _goToday() { if (this._hass) this._hass.callService("input_datetime", "set_datetime", { entity_id: this._cfg.date_entity, date: toStr(new Date()) }); }

    async _loadAvail() { try { const r = await fetch(`${this._cfg.archive_base}/index.json`, { cache: "no-cache" }); if (r.ok) { const j = await r.json(); this._avail = new Set(j.dates || []); if (this._calOpen) this._renderCal(); } } catch (e) { /* not ready */ } }
    _toggleCal() {
      this._calOpen = !this._calOpen;
      if (!this._calOpen) { this._cal.style.display = "none"; return; }
      const d = parse((this._hass.states[this._cfg.date_entity] || {}).state) || new Date();
      this._calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      this._cal.style.display = "block"; this._renderCal(); this._loadAvail();
    }
    _closeCal() { this._calOpen = false; if (this._cal) this._cal.style.display = "none"; }
    _renderCal() {
      const today = midnight(new Date()), todayStr = toStr(new Date());
      const sel = parse((this._hass.states[this._cfg.date_entity] || {}).state);
      const selStr = sel ? toStr(sel) : null;
      const y = this._calMonth.getFullYear(), m = this._calMonth.getMonth();
      const first = new Date(y, m, 1), startCol = (first.getDay() + 6) % 7, dim = new Date(y, m + 1, 0).getDate();
      let html = `<div class="cal-hd"><button class="cal-nav" data-mo="-1">‹</button><span>${first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span><button class="cal-nav" data-mo="1">›</button></div><div class="cal-grid">`;
      for (const w of ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]) html += `<span class="cal-wd">${w}</span>`;
      for (let i = 0; i < startCol; i++) html += `<span></span>`;
      for (let day = 1; day <= dim; day++) {
        const ds = `${y}-${pad(m + 1)}-${pad(day)}`;
        const dis = (midnight(new Date(y, m, day)) > today) || !(ds === todayStr || (this._avail && this._avail.has(ds)));
        html += `<button class="cal-day${ds === selStr ? " sel" : ""}" data-d="${ds}"${dis ? " disabled" : ""}>${day}</button>`;
      }
      this._cal.innerHTML = html + `</div>`;
      this._cal.querySelectorAll(".cal-nav").forEach((b) => b.addEventListener("click", () => { this._calMonth = new Date(y, m + Number(b.dataset.mo), 1); this._renderCal(); }));
      this._cal.querySelectorAll(".cal-day:not([disabled])").forEach((b) => b.addEventListener("click", () => { this._hass.callService("input_datetime", "set_datetime", { entity_id: this._cfg.date_entity, date: b.dataset.d }); this._closeCal(); }));
    }

    _update() {
      if (!this._built || !this._hass) return;
      const pst = this._hass.states[this._cfg.period_entity];
      const cur = pst ? pst.state : "Day";
      this._fsr.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.p === cur));
      this._left.style.display = cur === "Now" ? "none" : "flex";
      if (cur === "Now") this._closeCal();
      const dst = this._hass.states[this._cfg.date_entity];
      const d = (dst && parse(dst.state)) || new Date();
      const wk = cur === "Week", mo = cur === "Month", yr = cur === "Year";
      this._calwrap.style.display = (wk || mo || yr) ? "none" : "";
      if (wk) {
        if (this._calOpen) this._closeCal();
        const mon = mondayOf(d), thisMon = mondayOf(new Date());
        const diff = Math.round((thisMon - mon) / (7 * 86400000));
        this._dateEl.textContent = diff === 0 ? "This Week" : (diff === 1 ? "Last Week" : "Week " + isoWeek(mon));
        const atThis = mon >= thisMon; this._next.disabled = atThis; this._today.disabled = atThis;
      } else if (mo) {
        if (this._calOpen) this._closeCal();
        const now = new Date();
        this._dateEl.textContent = d.toLocaleDateString("en-US", { month: "long" }) + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "");
        const atThis = d.getFullYear() > now.getFullYear() || (d.getFullYear() === now.getFullYear() && d.getMonth() >= now.getMonth()); this._next.disabled = atThis; this._today.disabled = atThis;
      } else if (yr) {
        if (this._calOpen) this._closeCal();
        this._dateEl.textContent = String(d.getFullYear());
        const atThisY = d.getFullYear() >= new Date().getFullYear(); this._next.disabled = atThisY; this._today.disabled = atThisY;
      } else {
        const today = midnight(new Date()), dd = midnight(d);
        this._dateEl.textContent = dd.getTime() === today.getTime() ? "Today" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const atToday = dd.getTime() >= today.getTime(); this._next.disabled = atToday; this._today.disabled = atToday;
      }
      this._sync();
    }
  }
  if (!customElements.get(TAG)) {
    customElements.define(TAG, EnergyHeaderCard);
    window.customCards = window.customCards || [];
    window.customCards.push({ type: TAG, name: "Energy Header Card", description: "Fixed date picker + period tabs for the energy dashboard." });
  }
})();

