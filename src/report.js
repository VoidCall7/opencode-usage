"use strict";
const fs = require("fs");

function readRecords(file) {
  const records = [];
  let bad = 0;
  if (!fs.existsSync(file)) return { records, bad };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      records.push(JSON.parse(s));
    } catch {
      bad++;
    }
  }
  return { records, bad };
}

function dedupe(records) {
  const byId = new Map();
  const rest = [];
  for (const r of records) {
    if (r && r.messageID) byId.set(r.messageID, r);
    else rest.push(r);
  }
  return rest.concat([...byId.values()]);
}

function localDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadPrices(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"];

function estimateCost(tokens, price) {
  let sum = 0;
  for (const k of TOKEN_KEYS) sum += (tokens[k] || 0) * (price[k] || 0);
  return sum / 1e6;
}

// 单条记录的有效成本：override 强制按价格表算；自带 cost>0 直接用；否则有价格条目则估算；否则 0
function resolveCost(r, price) {
  const t = r.tokens || {};
  if (price && price.override) return estimateCost(t, price);
  if ((r.cost || 0) > 0) return r.cost;
  if (price) return estimateCost(t, price);
  return r.cost || 0;
}

const emptyAcc = () => ({
  requests: 0, input: 0, output: 0, reasoning: 0,
  cacheRead: 0, cacheWrite: 0, total: 0, cost: 0,
});

function addRecord(acc, r, price) {
  const t = r.tokens || {};
  acc.requests++;
  acc.input += t.input || 0;
  acc.output += t.output || 0;
  acc.reasoning += t.reasoning || 0;
  acc.cacheRead += t.cacheRead || 0;
  acc.cacheWrite += t.cacheWrite || 0;
  acc.total += (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
  acc.cost += resolveCost(r, price);
}

function aggregate(records, prices) {
  const totals = emptyAcc();
  const byModel = {};
  const byDate = {};
  const byProject = {};
  for (const r of records) {
    const key = `${r.providerID || ""}/${r.modelID || ""}`;
    const price = prices[key];
    addRecord(totals, r, price);
    addRecord((byModel[key] = byModel[key] || emptyAcc()), r, price);
    addRecord((byDate[localDate(r.time)] = byDate[localDate(r.time)] || emptyAcc()), r, price);
    addRecord((byProject[r.projectPath || "(unknown)"] = byProject[r.projectPath || "(unknown)"] || emptyAcc()), r, price);
  }
  const dates = Object.keys(byDate).sort();
  return {
    range: { from: dates[0] || null, to: dates[dates.length - 1] || null },
    totals, byModel, byDate, byProject,
    bad: 0,
  };
}

const fmt = (n) => n.toLocaleString("en-US");
const fmtCost = (c) => "$" + c.toFixed(4);
const pct = (part, whole) => (whole > 0 ? ((part / whole) * 100).toFixed(1) + "%" : "0.0%");

function renderText(summary) {
  const lines = [];
  lines.push(
    `OpenCode Token 用量报告` +
      (summary.range.from ? `（${summary.range.from} ~ ${summary.range.to}）` : "（无数据）")
  );
  if (summary.bad > 0) lines.push(`（跳过坏行：${summary.bad}）`);
  lines.push(
    "模型".padEnd(32) + "次数".padStart(6) + "input".padStart(12) +
    "output".padStart(12) + "cache".padStart(12) + "合计".padStart(12) +
    "cost".padStart(12) + "input%".padStart(9) + "output%".padStart(9)
  );
  for (const [key, a] of Object.entries(summary.byModel)) {
    lines.push(
      key.padEnd(32) + String(a.requests).padStart(6) + fmt(a.input).padStart(12) +
      fmt(a.output).padStart(12) + fmt(a.cacheRead + a.cacheWrite).padStart(12) +
      fmt(a.total).padStart(12) + fmtCost(a.cost).padStart(12) +
      pct(a.input, a.total).padStart(9) + pct(a.output, a.total).padStart(9)
    );
  }
  const t = summary.totals;
  lines.push(
    "TOTAL".padEnd(32) + String(t.requests).padStart(6) + fmt(t.input).padStart(12) +
    fmt(t.output).padStart(12) + fmt(t.cacheRead + t.cacheWrite).padStart(12) +
    fmt(t.total).padStart(12) + fmtCost(t.cost).padStart(12) +
    pct(t.input, t.total).padStart(9) + pct(t.output, t.total).padStart(9)
  );
  return lines.join("\n");
}

function renderHtml(summary, echartsJs) {
  // reasoning 是 output 的子集，不参与求和；records 已带有效成本（价格表兜底/override 在 Node 端解析完）
  const payload = JSON.stringify(summary).replace(/</g, "\\u003c");
  const generatedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode Token 用量报告</title>
<style>
  :root { --bg:#f3f5fb; --card:#fff; --ink:#1e2235; --muted:#8189a3; --border:#e8eaf3; --accent:#5b6cff; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background: var(--bg); color: var(--ink); margin: 0; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 24px 40px; }
  .hero { background: linear-gradient(130deg, #5b6cff, #8a5cff 55%, #c14bff); border-radius: 16px; color: #fff;
          padding: 24px 28px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;
          box-shadow: 0 10px 26px rgba(91,108,255,.28); }
  .hero h1 { margin: 0; font-size: 22px; letter-spacing: .5px; }
  .hero .sub { opacity: .85; font-size: 13px; margin-top: 6px; }
  .badge { background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.4); padding: 6px 16px;
           border-radius: 999px; font-size: 13px; white-space: nowrap; }
  .filterbar { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; margin: 16px 0 20px;
               background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 12px 18px;
               position: sticky; top: 8px; z-index: 10; box-shadow: 0 4px 14px rgba(30,34,53,.08); }
  .filterbar .flabel { font-size: 13px; color: var(--muted); font-weight: 600; }
  .seg { display: inline-flex; background: #edeff8; border-radius: 999px; padding: 3px; }
  .seg button { border: 0; background: transparent; padding: 5px 16px; border-radius: 999px; font-size: 13px;
                cursor: pointer; color: var(--muted); font-family: inherit; }
  .seg button.on { background: #fff; color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,.15); font-weight: 600; }
  .seg button.on.pri { background: var(--accent); color: #fff; }
  #customBox { display: none; align-items: center; gap: 8px; }
  #customBox.show { display: inline-flex; }
  #customBox input[type="date"] { border: 1px solid var(--border); border-radius: 8px; padding: 5px 8px; font-size: 13px;
                                   font-family: inherit; color: var(--ink); background: #fff; }
  #customBox .applybtn { border: 0; background: var(--accent); color: #fff; padding: 6px 16px; border-radius: 999px;
                         font-size: 13px; cursor: pointer; font-family: inherit; font-weight: 600; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 20px; }
  .card { background: var(--card); border-radius: 14px; padding: 16px 18px; border: 1px solid var(--border);
          box-shadow: 0 1px 2px rgba(30,34,53,.05); transition: transform .15s, box-shadow .15s; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(30,34,53,.08); }
  .card .label { font-size: 12px; color: var(--muted); }
  .card .value { font-size: 22px; font-weight: 700; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .card .value small { font-size: 12px; font-weight: 400; color: var(--muted); }
  .card.tok .value { color: var(--accent); } .card.cost .value { color: #0ea572; }
  .card.inp .value { color: #3d7bfd; } .card.out .value { color: #e8590c; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px 12px; margin-bottom: 20px;
           box-shadow: 0 1px 2px rgba(30,34,53,.05); }
  .panel h3 { margin: 0; font-size: 15px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .panel .desc { font-size: 12px; color: var(--muted); margin: 4px 0 6px; }
  .row2 { display: flex; gap: 16px; flex-wrap: wrap; }
  .row2 > div { flex: 1; min-width: 300px; height: 320px; }
  #trend, #c3 { width: 100%; height: 340px; }
  #empty { display: none; text-align: center; color: var(--muted); padding: 32px 0 12px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  th { color: var(--muted); font-weight: 600; text-align: right; padding: 10px 12px; border-bottom: 2px solid var(--border); white-space: nowrap; }
  td { text-align: right; padding: 9px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  tbody tr:hover { background: #f7f8ff; }
  tr.totalrow { background: #f7f8ff; font-weight: 700; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #eef0ff; color: var(--accent); font-weight: 600; font-size: 12px; }
  footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 4px; }
</style></head><body>
<div class="wrap">
  <div class="hero">
    <div><h1>📊 OpenCode Token 用量报告</h1>
      <div class="sub">按模型 · 按项目 · 时间可筛选 | reasoning 为 output 子集，不计入总量</div></div>
    <div class="badge">${summary.range.from ? `${summary.range.from} ~ ${summary.range.to}` : "暂无数据"}</div>
  </div>
  <div class="filterbar">
    <span class="flabel">时间范围</span>
    <span class="seg" id="segRange">
      <button data-r="all" class="on pri">全部</button><button data-r="year">今年</button><button data-r="month">本月</button><button data-r="today">今日</button><button data-r="custom">自定义</button>
    </span>
    <span id="customBox">
      <input type="date" id="dFrom"><span class="flabel">至</span><input type="date" id="dTo">
      <button id="applyCustom" class="applybtn">应用</button>
    </span>
    <span class="flabel" style="margin-left:auto">趋势粒度</span>
    <span class="seg" id="segGran">
      <button data-g="day">按日</button><button data-g="month" class="on">按月</button><button data-g="year">按年</button>
    </span>
    <span class="seg" id="segMetric">
      <button data-m="token" class="on">token</button><button data-m="cost">cost</button>
    </span>
  </div>
  <div id="empty">该时间范围内暂无数据</div>
  <div class="cards" id="cards"></div>
  <div class="panel"><h3>用量趋势</h3><div class="desc">按所选粒度聚合，token / cost 可切换</div><div id="trend"></div></div>
  <div class="panel"><h3>模型分布</h3><div class="desc">左：各模型总 token 占比；右：用量排行</div>
    <div class="row2"><div id="c1a"></div><div id="c1b"></div></div></div>
  <div class="panel"><h3>按项目</h3><div class="desc">各项目目录的总 token 对比</div><div id="c3"></div></div>
  <div class="panel"><h3>明细（按模型汇总）</h3><div style="overflow-x:auto"><table id="tbl"></table></div></div>
  <footer>生成时间 ${generatedAt} · 数据源 ~/.config/opencode/usage/data.jsonl${summary.bad > 0 ? ` · 已跳过坏行 ${summary.bad} 条` : ""}</footer>
</div>
<script>${echartsJs}</script>
<script>
const S = ${payload};
const R = S.records || [];
const PAL = ["#5b6cff", "#22c1a4", "#f6a723", "#e8590c", "#9b59b6", "#00b8d4", "#ff7096"];
const $ = (id) => document.getElementById(id);
const nf = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e4 ? (v / 1e3).toFixed(1) + "K" : (v || 0).toLocaleString();
const money = (v) => "$" + (v || 0).toFixed(4);
const tip = { trigger: "axis", backgroundColor: "#fff", borderColor: "#e8eaf3", textStyle: { color: "#1e2235", fontSize: 12 } };
const trunc = (s) => s.length > 22 ? s.slice(0, 10) + "…" + s.slice(-10) : s;
const charts = {};
const chart = (id) => charts[id] || (charts[id] = echarts.init($(id)));

let range = "all", gran = "month", metric = "token";
let customFrom = null, customTo = null; // 自定义区间的本地时间边界（毫秒）
const RANGE_GRAN = { all: "month", year: "month", month: "day", today: "day" };

function emptyT() { return { requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }; }
function addT(a, r) {
  const t = r.tokens || {};
  a.requests++;
  a.input += t.input || 0; a.output += t.output || 0; a.reasoning += t.reasoning || 0;
  a.cacheRead += t.cacheRead || 0; a.cacheWrite += t.cacheWrite || 0;
  a.total += (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
  a.cost += r.cost || 0;
}
function addAcc(dst, a) { // 合并聚合行（字段已是扁平值，不能再走 addT）
  dst.requests += a.requests; dst.input += a.input; dst.output += a.output;
  dst.reasoning += a.reasoning; dst.cacheRead += a.cacheRead; dst.cacheWrite += a.cacheWrite;
  dst.total += a.total; dst.cost += a.cost;
}
function pad(n) { return String(n).padStart(2, "0"); }
function bucket(ts, g) {
  const d = new Date(ts);
  if (g === "year") return String(d.getFullYear());
  if (g === "month") return d.getFullYear() + "-" + pad(d.getMonth() + 1);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function inRange(ts, rg) {
  if (rg === "custom") {
    if (customFrom !== null && ts < customFrom) return false;
    if (customTo !== null && ts > customTo) return false;
    return true;
  }
  if (rg === "all") return true;
  const d = new Date(ts), now = new Date();
  if (rg === "today") return bucket(ts, "day") === bucket(now.getTime(), "day");
  if (rg === "month") return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  return d.getFullYear() === now.getFullYear();
}
const modelKey = (r) => (r.providerID || "") + "/" + (r.modelID || "");
function agg(rs) {
  const t = emptyT(), byModel = {}, byDate = {}, byProject = {};
  for (const r of rs) {
    addT(t, r);
    addT(byModel[modelKey(r)] = byModel[modelKey(r)] || emptyT(), r);
    addT(byDate[bucket(r.time, gran)] = byDate[bucket(r.time, gran)] || emptyT(), r);
    addT(byProject[r.projectPath || "(unknown)"] = byProject[r.projectPath || "(unknown)"] || emptyT(), r);
  }
  return { t, byModel, byDate, byProject };
}

function renderCards(t) {
  const cards = [
    ["总 token", nf(t.total), "tok"],
    ["总 cost", money(t.cost), "cost"],
    ["input 占比", t.total ? (100 * t.input / t.total).toFixed(1) + "%" : "-", "inp"],
    ["output 占比", t.total ? (100 * t.output / t.total).toFixed(1) + "%" : "-", "out"],
    ["cache read/write", '<small>' + nf(t.cacheRead) + " / " + nf(t.cacheWrite) + "</small>", ""],
    ["请求次数", String(t.requests), ""],
    ["reasoning <small>(output 子集)</small>", nf(t.reasoning), ""],
  ];
  $("cards").innerHTML = cards.map(([k, v, c]) =>
    \`<div class="card \${c}"><div class="label">\${k}</div><div class="value">\${v}</div></div>\`).join("");
}

function renderTrend(byDate) {
  const keys = Object.keys(byDate).sort();
  const yv = (a) => metric === "cost" ? +a.cost.toFixed(6) : a.total;
  const yax = { type: "value", axisLabel: { formatter: metric === "cost" ? ((v) => "$" + nf(v)) : nf, color: "#8189a3" },
                splitLine: { lineStyle: { color: "#f0f2f8" } } };
  chart("trend").setOption({
    color: PAL, tooltip: tip,
    legend: metric === "cost" ? undefined : { bottom: 0, icon: "roundRect", itemWidth: 14, itemHeight: 8 },
    grid: { left: 60, right: 24, top: 30, bottom: metric === "cost" ? 24 : 56 },
    xAxis: { type: "category", data: keys, axisLabel: { color: "#8189a3" }, axisLine: { lineStyle: { color: "#e8eaf3" } } },
    yAxis: yax,
    series: metric === "cost"
      ? [{ name: "cost", type: "line", smooth: true, symbolSize: 7,
           lineStyle: { width: 3, color: "#0ea572" }, itemStyle: { color: "#0ea572" },
           areaStyle: { opacity: .12, color: "#0ea572" }, data: keys.map((k) => yv(byDate[k])) }]
      : [
          { name: "input", type: "bar", stack: "t", barMaxWidth: 36, data: keys.map((k) => byDate[k].input) },
          { name: "output", type: "bar", stack: "t", barMaxWidth: 36, data: keys.map((k) => byDate[k].output) },
          { name: "cache", type: "bar", stack: "t", barMaxWidth: 36, itemStyle: { borderRadius: [6, 6, 0, 0] },
            data: keys.map((k) => byDate[k].cacheRead + byDate[k].cacheWrite) },
        ],
  }, true);
}

function renderModels(byModel) {
  const entries = Object.entries(byModel).sort((a, b) => b[1].total - a[1].total);
  chart("c1a").setOption({
    color: PAL,
    tooltip: { trigger: "item", backgroundColor: "#fff", borderColor: "#e8eaf3", textStyle: { color: "#1e2235", fontSize: 12 },
               formatter: (p) => p.name + "<br/>" + nf(p.value) + " (" + p.percent + "%)" },
    legend: { bottom: 0, icon: "circle", itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11, color: "#8189a3" } },
    series: [{ type: "pie", radius: ["42%", "68%"], center: ["50%", "44%"],
               label: { formatter: "{d}%", fontSize: 11, color: "#8189a3" },
               itemStyle: { borderColor: "#fff", borderWidth: 2 },
               data: entries.map(([m, a]) => ({ name: trunc(m), value: a.total })) }],
  }, true);
  const names = entries.map(([m]) => trunc(m)).reverse();
  const vals = entries.map(([, a]) => a.total).reverse();
  chart("c1b").setOption({
    color: ["#5b6cff"], tooltip: { ...tip, formatter: (p) => p.name + "<br/>total " + nf(p.value) },
    grid: { left: 10, right: 80, top: 10, bottom: 10, containLabel: true },
    xAxis: { type: "value", axisLabel: { formatter: nf, color: "#8189a3" }, splitLine: { lineStyle: { color: "#f0f2f8" } } },
    yAxis: { type: "category", data: names, axisLabel: { color: "#1e2235", fontSize: 11 }, axisLine: { lineStyle: { color: "#e8eaf3" } } },
    series: [{ type: "bar", barMaxWidth: 18, itemStyle: { borderRadius: [0, 6, 6, 0] },
               label: { show: true, position: "right", formatter: (p) => nf(p.value), color: "#8189a3", fontSize: 11 },
               data: vals }],
  }, true);
}

function renderProjects(byProject) {
  const entries = Object.entries(byProject).sort((a, b) => a[1].total - b[1].total);
  chart("c3").setOption({
    color: ["#5b6cff"], tooltip: { ...tip, formatter: (p) => p.name + "<br/>total " + nf(p.value) },
    grid: { left: 60, right: 70, top: 16, bottom: 24 },
    xAxis: { type: "value", axisLabel: { formatter: nf, color: "#8189a3" }, splitLine: { lineStyle: { color: "#f0f2f8" } } },
    yAxis: { type: "category", data: entries.map(([p]) => trunc(p)), axisLabel: { color: "#1e2235", fontSize: 12 },
             axisLine: { lineStyle: { color: "#e8eaf3" } } },
    series: [{ type: "bar", barMaxWidth: 22, itemStyle: { borderRadius: [0, 6, 6, 0] },
               label: { show: true, position: "right", formatter: (p) => nf(p.value), color: "#8189a3", fontSize: 11 },
               data: entries.map(([, a]) => a.total) }],
  }, true);
}

function renderTable(byModel) {
  const entries = Object.entries(byModel);
  const row = (m, a, cls) =>
    \`<tr\${cls ? ' class="' + cls + '"' : ""}><td>\${m ? '<span class="pill">' + m + "</span>" : "TOTAL"}</td>\` +
    \`<td>\${a.requests}</td><td>\${a.input.toLocaleString()}</td><td>\${a.output.toLocaleString()}</td>\` +
    \`<td>\${a.reasoning.toLocaleString()}</td><td>\${a.cacheRead.toLocaleString()}</td><td>\${a.cacheWrite.toLocaleString()}</td>\` +
    \`<td><b>\${a.total.toLocaleString()}</b></td><td>\${money(a.cost)}</td>\` +
    \`<td>\${a.total ? (100 * a.input / a.total).toFixed(1) : 0}%</td><td>\${a.total ? (100 * a.output / a.total).toFixed(1) : 0}%</td></tr>\`;
  const t = emptyT(); entries.forEach(([, a]) => addAcc(t, a));
  $("tbl").innerHTML =
    "<thead><tr><th>模型</th><th>次数</th><th>input</th><th>output</th><th>reasoning</th><th>cache read</th><th>cache write</th><th>合计</th><th>cost</th><th>input%</th><th>output%</th></tr></thead><tbody>" +
    entries.map(([m, a]) => row(m, a)).join("") + row(null, t, "totalrow") + "</tbody>";
}

function refresh() {
  const rs = R.filter((r) => inRange(r.time, range));
  const { t, byModel, byDate, byProject } = agg(rs);
  $("empty").style.display = rs.length ? "none" : "block";
  renderCards(t);
  renderTrend(byDate);
  renderModels(byModel);
  renderProjects(byProject);
  renderTable(byModel);
}

function bindSeg(id, attr, fn) {
  $(id).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    $(id).querySelectorAll("button").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    fn(btn.dataset[attr]);
  });
}
bindSeg("segRange", "r", (v) => {
  range = v;
  const box = $("customBox");
  if (v === "custom") {
    box.classList.add("show");
    if (!$("dFrom").value && S.range.from) $("dFrom").value = S.range.from;
    if (!$("dTo").value) { const d = new Date(); $("dTo").value = bucket(d.getTime(), "day"); }
    applyCustom(); // 有预填值时立即生效
  } else {
    box.classList.remove("show");
    gran = RANGE_GRAN[v];
    $("segGran").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.g === gran));
    refresh();
  }
});
$("applyCustom").addEventListener("click", applyCustom);
function applyCustom() {
  customFrom = $("dFrom").value ? new Date($("dFrom").value + "T00:00:00").getTime() : null;
  customTo = $("dTo").value ? new Date($("dTo").value + "T23:59:59.999").getTime() : null;
  if (customFrom !== null && customTo !== null && customFrom > customTo) { [customFrom, customTo] = [customTo, customFrom]; }
  const days = (customFrom !== null && customTo !== null) ? (customTo - customFrom) / 864e5 : 0;
  gran = days > 730 ? "year" : days > 62 ? "month" : "day";
  $("segGran").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.g === gran));
  refresh();
}
bindSeg("segGran", "g", (v) => { gran = v; refresh(); });
bindSeg("segMetric", "m", (v) => { metric = v; refresh(); });
window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));
refresh();
</script></body></html>`;
}

const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function openBrowser(file) {
  const cmd = process.platform === "win32"
    ? spawn("cmd", ["/c", "start", "", file], { detached: true, stdio: "ignore" })
    : process.platform === "darwin"
      ? spawn("open", [file], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [file], { detached: true, stdio: "ignore" });
  cmd.unref();
}
// win32 注意：start 后第一个引号参数是窗口标题，必须传空字符串，否则文件名会被当标题。

function parseArgs(argv) {
  const opts = { open: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--open") opts.open = true;
    else if (argv[i] === "--data") opts.data = argv[++i];
    else if (argv[i] === "--out") opts.out = argv[++i];
    else if (argv[i] === "--prices") opts.prices = argv[++i];
  }
  return opts;
}

function main(argv = []) {
  const home = os.homedir();
  const usageDir = path.join(home, ".config", "opencode", "usage");
  const opts = parseArgs(argv);
  const dataFile = opts.data || path.join(usageDir, "data.jsonl");
  const outFile = opts.out || path.join(usageDir, "usage-report.html");
  const pricesFile = opts.prices || path.join(usageDir, "prices.json");

  const { records, bad } = (() => {
    // 使用默认路径时，先静默增量同步 opencode.db 的历史用量（幂等，按 messageID 跳过已存在）
    if (!opts.data && !opts.db) {
      try { require("./import-history.js").main([], { quiet: true }); } catch { /* 数据库不可用时只用现有 data.jsonl */ }
    }
    return readRecords(dataFile);
  })();
  const prices = loadPrices(pricesFile);
  // 每条记录预解析有效成本（价格表兜底 / override），整份嵌入 HTML 供浏览器本地筛选聚合
  const enriched = dedupe(records).map((r) => ({
    ...r,
    cost: resolveCost(r, prices[`${r.providerID || ""}/${r.modelID || ""}`]),
  }));
  const summary = aggregate(enriched, {});
  summary.bad = bad;
  summary.records = enriched;

  const text = renderText(summary);
  console.log(text);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  let echartsJs;
  try {
    echartsJs = fs.readFileSync(path.join(__dirname, "vendor", "echarts.min.js"), "utf8");
  } catch {
    throw new Error(`找不到 ${path.join(__dirname, "vendor", "echarts.min.js")}，请先下载 ECharts 到 src/vendor/`);
  }
  fs.writeFileSync(outFile, renderHtml(summary, echartsJs));
  console.log(`\nHTML 报告: ${outFile}`);

  if (opts.open) openBrowser(outFile);
  return text;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  readRecords, dedupe, localDate, loadPrices, estimateCost, resolveCost, aggregate,
  renderText, renderHtml, openBrowser, parseArgs, main,
};
