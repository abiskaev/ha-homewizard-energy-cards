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
