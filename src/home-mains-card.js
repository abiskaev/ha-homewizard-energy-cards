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
