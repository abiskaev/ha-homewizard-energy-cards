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
