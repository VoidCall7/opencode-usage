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
  :root { --bg:#0d0d0d; --panel:#141414; --row:#181818; --line:#262626; --ink:#f2f2f2; --mut:#8f8f8f; --dim:#5c5c5c; --acc:#ff6a00; }
  * { box-sizing: border-box; }
  body { font-family: ui-monospace, "Cascadia Code", Consolas, "Courier New", "Microsoft YaHei", monospace;
         background: var(--bg); color: var(--ink); margin: 0; }
  .wrap { max-width: 1280px; margin: 0 auto; }
  .topbar { position: sticky; top: 0; z-index: 30; background: rgba(13,13,13,.94); backdrop-filter: blur(6px);
            border-bottom: 1px solid var(--line); padding: 13px 32px; display: flex; justify-content: space-between; align-items: center; }
  .logo { font-size: 13px; font-weight: 700; letter-spacing: 2px; }
  .logo::before { content: "■ "; color: var(--acc); }
  .topbar .gen { color: var(--dim); font-size: 11px; letter-spacing: 1px; }
  .hero { border-bottom: 1px solid var(--line); padding: 60px 32px 72px;
          background-image: radial-gradient(#1c1c1c 1px, transparent 1px); background-size: 14px 14px; }
  .hero .upd { display: inline-block; border: 1px solid var(--line); background: #151515; color: var(--mut);
               font-size: 11px; padding: 4px 12px; margin-bottom: 22px; }
  .hero h1 { margin: 0 0 14px; font-size: 46px; letter-spacing: -1px; line-height: 1.1; }
  .hero h1 span { color: var(--acc); }
  .hero p { color: var(--mut); font-size: 13px; max-width: 620px; margin: 0; line-height: 1.8; }
  .toolbar { position: sticky; top: 47px; z-index: 25; background: #101010; border-bottom: 1px solid var(--line); padding: 10px 32px; }
  .tin { max-width: 1280px; margin: 0 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .chip { border: 1px solid var(--line); background: transparent; color: var(--mut); font: inherit; font-size: 12px;
          padding: 5px 13px; cursor: pointer; white-space: nowrap; }
  .chip:hover { color: var(--ink); border-color: #454545; }
  .chip.on { background: var(--acc); border-color: var(--acc); color: #000; font-weight: 700; }
  .tin .sp { flex: 1; }
  .grp { display: flex; align-items: center; gap: 6px; }
  .grp .lb { color: var(--dim); font-size: 10px; letter-spacing: 1px; }
  .dates { position: relative; display: flex; align-items: center; gap: 6px; }
  .dates input { width: 108px; background: #161616; border: 1px solid var(--line); color: var(--ink);
                 font: inherit; font-size: 12px; padding: 5px 8px; }
  .dates input:focus { outline: none; border-color: var(--acc); }
  .dates input::placeholder { color: var(--dim); }
  .chip.go { color: var(--ink); }
  .cal { position: absolute; top: calc(100% + 8px); left: 0; width: 256px; background: #161616;
         border: 1px solid #2e2e2e; box-shadow: 0 14px 36px rgba(0,0,0,.65); padding: 12px; z-index: 60; display: none; }
  .cal.show { display: block; }
  .cal .calq { display: flex; flex-wrap: wrap; gap: 4px; padding-bottom: 10px; border-bottom: 1px solid var(--line); margin-bottom: 10px; }
  .cal .calq .chip { font-size: 11px; padding: 3px 9px; }
  .cal .calh { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .cal .calh b { font-size: 13px; }
  .cal .nav { border: 0; background: transparent; color: var(--mut); font: inherit; cursor: pointer; padding: 2px 8px; }
  .cal .nav:hover { color: var(--acc); }
  .cal .grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .cal .wd { color: var(--dim); font-size: 10px; text-align: center; padding: 4px 0; }
  .cal .day { border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 12px; padding: 5px 0; cursor: pointer; }
  .cal .day:hover { background: #262626; }
  .cal .day.out { color: #3f3f3f; }
  .cal .day.mid { background: #38200a; color: #ffb066; }
  .cal .day.sel { background: var(--acc); color: #000; font-weight: 700; }
  section { border-bottom: 1px solid var(--line); padding: 42px 32px 52px; }
  .sec-h { margin: 0 0 8px; font-size: 24px; letter-spacing: -.5px; }
  .sec-h span { color: var(--mut); font-size: 14px; font-weight: 400; margin-left: 10px; }
  .sec-d { color: var(--dim); font-size: 12px; margin: 0 0 26px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(136px, 1fr)); gap: 1px;
           background: var(--line); border: 1px solid var(--line); }
  .stat { background: #111; padding: 18px 20px; }
  .stat .k { color: var(--dim); font-size: 10px; letter-spacing: 1.5px; }
  .stat .v { font-size: 22px; font-weight: 700; margin-top: 10px; font-variant-numeric: tabular-nums; }
  .stat.a .v { color: var(--acc); } .stat.g .v { color: #4ade80; } .stat.c .v { color: #22d3ee; }
  .stat.o .v { color: #ff9f1c; } .stat.p .v { color: #e879f9; } .stat.b .v { color: #60a5fa; }
  .stat .v small { font-size: 11px; font-weight: 400; color: var(--mut); }
  .strips { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px; margin-bottom: 24px; }
  .strip { display: flex; align-items: center; gap: 10px; background: #161616; border: 1px solid #222;
           padding: 9px 14px; font-size: 12px; min-width: 0; }
  .strip .rk { color: var(--dim); }
  .strip .sw { width: 8px; height: 8px; flex: none; }
  .strip .nm { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .strip .val { margin-left: auto; color: var(--mut); white-space: nowrap; }
  .strip .pc { color: var(--dim); width: 52px; text-align: right; white-space: nowrap; }
  .strip.hl { border-color: var(--acc); background: #201302; }
  #empty { display: none; color: var(--dim); padding: 40px 0 8px; font-size: 13px; text-align: center; }
  table { width: 100%; border-collapse: separate; border-spacing: 0 6px; font-size: 12px; font-variant-numeric: tabular-nums; }
  th { color: var(--dim); font-weight: 400; text-transform: uppercase; font-size: 10px; letter-spacing: 1px;
       text-align: right; padding: 0 14px 4px; white-space: nowrap; }
  td { background: #161616; text-align: right; padding: 10px 14px; white-space: nowrap; }
  td:first-child { border-radius: 4px 0 0 4px; } td:last-child { border-radius: 0 4px 4px 0; }
  th:first-child, td:first-child { text-align: left; }
  tbody tr:hover td { background: #1f1f1f; }
  tr.total td { background: #201302; font-weight: 700; }
  tr.total td:first-child { border-left: 2px solid var(--acc); color: var(--acc); }
  .mdot { display: inline-block; width: 8px; height: 8px; margin-right: 8px; vertical-align: baseline; }
  footer { color: var(--dim); font-size: 11px; letter-spacing: .5px; padding: 26px 32px 40px; }
  @media (max-width: 720px) { .hero h1 { font-size: 30px; } .topbar, .toolbar, section, footer { padding-left: 16px; padding-right: 16px; } }
</style></head><body>
<div class="topbar"><div class="logo">OPENCODE · USAGE</div><div class="gen">GENERATED ${generatedAt}</div></div>
<div class="hero"><div class="wrap">
  <div class="upd">[*] 已更新 ${generatedAt}</div>
  <h1>Token 用量报告<span>.</span></h1>
  <p>本地 OpenCode 的真实 token 消耗与成本，按模型、按项目、按时间统计。成本优先用 OpenCode 内置计费，缺失时按 models.dev 牌价估算（prices.json，可用 override 强制覆盖）；reasoning 为 output 子集，不计入总量。</p>
</div></div>
<div class="toolbar"><div class="tin">
  <span class="grp" id="segRange">
    <button class="chip" data-q="all">全部</button><button class="chip" data-q="today">今天</button><button class="chip" data-q="yesterday">昨天</button><button class="chip" data-q="month">本月</button><button class="chip" data-q="lastmonth">上个月</button><button class="chip" data-q="quarter">本季度</button>
  </span>
  <span class="dates" id="datesBox">
    <input id="dFrom" placeholder="起始日期" autocomplete="off"><span style="color:var(--dim)">→</span><input id="dTo" placeholder="结束日期" autocomplete="off">
    <button id="applyCustom" class="chip go">应用</button>
    <div class="cal" id="calPanel">
      <div class="calq">
        <button class="chip" data-q="today">今天</button><button class="chip" data-q="yesterday">昨天</button><button class="chip" data-q="month">本月</button><button class="chip" data-q="lastmonth">上个月</button><button class="chip" data-q="quarter">本季度</button><button class="chip" data-q="all">全部</button>
      </div>
      <div class="calh"><button class="nav" id="calPrev">‹</button><b id="calTitle"></b><button class="nav" id="calNext">›</button></div>
      <div class="grid" id="calWd"><span class="wd">一</span><span class="wd">二</span><span class="wd">三</span><span class="wd">四</span><span class="wd">五</span><span class="wd">六</span><span class="wd">日</span></div>
      <div class="grid" id="calGrid"></div>
    </div>
  </span>
  <span class="sp"></span>
  <span class="grp"><span class="lb">粒度</span>
    <span class="grp" id="segGran"><button class="chip" data-g="day">日</button><button class="chip" data-g="month">月</button><button class="chip" data-g="year">年</button></span>
  </span>
  <span class="grp"><span class="lb">指标</span>
    <span class="grp" id="segMetric"><button class="chip" data-m="token">TOKEN</button><button class="chip" data-m="cost">COST</button></span>
  </span>
</div></div>
<section><div class="wrap">
  <div id="empty">该时间范围内暂无数据</div>
  <div class="stats" id="cards"></div>
</div></section>
<section><div class="wrap"><h2 class="sec-h">用量趋势<span>各模型用量占比堆叠（前 8 + 其他）· 悬停看单日明细 · 点击图例隐藏模型 · TOKEN / COST 可切换</span></h2><div id="trend" style="height:340px"></div></div></section>
<section><div class="wrap"><h2 class="sec-h">模型分布<span>构成与用量排行</span></h2>
  <div class="strips" id="dist"></div><div id="rank"></div></div></section>
<section><div class="wrap"><h2 class="sec-h">按项目<span>各项目目录的总 token 对比</span></h2><div id="c3"></div></div></section>
<section><div class="wrap"><h2 class="sec-h">明细<span>按模型汇总</span></h2><div style="overflow-x:auto"><table id="tbl"></table></div></div></section>
<footer>[*] 生成时间 ${generatedAt} · 数据源 ~/.config/opencode/usage/data.jsonl${summary.bad > 0 ? ` · 已跳过坏行 ${summary.bad} 条` : ""}</footer>
<script>${echartsJs}</script>
<script>
const S = ${payload};
const R = S.records || [];
const PAL = ["#ff9f1c", "#e879f9", "#a78bfa", "#22d3ee", "#4ade80", "#f43f5e", "#facc15", "#60a5fa", "#2dd4bf", "#fb7185"];
const INK = "#f2f2f2", MUT = "#8f8f8f", DIM = "#5c5c5c", LINE = "#262626", SPLIT = "#1c1c1c", ACC = "#ff6a00";
const $ = (id) => document.getElementById(id);
const nf = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e4 ? (v / 1e3).toFixed(1) + "K" : (v || 0).toLocaleString();
const money = (v) => "$" + (v || 0).toFixed(4);
const tip = { trigger: "axis", backgroundColor: "#1a1a1a", borderColor: "#333", textStyle: { color: "#eee", fontSize: 12 } };
const trunc = (s) => s.length > 24 ? s.slice(0, 11) + "…" + s.slice(-11) : s;
let from = null, to = null, gran = "month", metric = "token"; // from/to 为本地时间毫秒边界
const charts = {};

function emptyT() { return { requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }; }
function addT(a, r) {
  const t = r.tokens || {};
  a.requests++;
  a.input += t.input || 0; a.output += t.output || 0; a.reasoning += t.reasoning || 0;
  a.cacheRead += t.cacheRead || 0; a.cacheWrite += t.cacheWrite || 0;
  a.total += (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
  a.cost += r.cost || 0;
}
function addAcc(dst, a) {
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
const day0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtD = (ts) => bucket(ts, "day");
function presetSpan(q) {
  const n = new Date();
  if (q === "today") return [+day0(n), +day0(n) + 864e5 - 1];
  if (q === "yesterday") { const e = +day0(n); return [e - 864e5, e - 1]; }
  if (q === "month") return [+new Date(n.getFullYear(), n.getMonth(), 1), +new Date(n.getFullYear(), n.getMonth() + 1, 1) - 1];
  if (q === "lastmonth") return [+new Date(n.getFullYear(), n.getMonth() - 1, 1), +new Date(n.getFullYear(), n.getMonth(), 1) - 1];
  if (q === "quarter") { const qs = Math.floor(n.getMonth() / 3) * 3;
    return [+new Date(n.getFullYear(), qs, 1), +new Date(n.getFullYear(), qs + 3, 1) - 1]; }
  return [null, null];
}
function inRange(ts) {
  if (from !== null && ts < from) return false;
  if (to !== null && ts > to) return false;
  return true;
}
const modelKey = (r) => (r.providerID || "") + "/" + (r.modelID || "");
function agg(rs) {
  const t = emptyT(), byModel = {}, byDate = {}, byProject = {}, byDateModel = {};
  for (const r of rs) {
    addT(t, r);
    const mk = modelKey(r);
    addT(byModel[mk] = byModel[mk] || emptyT(), r);
    const bk = bucket(r.time, gran);
    addT(byDate[bk] = byDate[bk] || emptyT(), r);
    addT(byProject[r.projectPath || "(unknown)"] = byProject[r.projectPath || "(unknown)"] || emptyT(), r);
    addT((byDateModel[bk] = byDateModel[bk] || {})[mk] = byDateModel[bk][mk] || emptyT(), r);
  }
  return { t, byModel, byDate, byProject, byDateModel };
}

function renderStats(t) {
  const cards = [
    ["TOTAL TOKEN", nf(t.total), "a"],
    ["TOTAL COST", money(t.cost), "g"],
    ["INPUT", nf(t.input) + ' <small>' + (t.total ? (100 * t.input / t.total).toFixed(1) + "%" : "-") + "</small>", "c"],
    ["OUTPUT", nf(t.output) + ' <small>' + (t.total ? (100 * t.output / t.total).toFixed(1) + "%" : "-") + "</small>", "o"],
    ["CACHE R/W", '<small>' + nf(t.cacheRead) + " / " + nf(t.cacheWrite) + "</small>", "p"],
    ["缓存率", (t.total ? (100 * t.cacheRead / t.total).toFixed(1) : "0.0") + "%", "b"],
    ["请求次数", String(t.requests), ""],
    ["REASONING", '<small>output 子集</small> ' + nf(t.reasoning), ""],
  ];
  $("cards").innerHTML = cards.map(([k, v, c]) =>
    '<div class="stat ' + c + '"><div class="k">' + k + '</div><div class="v">' + v + "</div></div>").join("");
}

function setChart(id, opt, h) {
  if (h) $(id).style.height = h + "px";
  if (charts[id]) charts[id].dispose();
  charts[id] = echarts.init($(id));
  charts[id].setOption(opt);
}

/* 模型/列 ↔ 趋势图 交叉高亮：悬停构成条 → 该模型保持彩色其余压暗；悬停柱 → 该列保持彩色其余列压暗（对齐参考页） */
let trendColorMap = {};
let dimState = null; // null | {type:"model",name} | {type:"column",idx} | {type:"segment",name,idx}
function applyTrendDim() {
  if (!charts.trend) return;
  const opt = charts.trend.getOption();
  if (!opt || !opt.series) return;
  const series = opt.series.map((s) => {
    if (s.name === "__total") return s;
    // 系列级底色：模型/段悬停只保留目标模型颜色；列悬停保留全部模型颜色
    let col;
    if (!dimState || dimState.type === "column" || (dimState.type === "segment" && s.name === dimState.name)) {
      col = trendColorMap[s.name] || "#555";
    } else if (dimState.type === "model" && s.name === dimState.name) {
      col = trendColorMap[s.name] || "#555";
    } else {
      col = "#2f2f2f";
    }
    // 逐点：段悬停 = 目标模型全日期彩色 ∪ 目标列整列彩色；列悬停 = 仅该列彩色
    const data = (s.data || []).map((v, i) => {
      const val = v && typeof v === "object" ? v.value : v;
      let c = col;
      if (dimState && dimState.type === "column" && i !== dimState.idx) c = "#2f2f2f";
      if (dimState && dimState.type === "segment" && i !== dimState.idx && s.name !== dimState.name) c = "#2f2f2f";
      return { value: val, itemStyle: { color: c } };
    });
    return { ...s, itemStyle: { ...s.itemStyle, color: col }, data };
  });
  charts.trend.setOption({ series });
}
function dimState2(next) {
  if (JSON.stringify(dimState) === JSON.stringify(next)) return;
  dimState = next;
  applyTrendDim();
}
function dimTrend(name) { dimState2(name ? { type: "model", name } : null); }
function dimTrendColumn(idx) { dimState2(idx === null || idx === undefined ? null : { type: "column", idx }); }
function dimTrendSegment(name, idx) {
  if (name === null || idx === null || idx === undefined) dimState2(null);
  else dimState2({ type: "segment", name, idx });
}
function markStrip(name) {
  document.querySelectorAll("#dist .strip").forEach((el) =>
    el.classList.toggle("hl", !!name && el.dataset.model === name));
}
const hlTrend = dimTrend;

function renderTrend(byDate, byDateModel, byModel) {
  // 与参考页一致：柱内按模型堆叠（占比），前 8 + 其他；颜色与构成条/排行/明细一致；点击图例可隐藏模型
  const keys = Object.keys(byDate).sort();
  const ranking = Object.entries(byModel).sort((a, b) => b[1].total - a[1].total).filter(([, a]) => a.total > 0);
  const top = ranking.slice(0, 8).map((e) => e[0]);
  const val = (a) => metric === "cost" ? +a.cost.toFixed(6) : a.total;
  trendColorMap = {};
  ranking.forEach(([m], i) => { trendColorMap[m] = PAL[i % PAL.length]; });
  trendColorMap["其他"] = "#ff8904";
  const colorOf = (m) => trendColorMap[m] || "#555";
  const series = top.map((m) => ({
    name: m, type: "bar", stack: "t", barMaxWidth: 34, barCategoryGap: "25%",
    itemStyle: { color: colorOf(m) },
    data: keys.map((k) => val((byDateModel[k] || {})[m] || emptyT())),
  }));
  if (ranking.length > 8) series.push({
    name: "其他", type: "bar", stack: "t", barMaxWidth: 34, itemStyle: { color: "#ff8904" },
    data: keys.map((k) => { const d = byDateModel[k] || {}; let s = 0;
      ranking.slice(8).forEach(([m]) => { s += val(d[m] || emptyT()); });
      return +s.toFixed(6); }),
  });
  // 列顶当日总量标签：透明占位段（同 stack 顶部），不进 tooltip；列太多时隐藏防重叠
  series.push({
    name: "__total", type: "bar", stack: "t", silent: true, barMaxWidth: 34, z: 1,
    itemStyle: { color: "transparent" }, data: keys.map(() => 0), tooltip: { show: false },
    label: { show: keys.length <= 45, position: "top", fontSize: 10, color: MUT,
             formatter: (p) => metric === "cost" ? money(byDate[keys[p.dataIndex]].cost) : nf(byDate[keys[p.dataIndex]].total) },
  });
  setChart("trend", {
    tooltip: { trigger: "axis", backgroundColor: "#1a1a1a", borderColor: "#333", textStyle: { color: "#eee", fontSize: 12 },
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(255,255,255,.06)" } }, // 悬停整列高亮色带
      formatter: (ps) => {
        const rows = ps.filter((p) => p.seriesName !== "__total" && p.value > 0).sort((a, b) => b.value - a.value);
        let tot = 0; rows.forEach((p) => { tot += p.value; });
        let h = ps[0].axisValue;
        rows.forEach((p) => {
          h += "<br/>" + p.marker + p.seriesName + "  " + (metric === "cost" ? money(p.value) : nf(p.value)) +
               " (" + (tot ? (100 * p.value / tot).toFixed(1) : 0) + "%)";
        });
        return h + "<br/>合计 " + (metric === "cost" ? money(tot) : nf(tot));
      } },
    legend: { type: "scroll", bottom: 0, icon: "rect", itemWidth: 10, itemHeight: 8,
              textStyle: { color: MUT, fontSize: 10, fontFamily: "monospace" },
              data: top.concat(ranking.length > 8 ? ["其他"] : []) },
    grid: { left: 64, right: 24, top: 28, bottom: 54 },
    xAxis: { type: "category", data: keys, axisLabel: { color: MUT, fontSize: 11 }, axisLine: { lineStyle: { color: LINE } } },
    yAxis: { type: "value", axisLabel: { formatter: metric === "cost" ? ((v) => "$" + nf(v)) : nf, color: MUT },
             splitLine: { lineStyle: { color: SPLIT } } },
    series,
  });
  charts.trend.on("mouseover", (p) => {
    if (p.seriesName === "__total") return;
    markStrip(p.seriesName);
    // 悬停某模型的分段：该模型全日期保持彩色 + 该列整列保持彩色，其余压暗
    dimTrendSegment(p.seriesName, p.dataIndex);
  });
  charts.trend.on("globalout", () => { markStrip(null); dimTrendSegment(null); });
}

function renderModels(byModel) {
  // 零用量的模型不进构成条与排行图，避免噪音（明细表保留完整列表）
  const entries = Object.entries(byModel).sort((a, b) => b[1].total - a[1].total).filter(([, a]) => a.total > 0);
  const total = entries.reduce((s, [, a]) => s + a.total, 0);
  $("dist").innerHTML = entries.map(([m, a], i) => {
    const c = PAL[i % PAL.length];
    const attr = m.replace(/"/g, "&quot;");
    return '<div class="strip" data-model="' + attr + '"><span class="rk">' + pad(i + 1) + '</span><span class="sw" style="background:' + c + '"></span>' +
      '<span class="nm" title="' + attr + '">' + m + '</span><span class="val">' + nf(a.total) + '</span>' +
      '<span class="pc">' + (total ? (100 * a.total / total).toFixed(1) : "0.0") + "%</span></div>";
  }).join("");
  $("dist").querySelectorAll(".strip").forEach((el) => {
    el.addEventListener("mouseenter", () => { el.classList.add("hl"); hlTrend(el.dataset.model, true); });
    el.addEventListener("mouseleave", () => { el.classList.remove("hl"); hlTrend(el.dataset.model, false); });
  });
  const names = entries.map(([m]) => trunc(m)).reverse();
  const vals = entries.map(([, a]) => a.total).reverse();
  const cols = entries.map((_, i) => PAL[i % PAL.length]).reverse();
  setChart("rank", {
    tooltip: { ...tip, trigger: "item", formatter: (p) => p.name + "<br/>" + nf(p.value) + " (" + (total ? (100 * p.value / total).toFixed(1) : 0) + "%)" },
    grid: { left: 10, right: 92, top: 6, bottom: 6, containLabel: true },
    xAxis: { type: "value", axisLabel: { formatter: nf, color: DIM }, splitLine: { lineStyle: { color: SPLIT } } },
    yAxis: { type: "category", data: names, axisLabel: { color: "#dcdcdc", fontSize: 11 }, axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false } },
    series: [{ type: "bar", barMaxWidth: 14, barCategoryGap: "35%",
               itemStyle: { borderRadius: [0, 3, 3, 0], color: (p) => cols[p.dataIndex] },
               label: { show: true, position: "right", formatter: (p) => nf(p.value), color: MUT, fontSize: 11 },
               data: vals }],
  }, Math.max(200, entries.length * 30 + 30));
}

function renderProjects(byProject) {
  const entries = Object.entries(byProject).sort((a, b) => b[1].total - a[1].total);
  const names = entries.map(([p]) => trunc(p)).reverse();
  const vals = entries.map(([, a]) => a.total).reverse();
  setChart("c3", {
    tooltip: { ...tip, trigger: "item", formatter: (p) => p.name + "<br/>" + nf(p.value) },
    grid: { left: 10, right: 92, top: 6, bottom: 6, containLabel: true },
    xAxis: { type: "value", axisLabel: { formatter: nf, color: DIM }, splitLine: { lineStyle: { color: SPLIT } } },
    yAxis: { type: "category", data: names, axisLabel: { color: "#dcdcdc", fontSize: 11 }, axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false } },
    series: [{ type: "bar", barMaxWidth: 14, barCategoryGap: "35%",
               itemStyle: { borderRadius: [0, 3, 3, 0], color: "#a78bfa" },
               label: { show: true, position: "right", formatter: (p) => nf(p.value), color: MUT, fontSize: 11 },
               data: vals }],
  }, Math.max(200, entries.length * 30 + 30));
}

function renderTable(byModel) {
  const entries = Object.entries(byModel).sort((a, b) => b[1].total - a[1].total);
  const row = (m, a, cls, color) =>
    "<tr" + (cls ? ' class="' + cls + '"' : "") + "><td>" +
    (m ? '<span class="mdot" style="background:' + color + '"></span>' + m : "TOTAL") + "</td>" +
    "<td>" + a.requests + "</td><td>" + a.input.toLocaleString() + "</td><td>" + a.output.toLocaleString() + "</td>" +
    "<td>" + a.reasoning.toLocaleString() + "</td><td>" + a.cacheRead.toLocaleString() + "</td><td>" + a.cacheWrite.toLocaleString() + "</td>" +
    "<td><b>" + a.total.toLocaleString() + "</b></td><td>" + money(a.cost) + "</td>" +
    "<td>" + (a.total ? (100 * a.input / a.total).toFixed(1) : 0) + "%</td><td>" + (a.total ? (100 * a.output / a.total).toFixed(1) : 0) + "%</td></tr>";
  const t = emptyT(); entries.forEach(([, a]) => addAcc(t, a));
  $("tbl").innerHTML =
    "<thead><tr><th>模型</th><th>次数</th><th>input</th><th>output</th><th>reasoning</th><th>cache read</th><th>cache write</th><th>合计</th><th>cost</th><th>input%</th><th>output%</th></tr></thead><tbody>" +
    entries.map(([m, a], i) => row(m, a, "", PAL[i % PAL.length])).join("") + row(null, t, "total") + "</tbody>";
}

function refresh() {
  const rs = R.filter((r) => inRange(r.time));
  const { t, byModel, byDate, byProject, byDateModel } = agg(rs);
  $("empty").style.display = rs.length ? "none" : "block";
  renderStats(t);
  renderTrend(byDate, byDateModel, byModel);
  renderModels(byModel);
  renderProjects(byProject);
  renderTable(byModel);
}

/* ---- 时间筛选：快捷区间 + 自定义日历 ---- */
function syncInputs() {
  $("dFrom").value = from === null ? "" : fmtD(from);
  $("dTo").value = to === null ? "" : fmtD(to);
}
function autoGran() {
  // 默认按日（与参考页一致）；跨度超过两年自动切到按年，月份/年份仍可手动切换
  if (from === null || to === null) { gran = "day"; }
  else { const days = (to - from) / 864e5; gran = days > 730 ? "year" : "day"; }
  $("segGran").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.g === gran));
}
function markChips() {
  document.querySelectorAll("#segRange .chip").forEach((b) => {
    const [f, t] = presetSpan(b.dataset.q);
    const on = b.dataset.q === "all" ? (from === null && to === null) : (f === from && t === to);
    b.classList.toggle("on", on);
  });
}
function applySpan(f, t) {
  if (f !== null && t !== null && f > t) { const x = f; f = t; t = x; }
  from = f; to = t;
  autoGran(); syncInputs(); markChips(); closeCal(); refresh();
}
function setPreset(q) {
  if (q === "all") { applySpan(null, null); return; }
  const [f, t] = presetSpan(q);
  applySpan(f, t);
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
bindSeg("segRange", "q", setPreset);
bindSeg("segGran", "g", (v) => { gran = v; refresh(); });
bindSeg("segMetric", "m", (v) => { metric = v; refresh(); });
function applyCustom() {
  const f = $("dFrom").value ? new Date($("dFrom").value + "T00:00:00").getTime() : null;
  const t = $("dTo").value ? new Date($("dTo").value + "T23:59:59.999").getTime() : null;
  applySpan(f, t);
}
$("applyCustom").addEventListener("click", applyCustom);
["dFrom", "dTo"].forEach((id) => {
  $(id).addEventListener("change", applyCustom);
  $(id).addEventListener("focus", () => openCal(id));
});
/* 日历面板 */
let calFor = null, calY = 0, calM = 0;
function openCal(which) {
  calFor = which;
  const base = which === "dFrom" ? (from ?? Date.now()) : (to ?? Date.now());
  const d = new Date(base);
  calY = d.getFullYear(); calM = d.getMonth();
  $("calPanel").classList.add("show");
  renderCal();
}
function closeCal() { $("calPanel").classList.remove("show"); }
function renderCal() {
  $("calTitle").textContent = calY + " 年 " + pad(calM + 1) + " 月";
  const first = new Date(calY, calM, 1);
  const startWd = (first.getDay() + 6) % 7; // 周一为一周开始
  const daysIn = new Date(calY, calM + 1, 0).getDate();
  const today = fmtD(Date.now());
  let html = "";
  for (let i = 0; i < startWd; i++) html += "<span></span>";
  for (let d = 1; d <= daysIn; d++) {
    const ts = +new Date(calY, calM, d);
    const cls = ["day"];
    if (fmtD(ts) === today) cls.push("mid");
    if (from !== null && fmtD(ts) === fmtD(from)) cls.push("sel");
    if (to !== null && fmtD(ts) === fmtD(to) && fmtD(from) !== fmtD(to)) cls.push("sel");
    html += '<button class="' + cls.join(" ") + '" data-ts="' + ts + '">' + d + "</button>";
  }
  $("calGrid").innerHTML = html;
}
$("calGrid").addEventListener("click", (e) => {
  const btn = e.target.closest("button.day");
  if (!btn) return;
  const ts = +btn.dataset.ts;
  if (calFor === "dFrom") applySpan(ts, to);
  else applySpan(from, ts + 864e5 - 1);
});
$("calPrev").addEventListener("click", () => { calM--; if (calM < 0) { calM = 11; calY--; } renderCal(); });
$("calNext").addEventListener("click", () => { calM++; if (calM > 11) { calM = 0; calY++; } renderCal(); });
$("calPanel").addEventListener("click", (e) => { if (e.target.closest("[data-q]")) setPreset(e.target.closest("[data-q]").dataset.q); });
document.addEventListener("click", (e) => {
  if (!$("calPanel").contains(e.target) && !$("datesBox").contains(e.target)) closeCal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCal(); });
window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));
setPreset("all");
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
