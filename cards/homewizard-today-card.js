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
          production: stats.production || ["sensor.cmg1a4201v_lifetime_total_solar_energy", "sensor.sb3_0_1av_41_947_total_yield"],
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
