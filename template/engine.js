/* =====================================================================
   GENERIC DASHBOARD ENGINE
   Reads window.DASHBOARD_SPEC + data, builds the layout, renders every
   section, and wires the filters. Nothing here is domain-specific —
   all of that lives in spec.js. The builder agent only ever writes a
   spec; this engine stays the same.

   To "scale to bespoke" later: add a new entry to the SECTION registry
   (and, if needed, a new metric kind) — the rest is untouched.
   ===================================================================== */
(() => {
  "use strict";

  const SPEC = window.DASHBOARD_SPEC;
  const state = { year: null, view: null, team: "All" };
  let MODEL = null;
  const charts = {};

  // ---------- small utilities ----------
  const $ = (id) => document.getElementById(id);
  const distinct = (arr) => [...new Set(arr)];
  function hash(s, n) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % n; }
  // normalize a cell value: trim strings; turn numeric text ("2024", " 6 ") into a real
  // number so years/months/IDs from Excel compare and sort consistently.
  function coerce(v) {
    if (typeof v !== "string") return v;
    const t = v.trim();
    if (t !== "" && !isNaN(t) && isFinite(Number(t))) return Number(t);
    return t;
  }
  function interp(str, tok) { return String(str || "").replace(/\{(\w+)\}/g, (_, k) => (tok && k in tok ? tok[k] : `{${k}}`)); }
  const fmt = (v, d) => Number(v).toFixed(d == null ? SPEC.metric.decimals : d);

  function orderedDistinct(values, preferred) {
    const seen = distinct(values).filter((v) => v !== undefined && v !== null && v !== "");
    if (!preferred) return seen;
    return [...preferred.filter((v) => seen.includes(v)), ...seen.filter((v) => !preferred.includes(v))];
  }

  function colorForValue(dim, value, i) {
    const fixed = (SPEC.palette.byValue || {})[value];
    if (fixed) return fixed;
    const list = SPEC.palette.series;
    if (i != null) return list[i % list.length];
    const idx = MODEL.dimValues[dim] ? MODEL.dimValues[dim].indexOf(value) : -1;
    return list[(idx >= 0 ? idx : hash(value, list.length)) % list.length];
  }

  // ---------- 1. MODEL ----------
  function resolveDim(def, merged) {
    if (def.template) {
      return def.template.replace(/\{(\w+)\}/g, (_, c) => (merged[c] == null ? "" : String(merged[c]).trim()));
    }
    return coerce(merged[def.from]);
  }

  function buildModel(spec, raw) {
    const m = spec.model;
    const fact = raw[m.fact] || [];
    const lut = {};
    // key dimension tables by a coerced join key so text/number id mismatches still match
    for (const j of m.joins || []) lut[j.table] = new Map((raw[j.table] || []).map((r) => [coerce(r[j.on]), r]));

    const rows = fact.map((fr) => {
      const merged = Object.assign({}, fr);
      for (const j of m.joins || []) { const jr = lut[j.table].get(coerce(fr[j.on])); if (jr) Object.assign(merged, jr); }
      const row = { value: Number(fr[m.measure]) || 0 };
      for (const [dim, def] of Object.entries(m.dimensions)) row[dim] = resolveDim(def, merged);
      return row;
    });

    const dimValues = {};
    for (const dim of Object.keys(m.dimensions))
      dimValues[dim] = orderedDistinct(rows.map((r) => r[dim]), (m.order || {})[dim]);

    const years = distinct(rows.map((r) => r.year)).sort((a, b) => a - b);

    // months per period (for fte-equivalent averaging)
    const p = m.period || {};
    const mpy = {};
    const src = (p.table && raw[p.table] && raw[p.table].length) ? raw[p.table] : null;
    if (src) src.forEach((r) => { const y = coerce(r[p.yearCol]); (mpy[y] = mpy[y] || new Set()).add(coerce(r[p.monthCol])); });
    Object.keys(mpy).forEach((y) => (mpy[y] = mpy[y].size));
    const months = (y) => mpy[y] || p.fallback || 12;

    return { spec, raw, rows, dimValues, years, months };
  }

  function metricValue(sumMeasure, year) {
    const mt = SPEC.metric;
    if (mt.kind === "fte_equivalent") return (sumMeasure / mt.scale) / MODEL.months(year);
    if (mt.kind === "sum") return sumMeasure / (mt.scale || 1);
    return sumMeasure;
  }

  function groupSum(year, dim, filter) {
    const map = new Map();
    for (const r of MODEL.rows) {
      if (year != null && r.year !== year) continue;
      if (filter && !filter(r)) continue;
      map.set(r[dim], (map.get(r[dim]) || 0) + r.value);
    }
    return map;
  }

  const dimLabel = (dim) => (SPEC.model.dimensions[dim] || {}).label || dim;

  // shared token context for {year}, {yearSpan}, {viewWord}, etc.
  function tokens(extra) {
    const yrs = MODEL.years;
    const viewOpt = SPEC.filters.view && SPEC.filters.view.options.find((o) => o.id === state.view);
    return Object.assign({
      year: state.year,
      yearSpan: yrs.length ? `FY${yrs[0]} – FY${yrs[yrs.length - 1]}` : "",
      viewWord: viewOpt ? viewOpt.label.replace(/^By\s+/i, "") : "",
      viewSub: viewOpt ? viewOpt.sub : "",
    }, extra || {});
  }

  // ---------- 2. CHART HELPER ----------
  function chart(id) {
    if (!charts[id]) charts[id] = echarts.init($(id));
    return charts[id];
  }
  const axisLabelColor = { color: "#6b7280" };
  const yAxis = () => ({ type: "value", name: SPEC.metric.label, nameTextStyle: { color: "#9ca3af" },
    axisLabel: axisLabelColor, splitLine: { lineStyle: { color: "#eef0f3" } } });
  const vfmt = (v) => `${v} ${SPEC.metric.unit}`;

  // ---------- 3. KPI helpers ----------
  const kpiHtml = (c) =>
    `<div class="kpi"><div class="kpi-label">${c.label}</div>` +
    `<div class="kpi-value${c.small ? " sm" : ""}">${c.value}</div>` +
    `<div class="kpi-cap">${c.cap}</div></div>`;

  function overviewKpi(item, tok) {
    const y = state.year;
    if (item.kind === "total_metric") {
      const total = [...groupSum(y, Object.keys(SPEC.model.dimensions)[0]).values()].reduce((a, b) => a + b, 0);
      return { label: item.label, value: fmt(metricValue(total, y)), cap: interp(item.caption, tok) };
    }
    if (item.kind === "dim_count")
      return { label: item.label, value: String(MODEL.dimValues[item.dim].length), cap: interp(item.caption, tok) };
    if (item.kind === "largest_dim") {
      const sums = groupSum(y, item.dim);
      const cats = MODEL.dimValues[item.dim];
      const vals = cats.map((c) => metricValue(sums.get(c) || 0, y));
      const i = vals.indexOf(Math.max(...vals));
      return { label: item.label, small: item.small, value: cats[i] || "—", cap: `${fmt(vals[i] || 0)} ${SPEC.metric.unit}s` };
    }
    if (item.kind === "avg_per_dim") {
      const sums = groupSum(y, item.dim);
      const cats = MODEL.dimValues[item.dim];
      const total = cats.reduce((a, c) => a + metricValue(sums.get(c) || 0, y), 0);
      return { label: item.label, value: fmt(cats.length ? total / cats.length : 0), cap: interp(item.caption, tok) };
    }
    return { label: item.label, value: "—", cap: "" };
  }

  // ---------- 4. SECTION RENDERERS ----------
  const SECTION = {
    kpis(s) {
      const tok = tokens();
      $(s.id).innerHTML = s.items.map((it) => kpiHtml(overviewKpi(it, tok))).join("");
    },

    row(s) { s.children.forEach((c) => SECTION[c.type](c)); },

    bar(s) {
      const tok = tokens();
      if ($(`${s.id}-title`)) $(`${s.id}-title`).textContent = interp(s.title, tok);
      if ($(`${s.id}-sub`)) $(`${s.id}-sub`).textContent = interp(s.sub, tok);
      const dim = s.dimFromView ? viewDim() : s.xDim;
      const cats = MODEL.dimValues[dim];
      const sums = groupSum(state.year, dim);
      const data = cats.map((c, i) => ({
        value: +metricValue(sums.get(c) || 0, state.year).toFixed(2),
        itemStyle: { color: colorForValue(dim, c) },
      }));
      chart(s.id).setOption({
        grid: { left: 48, right: 18, top: 24, bottom: 56 },
        tooltip: { trigger: "axis", valueFormatter: vfmt },
        xAxis: { type: "category", data: cats, axisTick: { show: false },
          axisLabel: { color: "#4b5563", rotate: cats.some((c) => String(c).length > 5) ? 25 : 0 } },
        yAxis: yAxis(),
        series: [{ type: "bar", data, barMaxWidth: 54, itemStyle: { borderRadius: [4, 4, 0, 0] } }],
      }, true);
    },

    line(s) {
      const tok = tokens();
      if ($(`${s.id}-title`)) $(`${s.id}-title`).textContent = interp(s.title, tok);
      if ($(`${s.id}-sub`)) $(`${s.id}-sub`).textContent = interp(s.sub, tok);
      const dim = s.dimFromView ? viewDim() : s.xDim;
      const cats = MODEL.dimValues[dim];
      const months = distinct(MODEL.rows.map((r) => `${r.year}-${String(r.month).padStart(2, "0")}`)).sort();
      const acc = new Map();
      for (const r of MODEL.rows) {
        const mk = `${r.year}-${String(r.month).padStart(2, "0")}`;
        if (!acc.has(r[dim])) acc.set(r[dim], new Map());
        const mm = acc.get(r[dim]); mm.set(mk, (mm.get(mk) || 0) + r.value);
      }
      const series = cats.map((c, i) => ({
        name: c, type: "line", smooth: true, symbol: "circle", symbolSize: 6,
        lineStyle: { width: 2.5 }, color: colorForValue(dim, c, s.dimFromView ? i : null),
        data: months.map((mk) => +((acc.get(c)?.get(mk) || 0) / SPEC.metric.scale).toFixed(2)),
      }));
      chart(s.id).setOption({
        grid: { left: 48, right: 18, top: 50, bottom: 40 },
        legend: { type: "scroll", top: 0, textStyle: { color: "#4b5563" }, icon: "roundRect", itemWidth: 12, itemHeight: 12 },
        tooltip: { trigger: "axis", valueFormatter: vfmt },
        xAxis: { type: "category", data: months, axisTick: { show: false },
          axisLabel: { color: "#6b7280", interval: Math.ceil(months.length / 8) } },
        yAxis: yAxis(), series,
      }, true);
    },

    "stacked-bar"(s) {
      const tok = tokens();
      if ($(`${s.id}-sub`)) $(`${s.id}-sub`).textContent = interp(s.sub, tok);
      const y = state.year;
      const xs = MODEL.dimValues[s.xDim];
      const stacks = MODEL.dimValues[s.stackDim];
      const acc = new Map();
      for (const r of MODEL.rows) {
        if (r.year !== y) continue;
        if (!acc.has(r[s.xDim])) acc.set(r[s.xDim], new Map());
        const mm = acc.get(r[s.xDim]); mm.set(r[s.stackDim], (mm.get(r[s.stackDim]) || 0) + r.value);
      }
      const series = stacks.map((st, i) => ({
        name: st, type: "bar", stack: "total", color: colorForValue(s.stackDim, st, i),
        emphasis: { focus: "series" },
        data: xs.map((x) => +metricValue(acc.get(x)?.get(st) || 0, y).toFixed(2)),
      }));
      chart(s.id).setOption({
        grid: { left: 48, right: 18, top: 50, bottom: 30 },
        legend: { top: 0, textStyle: { color: "#4b5563" }, icon: "roundRect", itemWidth: 12, itemHeight: 12 },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: vfmt },
        xAxis: { type: "category", data: xs, axisTick: { show: false }, axisLabel: { color: "#4b5563" } },
        yAxis: yAxis(), series,
      }, true);
    },

    "grouped-bar"(s) {
      const sec = $(`${s.id}-section`);
      const cmp = s.compare, cmpRows = MODEL.raw[cmp.table] || [];
      const has = cmpRows.length > 0;
      if (sec) sec.style.display = has ? "" : "none";
      if (!has) return;
      const tok = tokens();
      if ($(`${s.id}-sub`)) $(`${s.id}-sub`).textContent = interp(s.sub, tok);
      const y = state.year;

      // map compare-key -> dim label, by reading any fact row
      const keyToDim = new Map();
      for (const r of MODEL.rows) keyToDim.set(r[`__${cmp.on}`] ?? null, null); // placeholder
      // build dim label per compare row via the joined assets: reuse fact dim mapping
      const keyDim = buildKeyToDim(cmp);
      // demand per dim
      const demand = new Map();
      for (const d of cmpRows) {
        if (d[cmp.yearCol || "Year"] !== y) continue;
        const label = keyDim.get(d[cmp.on]);
        if (label == null) continue;
        demand.set(label, (demand.get(label) || 0) + (Number(d[cmp.measure]) || 0));
      }
      const supplySum = groupSum(y, cmp.dim);
      const cats = MODEL.dimValues[cmp.dim];
      const rows = cats.map((c) => ({
        label: c,
        demand: (demand.get(c) || 0) / SPEC.metric.scale / MODEL.months(y),
        supply: metricValue(supplySum.get(c) || 0, y),
      })).sort((a, b) => b.demand - a.demand);

      // KPIs
      if (s.kpis && $(`${s.id}-kpis`)) {
        const totD = rows.reduce((a, b) => a + b.demand, 0);
        const totS = rows.reduce((a, b) => a + b.supply, 0);
        const net = totS - totD;
        const under = rows.filter((r) => r.supply - r.demand < -0.05).length;
        const ktok = tokens({ n: rows.length, xDimLabel: dimLabel(cmp.dim) });
        const out = s.kpis.map((k) => {
          if (k.kind === "compare_total") return { label: k.label, value: fmt(k.side === "demand" ? totD : totS), cap: interp(k.caption, ktok) };
          if (k.kind === "compare_net") return { label: net >= 0 ? "Net surplus" : "Net shortfall", value: `${net >= 0 ? "+" : ""}${fmt(net)}`, cap: interp(k.caption, ktok) };
          if (k.kind === "compare_under") return { label: k.label, value: String(under), cap: interp(k.caption, ktok) };
          return { label: k.label, value: "—", cap: "" };
        });
        $(`${s.id}-kpis`).innerHTML = out.map(kpiHtml).join("");
      }

      chart(s.id).setOption({
        grid: { left: 48, right: 18, top: 50, bottom: 64 },
        legend: { top: 0, textStyle: { color: "#4b5563" }, icon: "roundRect", itemWidth: 12, itemHeight: 12 },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: vfmt },
        xAxis: { type: "category", data: rows.map((r) => r.label), axisTick: { show: false },
          axisLabel: { color: "#4b5563", rotate: rows.some((r) => String(r.label).length > 9) ? 20 : 0 } },
        yAxis: yAxis(),
        series: [
          { name: s.seriesA.label, type: "bar", barGap: "10%", barMaxWidth: 32, color: s.seriesA.color,
            itemStyle: { borderRadius: [4, 4, 0, 0] }, data: rows.map((r) => +r.demand.toFixed(2)) },
          { name: s.seriesB.label, type: "bar", barMaxWidth: 32, color: s.seriesB.color,
            itemStyle: { borderRadius: [4, 4, 0, 0] }, data: rows.map((r) => +r.supply.toFixed(2)) },
        ],
      }, true);
    },

    table(s) {
      const y = state.year;
      const tbody = $(s.id).querySelector("tbody");
      tbody.innerHTML = "";
      for (const grp of MODEL.dimValues[s.groupDim]) {
        const byRow = groupSum(y, s.rowDim, (r) => r[s.groupDim] === grp);
        const total = [...byRow.values()].reduce((a, b) => a + b, 0);
        if (total === 0) continue;
        const col = colorForValue(s.groupDim, grp);
        for (const [rowVal, sum] of [...byRow.entries()].sort((a, b) => b[1] - a[1])) {
          const share = total ? (sum / total) * 100 : 0;
          const tr = document.createElement("tr");
          tr.innerHTML = s.columns.map((c) => {
            if (c.kind === "group-badge") return `<td><span class="badge" style="background:${col}">${grp}</span></td>`;
            if (c.kind === "row-label") return `<td>${rowVal}</td>`;
            if (c.kind === "metric") return `<td>${fmt(metricValue(sum, y))}</td>`;
            if (c.kind === "share-bar") return `<td><div class="pct-cell"><span>${share.toFixed(0)}%</span>` +
              `<div class="pct-track"><div class="pct-bar" style="width:${share}%;color:${col}"></div></div></div></td>`;
            return `<td></td>`;
          }).join("");
          tbody.appendChild(tr);
        }
      }
    },

    cards(s) {
      const y = state.year;
      // team filter chips
      if (s.teamFilter && $(`${s.id}-teamchips`)) {
        const wrap = $(`${s.id}-teamchips`); wrap.innerHTML = "";
        ["All", ...MODEL.dimValues[s.groupDim]].forEach((t) => {
          const b = document.createElement("button");
          b.className = "chip" + (t === state.team ? " active" : "");
          b.textContent = t;
          b.onclick = () => { state.team = t; SECTION.cards(s); };
          wrap.appendChild(b);
        });
      }
      // per-entity aggregation
      const map = new Map();
      for (const r of MODEL.rows) {
        if (r.year !== y) continue;
        const id = r[s.entityIdDim];
        if (!map.has(id)) map.set(id, { name: r[s.entityNameDim], group: r[s.groupDim], items: new Map() });
        const e = map.get(id); e.items.set(r[s.itemDim], (e.items.get(r[s.itemDim]) || 0) + r.value);
      }
      const months = MODEL.months(y);
      let entities = [...map.values()].map((e) => {
        const items = [...e.items.entries()].map(([k, v]) => ({ label: k, pct: v / months })).sort((a, b) => b.pct - a.pct);
        const allocated = items.reduce((a, b) => a + b.pct, 0);
        return { name: e.name, group: e.group, items, allocated, available: Math.max(0, s.capacity - allocated) };
      });
      if (state.team !== "All") entities = entities.filter((e) => e.group === state.team);

      // KPIs
      if (s.kpis && $(`${s.id}-kpis`)) {
        const shown = entities.length;
        const full = entities.filter((e) => e.allocated >= s.capacity - 0.5).length;
        const cap = entities.filter((e) => e.available > 0.5).length;
        const avg = shown ? entities.reduce((a, b) => a + b.available, 0) / shown : 0;
        const vals = { entity_count: [String(shown)], entity_full: [String(full)], entity_hascap: [String(cap)], entity_avgcap: [`${avg.toFixed(0)}%`] };
        $(`${s.id}-kpis`).innerHTML = s.kpis.map((k) =>
          kpiHtml({ label: k.label, value: (vals[k.kind] || ["—"])[0], cap: k.caption })).join("");
      }

      // cards grouped by team
      const host = $(`${s.id}-list`); host.innerHTML = "";
      const groups = state.team === "All" ? MODEL.dimValues[s.groupDim] : [state.team];
      for (const g of groups) {
        const grp = entities.filter((e) => e.group === g);
        if (!grp.length) continue;
        const lbl = document.createElement("div");
        lbl.className = "group-label";
        lbl.innerHTML = `${g} <span class="gl-count">${grp.length} FTEs</span>`;
        host.appendChild(lbl);
        grp.forEach((e) => host.appendChild(entityCard(e, s)));
      }
      if (!host.children.length) host.innerHTML = `<p class="muted">No items in this view.</p>`;
    },
  };

  // helper for grouped-bar: map a compare table's key to the dim label, using the joined fact rows
  function buildKeyToDim(cmp) {
    // find which join carries the key, and the dimension built from that table
    const m = SPEC.model;
    const join = (m.joins || []).find((j) => j.on === cmp.on);
    const map = new Map();
    if (!join) return map;
    const jr = MODEL.raw[join.table] || [];
    const dimDef = m.dimensions[cmp.dim];
    for (const row of jr) map.set(row[cmp.on], resolveDim(dimDef, row));
    return map;
  }

  function entityCard(e, s) {
    const col = colorForValue(s.groupDim, e.group);
    const el = document.createElement("div");
    el.className = "person";
    const initials = String(e.name).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    let rows = e.items.map((it, i) => assignRow(it.label, it.pct, SPEC.palette.series[i % SPEC.palette.series.length])).join("");
    if (e.available > 0.5) rows += assignRow(s.capacityLabel, e.available, "#4a9e3f", "avail");
    const total = Math.min(s.capacity, e.allocated);
    el.innerHTML =
      `<div class="person-head"><div class="avatar" style="background:${col}">${initials}</div>` +
      `<div><div class="person-name">${e.name}</div>` +
      `<div class="person-meta">${e.items.length} assignment${e.items.length === 1 ? "" : "s"}` +
      `${e.available > 0.5 ? ` · ${e.available.toFixed(0)}% available` : ""}</div></div>` +
      `<span class="badge person-badge" style="background:${col}">${e.group}</span></div>` + rows +
      `<div class="assign-divider"></div>` +
      `<div class="assign-row"><div class="assign-label total">${s.totalLabel}</div>` +
      `<div class="assign-track"><div class="assign-fill" style="width:${total}%;background:#4a9e3f"></div></div>` +
      `<div class="assign-pct total">${e.allocated.toFixed(0)}%</div></div>`;
    return el;
  }

  function assignRow(label, pct, color, cls = "") {
    return `<div class="assign-row"><div class="assign-label ${cls}">${label}</div>` +
      `<div class="assign-track"><div class="assign-fill" style="width:${Math.min(100, pct)}%;background:${color}"></div></div>` +
      `<div class="assign-pct">${pct.toFixed(0)}%</div></div>`;
  }

  // ---------- 5. LAYOUT (build DOM from spec) ----------
  function viewDim() {
    const v = SPEC.filters.view;
    const opt = v && v.options.find((o) => o.id === state.view);
    return opt ? opt.dim : Object.keys(SPEC.model.dimensions)[0];
  }

  function head(title, subId, sub) {
    return `<h3 class="card-title"${title.idAttr || ""}>${title.text}</h3>` +
      `<p class="card-sub" id="${subId}">${sub || ""}</p>`;
  }

  function buildLayout() {
    const root = $("sections"); root.innerHTML = "";
    for (const s of SPEC.sections) root.insertAdjacentHTML("beforeend", sectionHtml(s));
  }

  function chartCard(c, tall) {
    return `<div class="card">` +
      `<h3 class="card-title" id="${c.id}-title">${c.title || ""}</h3>` +
      `<p class="card-sub" id="${c.id}-sub">${c.sub || ""}</p>` +
      `<div id="${c.id}" class="chart${tall ? " chart-tall" : ""}"></div></div>`;
  }

  function sectionHtml(s) {
    switch (s.type) {
      case "kpis": return `<section class="kpi-row" id="${s.id}"></section>`;
      case "row": return `<section class="grid-2" id="${s.id}">${s.children.map((c) => chartCard(c, false)).join("")}</section>`;
      case "bar":
      case "line":
      case "stacked-bar": return `<section>${chartCard(s, true)}</section>`;
      case "grouped-bar":
        return `<section class="card" id="${s.id}-section">` +
          `<h3 class="card-title">${s.title}</h3><p class="card-sub" id="${s.id}-sub">${s.sub || ""}</p>` +
          `<div id="${s.id}-kpis" class="kpi-row kpi-row-tight"></div>` +
          `<div id="${s.id}" class="chart chart-tall"></div></section>`;
      case "table":
        return `<section class="card"><h3 class="card-title">${s.title}</h3>` +
          `<p class="card-sub">${s.sub || ""}</p><div class="table-wrap">` +
          `<table id="${s.id}" class="detail-table"><thead><tr>${s.columns.map((c) => `<th>${c.header}</th>`).join("")}` +
          `</tr></thead><tbody></tbody></table></div></section>`;
      case "cards":
        return `<section class="card"><div class="card-head-row"><div>` +
          `<h3 class="card-title">${s.title}</h3><p class="card-sub">${s.sub || ""}</p></div></div>` +
          (s.teamFilter ? `<div class="filter-group" style="margin:14px 0 4px;"><span class="filter-label">Team:</span><div id="${s.id}-teamchips" class="chips"></div></div>` : "") +
          `<div id="${s.id}-kpis" class="kpi-row kpi-row-tight"></div><div id="${s.id}-list"></div></section>`;
      default: return "";
    }
  }

  // ---------- 6. FILTERS ----------
  function buildFilters() {
    const f = SPEC.filters;
    let html = `<div class="filter-group"><span class="filter-label">${(f.year && f.year.label) || "Year"}:</span><div id="f-year" class="chips"></div></div>`;
    if (f.view) html += `<div class="filter-group"><span class="filter-label">${f.view.label}:</span><div id="f-view" class="chips"></div></div>`;
    $("filters").innerHTML = html;
  }

  function renderFilters() {
    const yw = $("f-year"); yw.innerHTML = "";
    MODEL.years.forEach((y) => {
      const b = document.createElement("button");
      b.className = "chip" + (y === state.year ? " active" : "");
      b.textContent = y; b.onclick = () => { state.year = y; renderAll(); };
      yw.appendChild(b);
    });
    if (SPEC.filters.view) {
      const vw = $("f-view"); vw.innerHTML = "";
      SPEC.filters.view.options.forEach((o) => {
        const b = document.createElement("button");
        b.className = "chip" + (o.id === state.view ? " active" : "");
        b.textContent = o.label; b.onclick = () => { state.view = o.id; renderAll(); };
        vw.appendChild(b);
      });
    }
  }

  // ---------- 7. ORCHESTRATION ----------
  function renderHeader() {
    document.title = SPEC.title;
    $("app-title").textContent = SPEC.title;
    $("app-subtitle").textContent = interp(SPEC.subtitle, tokens());
    $("data-status").textContent =
      `${MODEL.rows.length} records · ${MODEL.years.length} years · ` +
      Object.keys(SPEC.model.dimensions).slice(0, 1).map(() => "").join("") +
      `${MODEL.dimValues[Object.keys(SPEC.model.dimensions)[0]].length} ${dimLabel(Object.keys(SPEC.model.dimensions)[0]).toLowerCase()}s`;
  }

  function renderAll() {
    renderFilters();
    $("app-subtitle").textContent = interp(SPEC.subtitle, tokens());
    // Render each section in isolation: a failure in one must not blank the others.
    const failed = [];
    for (const s of SPEC.sections) {
      try {
        SECTION[s.type](s);
      } catch (err) {
        console.error(`[dashboard] section "${s.id || s.type}" failed to render:`, err);
        failed.push(s.id || s.type);
      }
    }
    const status = $("data-status");
    if (status && failed.length) {
      status.innerHTML = `<span style="color:#9e2b50">⚠ ${failed.length} section(s) could not render: ` +
        failed.join(", ") + `. Check the browser console — usually a data issue (Year/Month not numeric, ` +
        `or an FTE_ID / Asset_ID with no matching row).</span>`;
    }
  }

  function loadModel(raw) {
    MODEL = buildModel(SPEC, raw);
    state.year = MODEL.years[MODEL.years.length - 1] || null;
    state.view = SPEC.filters.view ? SPEC.filters.view.default : null;
    state.team = "All";
    buildFilters();
    buildLayout();
    renderHeader();
    renderAll();
  }

  // ---------- 8. UPLOAD / EXPORT / BOOT ----------
  function handleFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const raw = {};
        wb.SheetNames.forEach((n) => (raw[n] = XLSX.utils.sheet_to_json(wb.Sheets[n])));
        if (!raw[SPEC.model.fact]) { alert(`Workbook is missing the "${SPEC.model.fact}" sheet.`); return; }
        loadModel(raw);
      } catch (err) { console.error(err); alert("Could not read that file. Use the expected .xlsx template."); }
    };
    reader.readAsArrayBuffer(file);
  }

  $("file-input").addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  $("btn-print").addEventListener("click", () => window.print());
  window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));

  const DATA = window.DASHBOARD_DATA || window.SAMPLE_DATA;
  if (DATA) loadModel(DATA);
  else $("app-subtitle").textContent = "Upload a workbook to begin.";
})();
