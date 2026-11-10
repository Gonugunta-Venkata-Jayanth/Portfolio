/* BurnRate dashboard. Runs the simulator through WebAssembly when the build
 * ships burnrate.wasm (static demo), otherwise through POST /api/simulate. */
(() => {
  "use strict";
  const cfg = Object.assign({ wasm: false, live: true }, window.BURNRATE || {});
  const $ = (id) => document.getElementById(id);
  const COLORS = { "fast-burn": "#f85149", "medium-burn": "#ff7a45", "slow-burn": "#d29922", "gradual-burn": "#58a6ff" };
  const DAY = 86400000;
  let meta = { scenarios: [], rules: [] };
  let last = null;
  let range = "incident";

  const fmtPct = (v, d = 2) => (v * 100).toFixed(d) + "%";
  const fmtDur = (ms) => {
    const m = Math.round(ms / 60000);
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60), r = m % 60;
    return h < 48 ? `${h} h${r ? " " + r + " min" : ""}` : (m / 1440).toFixed(1) + " d";
  };
  const parseDur = (s) => {
    const m = /^([\d.]+)(d|h|m|s)$/.exec(s) || /^(\d+)h(\d+)m$/.exec(s);
    if (!m) return 0;
    const u = { d: DAY, h: 3600000, m: 60000, s: 1000 }[m[2]];
    return parseFloat(m[1]) * u;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- engine ----------
  let engine;
  async function loadWasm() {
    const go = new Go();
    const ready = new Promise((res) => window.addEventListener("burnrate-ready", res, { once: true }));
    const resp = await fetch("burnrate.wasm");
    if (!resp.ok) throw new Error("wasm not found");
    const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), go.importObject);
    go.run(instance);
    await ready;
    return {
      name: "Go → WebAssembly (in browser)",
      meta: async () => JSON.parse(window.burnrateMeta()),
      run: async (req) => {
        const out = JSON.parse(window.burnrateSimulate(JSON.stringify(req)));
        if (out.error) throw new Error(out.error);
        return out;
      },
    };
  }
  function apiEngine() {
    return {
      name: "Go API (/api/simulate)",
      meta: async () => {
        const [scenarios, rules] = await Promise.all([fetch("api/scenarios").then((r) => r.json()), fetch("api/rules").then((r) => r.json())]);
        return { scenarios, rules };
      },
      run: async (req) => {
        const r = await fetch("api/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || r.statusText);
        return out;
      },
    };
  }

  // ---------- UI ----------
  function fillScenarios() {
    const sel = $("scenario");
    sel.innerHTML = meta.scenarios.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("") + `<option value="custom">custom incident</option>`;
    sel.value = "brownout";
    describe();
  }
  function describe() {
    const name = $("scenario").value;
    $("custom").hidden = name !== "custom";
    const sc = meta.scenarios.find((s) => s.name === name);
    $("desc").textContent = sc ? sc.description : "Configure one incident starting on day 20 against the same background traffic.";
  }
  function request() {
    const name = $("scenario").value;
    const seed = Math.max(1, parseInt($("seed").value, 10) || 42);
    const base = meta.scenarios.find((s) => s.name === "steady") || meta.scenarios[0];
    let scenario;
    if (name === "custom") {
      scenario = Object.assign({}, base, {
        name: "custom", description: "Custom incident",
        incidents: [{ start_hour: 480, duration_min: +$("dur").value, error_rate: +$("rate").value / 100 }],
        detect_within_min: +$("dur").value,
      });
    } else {
      scenario = Object.assign({}, meta.scenarios.find((s) => s.name === name));
    }
    scenario.seed = seed;
    return { scenario, target: +$("target").value, keep_firing_for: $("keep").value, timeline_points: 2880 };
  }

  async function run(ev) {
    if (ev) ev.preventDefault();
    const btn = document.querySelector(".run");
    btn.disabled = true;
    const t0 = performance.now();
    try {
      last = await engine.run(request());
      last.elapsed = performance.now() - t0;
      render();
    } catch (e) {
      $("kpis").innerHTML = `<div class="kpi bad"><div class="v">Error</div><div class="l">${esc(e.message)}</div></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  function kpi(label, value, cls = "") {
    return `<div class="kpi ${cls}"><div class="v">${value}</div><div class="l">${label}</div></div>`;
  }
  function render() {
    const { report: r, detection: d } = last;
    const spent = r.budget_consumed;
    const pages = r.alerts.filter((a) => a.severity === "page").length;
    $("kpis").innerHTML = [
      kpi("Availability (30 d)", fmtPct(r.availability, 3), r.availability >= r.objective.target ? "good" : "bad"),
      kpi("Error budget spent", fmtPct(spent, 1), spent < 0.5 ? "good" : spent < 1 ? "warn" : "bad"),
      kpi("Alerts (pages)", `${r.alerts.length} (${pages})`, d.false_positives ? "bad" : ""),
      kpi("Time to detect", d.detected ? `${d.time_to_detect_min} min` : last.scenario.incidents.length ? "missed" : "n/a", d.detected ? "good" : last.scenario.incidents.length ? "bad" : ""),
      kpi("Re-fires (flapping)", d.refires, d.refires ? "warn" : "good"),
      kpi("Evaluated", `${(r.events / 1e6).toFixed(2)}M req · ${Math.round(last.elapsed)} ms`),
    ].join("");
    $("alerts").innerHTML = r.alerts.length
      ? r.alerts.map((a) => {
          const f = new Date(a.fired_at), z = a.resolved_at ? new Date(a.resolved_at) : null;
          return `<tr><td><i class="dot" style="background:${COLORS[a.rule] || "#888"}"></i>${esc(a.rule)}</td><td><span class="pill ${esc(a.severity)}">${esc(a.severity)}</span></td>
            <td>${stamp(f)}</td><td>${z ? stamp(z) : "firing"}</td><td>${z ? fmtDur(z - f) : "-"}</td><td>${a.peak_burn}×</td></tr>`;
        }).join("")
      : `<tr><td colspan="6" class="empty">No alerts fired.</td></tr>`;
    draw();
  }
  // Simulated series always start at the simulator epoch (2026-01-01 UTC).
  const start = () => Date.UTC(2026, 0, 1);
  function stamp(d) {
    const ms = d.getTime() - Date.UTC(2026, 0, 1);
    const day = Math.floor(ms / DAY) + 1;
    return `day ${day} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }

  function viewRange() {
    const tl = last.report.timeline;
    const t0 = start(), t1 = new Date(tl[tl.length - 1].t).getTime();
    if (range === "full") return [t0, t1];
    const inc = last.scenario.incidents;
    if (!inc.length) return [t0 + 19 * DAY, t0 + 23 * DAY];
    const s = Math.min(...inc.map((i) => i.start_hour * 3600000));
    const e = Math.max(...inc.map((i) => i.start_hour * 3600000 + i.duration_min * 60000));
    return [Math.max(t0, t0 + s - 6 * 3600000), Math.min(t1, t0 + e + Math.max(12 * 3600000, (e - s) * 0.5))];
  }

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.getAttribute("height") | 0;
    canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "11px system-ui, sans-serif";
    return { ctx, w, h };
  }
  function xAxis(ctx, w, h, pad, a, b) {
    const span = b - a, step = span > 10 * DAY ? 5 * DAY : span > 2 * DAY ? DAY : 6 * 3600000;
    ctx.fillStyle = "#8b98a7"; ctx.strokeStyle = "#1f2a37";
    const base = Date.UTC(2026, 0, 1);
    for (let t = Math.ceil((a - base) / step) * step + base; t <= b; t += step) {
      const x = pad.l + ((t - a) / span) * (w - pad.l - pad.r);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
      const d = new Date(t), lbl = step >= DAY ? `day ${Math.floor((t - base) / DAY) + 1}` : `d${Math.floor((t - base) / DAY) + 1} ${String(d.getUTCHours()).padStart(2, "0")}:00`;
      ctx.fillText(lbl, x - 16, h - 6);
    }
  }
  function draw() {
    if (!last) return;
    const tl = last.report.timeline, rules = last.report.rules;
    const [a, b] = viewRange();
    const pts = tl.filter((p) => { const t = new Date(p.t).getTime(); return t >= a && t <= b; });

    // burn chart, log scale
    let { ctx, w, h } = setup($("burn"));
    const pad = { l: 44, r: 12, t: 10, b: 22 };
    const max = Math.max(20, ...pts.flatMap((p) => Object.values(p.burn)));
    const lo = Math.log10(0.1), hi = Math.log10(max * 1.3);
    const X = (t) => pad.l + ((t - a) / (b - a)) * (w - pad.l - pad.r);
    const Y = (v) => { const l = Math.log10(Math.max(0.1, v)); return h - pad.b - ((l - lo) / (hi - lo)) * (h - pad.t - pad.b); };
    xAxis(ctx, w, h, pad, a, b);
    ctx.fillStyle = "#8b98a7";
    [0.1, 1, 10, 100, 1000].filter((v) => Math.log10(v) <= hi).forEach((v) => {
      ctx.strokeStyle = "#1f2a37"; ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
      ctx.fillText(v + "×", 6, Y(v) + 4);
    });
    // incident shading
    last.scenario.incidents.forEach((i) => {
      const s = start() + i.start_hour * 3600000, e = s + i.duration_min * 60000;
      ctx.fillStyle = "rgba(248,81,73,0.08)";
      ctx.fillRect(X(Math.max(a, s)), pad.t, Math.max(1, X(Math.min(b, e)) - X(Math.max(a, s))), h - pad.t - pad.b);
    });
    rules.forEach((r) => {
      const c = COLORS[r.name] || "#888";
      ctx.setLineDash([4, 4]); ctx.strokeStyle = c + "99"; ctx.beginPath(); ctx.moveTo(pad.l, Y(r.factor)); ctx.lineTo(w - pad.r, Y(r.factor)); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.beginPath();
      pts.forEach((p, i) => { const x = X(new Date(p.t).getTime()), y = Y(p.burn[r.name]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke(); ctx.lineWidth = 1;
    });
    $("legend").innerHTML = rules.map((r) => `<span><i style="background:${COLORS[r.name]}"></i>${esc(r.name)} (${r.long_window}, threshold ${r.factor}×)</span>`).join("") + `<span><i style="background:rgba(248,81,73,.35)"></i>incident</span>`;

    // budget chart
    ({ ctx, w, h } = setup($("budget")));
    const Yb = (v) => h - pad.b - ((Math.max(-0.5, Math.min(1, v)) + 0.5) / 1.5) * (h - pad.t - pad.b);
    xAxis(ctx, w, h, pad, a, b);
    ctx.fillStyle = "#8b98a7";
    [1, 0.5, 0, -0.5].forEach((v) => { ctx.strokeStyle = v === 0 ? "#5c2523" : "#1f2a37"; ctx.beginPath(); ctx.moveTo(pad.l, Yb(v)); ctx.lineTo(w - pad.r, Yb(v)); ctx.stroke(); ctx.fillText(Math.round(v * 100) + "%", 6, Yb(v) + 4); });
    ctx.strokeStyle = "#3fb950"; ctx.lineWidth = 1.8; ctx.beginPath();
    pts.forEach((p, i) => { const x = X(new Date(p.t).getTime()), y = Yb(p.budget_remaining); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.lineWidth = 1;
  }

  function renderRules() {
    $("rules").innerHTML = meta.rules.map((r) => {
      const spent = (r.factor * parseDur(r.long_window)) / (30 * DAY);
      return `<tr><td><i class="dot" style="background:${COLORS[r.name]}"></i>${esc(r.name)}</td><td><span class="pill ${esc(r.severity)}">${esc(r.severity)}</span></td><td>${esc(r.long_window)}</td><td>${esc(r.short_window)}</td><td>${r.factor}×</td><td>${fmtPct(spent, 0)}</td></tr>`;
    }).join("");
  }

  // ---------- live targets (server mode only) ----------
  async function live() {
    try {
      const r = await fetch("api/targets");
      if (!r.ok) return;
      const targets = await r.json();
      $("live").hidden = false;
      $("targets").innerHTML = targets.length ? targets.map((t) => {
        const up = t.last && t.last.ok;
        const firing = t.firing.length ? t.firing.map((a) => `<span class="pill ${esc(a.severity)}">${esc(a.rule)}</span>`).join(" ") : `<span class="muted">no alerts</span>`;
        return `<div class="target"><div class="n"><span class="dot ${t.last ? (up ? "up" : "down") : ""}"></span>${esc(t.name)}</div>
          <div class="u">${esc(t.url)}</div>
          <div>SLO ${fmtPct(t.objective.target, 2)} · ${esc(t.objective.window)}</div>
          <div>Availability <b>${t.events ? fmtPct(t.availability, 3) : "-"}</b> · Budget left <b>${!t.events ? "-" : t.budget_remaining <= 0 ? "exhausted" : fmtPct(t.budget_remaining, 1)}</b></div>
          <div class="muted">${t.last ? `last ${t.last.status || "error"} in ${t.last.latency_ms.toFixed(0)} ms` : "no data yet"} · ${t.events} checks</div>
          <div>${firing}</div></div>`;
      }).join("") : `<div class="empty">No targets configured.</div>`;
      $("live-updated").textContent = "updated " + new Date().toLocaleTimeString();
      setTimeout(live, 15000);
    } catch (_) { /* static demo: no API */ }
  }

  // ---------- boot ----------
  async function boot() {
    try {
      engine = cfg.wasm ? await loadWasm() : apiEngine();
    } catch (e) {
      engine = apiEngine();
    }
    $("engine").textContent = "engine: " + engine.name;
    $("engine").classList.add("ok");
    meta = await engine.meta();
    fillScenarios();
    renderRules();
    $("scenario").addEventListener("change", () => { describe(); run(); });
    ["target", "keep"].forEach((id) => $(id).addEventListener("change", () => run()));
    $("rate").addEventListener("input", () => ($("rate-out").textContent = $("rate").value + "%"));
    $("dur").addEventListener("input", () => ($("dur-out").textContent = fmtDur($("dur").value * 60000)));
    $("controls").addEventListener("submit", run);
    document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
      range = b.dataset.range; draw();
    }));
    window.addEventListener("resize", draw);
    if (cfg.live) live();
    run();
  }
  boot();
})();
