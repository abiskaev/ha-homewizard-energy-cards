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
