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
  if (price && price.override) acc.cost += estimateCost(t, price);
  else if ((r.cost || 0) > 0) acc.cost += r.cost;
  else if (price) acc.cost += estimateCost(t, price);
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
  // 细分数据：reasoning 单独展示，不参与求和
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
          box-shadow: 0 10px 26px rgba(91,108,255,.28); margin-bottom: 20px; }
  .hero h1 { margin: 0; font-size: 22px; letter-spacing: .5px; }
  .hero .sub { opacity: .85; font-size: 13px; margin-top: 6px; }
  .badge { background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.4); padding: 6px 16px;
           border-radius: 999px; font-size: 13px; white-space: nowrap; }
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
  .panel h3 { margin: 0; font-size: 15px; display: flex; align-items: center; justify-content: space-between; }
  .panel .desc { font-size: 12px; color: var(--muted); margin: 4px 0 6px; }
  #c1,#c2,#c3 { width: 100%; height: 340px; }
  .seg { display: inline-flex; background: #edeff8; border-radius: 999px; padding: 3px; }
  .seg button { border: 0; background: transparent; padding: 5px 16px; border-radius: 999px; font-size: 13px;
                cursor: pointer; color: var(--muted); font-family: inherit; }
  .seg button.on { background: #fff; color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,.15); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  th { color: var(--muted); font-weight: 600; text-align: right; padding: 10px 12px; border-bottom: 2px solid var(--border); white-space: nowrap; }
  td { text-align: right; padding: 9px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  tbody tr:hover { background: #f7f8ff; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #eef0ff; color: var(--accent); font-weight: 600; font-size: 12px; }
  footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 4px; }
</style></head><body>
<div class="wrap">
  <div class="hero">
    <div><h1>📊 OpenCode Token 用量报告</h1>
      <div class="sub">按模型 · 按日期 · 按项目 | reasoning 为 output 子集，不计入总量</div></div>
    <div class="badge">${summary.range.from ? `${summary.range.from} ~ ${summary.range.to}` : "暂无数据"}</div>
  </div>
  <div class="cards" id="cards"></div>
  <div class="panel"><h3>按模型</h3><div class="desc">各类 token 堆叠（cache = read + write）</div><div id="c1"></div></div>
  <div class="panel"><h3>按日期
    <span class="seg"><button id="btnTok" class="on">token</button><button id="btnCost">cost</button></span></h3>
    <div class="desc">每日用量趋势，可切换金额视图</div><div id="c2"></div></div>
  <div class="panel"><h3>按项目</h3><div class="desc">各项目目录的总 token 对比</div><div id="c3"></div></div>
  <div class="panel"><h3>明细（按模型汇总）</h3><div style="overflow-x:auto"><table id="tbl"></table></div></div>
  <footer>生成时间 ${generatedAt} · 数据源 ~/.config/opencode/usage/data.jsonl${summary.bad > 0 ? ` · 已跳过坏行 ${summary.bad} 条` : ""}</footer>
</div>
<script>${echartsJs}</script>
<script>
const S = ${payload};
const PAL = ["#5b6cff", "#22c1a4", "#f6a723"];
const nf = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e4 ? (v / 1e3).toFixed(1) + "K" : (v || 0).toLocaleString();
const tip = { trigger: "axis", backgroundColor: "#fff", borderColor: "#e8eaf3", textStyle: { color: "#1e2235", fontSize: 12 } };
const grid = { left: 60, right: 24, top: 40, bottom: 76 };
const axfmt = (v) => nf(v);
const trunc = (s) => s.length > 22 ? s.slice(0, 10) + "…" + s.slice(-10) : s;

const cards = [
  ["总 token", nf(S.totals.total), "tok"],
  ["总 cost", "$" + S.totals.cost.toFixed(4), "cost"],
  ["input 占比", S.totals.total ? (100 * S.totals.input / S.totals.total).toFixed(1) + "%" : "-", "inp"],
  ["output 占比", S.totals.total ? (100 * S.totals.output / S.totals.total).toFixed(1) + "%" : "-", "out"],
  ["cache read/write", '<small>' + nf(S.totals.cacheRead) + " / " + nf(S.totals.cacheWrite) + "</small>", ""],
  ["请求次数", String(S.totals.requests), ""],
  ["reasoning <small>(output 子集)</small>", nf(S.totals.reasoning), ""],
];
document.getElementById("cards").innerHTML = cards.map(([k, v, c]) =>
  \`<div class="card \${c}"><div class="label">\${k}</div><div class="value">\${v}</div></div>\`).join("");

const chart = (id) => echarts.init(document.getElementById(id));
const models = Object.keys(S.byModel);
chart("c1").setOption({
  color: PAL, tooltip: tip, legend: { bottom: 0, icon: "roundRect", itemWidth: 14, itemHeight: 8 },
  grid,
  xAxis: { type: "category", data: models, axisLabel: { interval: 0, rotate: 24, fontSize: 11, color: "#8189a3", formatter: trunc },
           axisLine: { lineStyle: { color: "#e8eaf3" } } },
  yAxis: { type: "value", axisLabel: { formatter: axfmt, color: "#8189a3" }, splitLine: { lineStyle: { color: "#f0f2f8" } } },
  series: [
    { name: "input", type: "bar", stack: "t", barMaxWidth: 46, itemStyle: { borderRadius: [0, 0, 0, 0] }, data: models.map((m) => S.byModel[m].input) },
    { name: "output", type: "bar", stack: "t", barMaxWidth: 46, data: models.map((m) => S.byModel[m].output) },
    { name: "cache", type: "bar", stack: "t", barMaxWidth: 46, itemStyle: { borderRadius: [6, 6, 0, 0] }, data: models.map((m) => S.byModel[m].cacheRead + S.byModel[m].cacheWrite) },
  ],
});

const dates = Object.keys(S.byDate).sort();
const c2 = chart("c2");
function drawDate(mode) {
  c2.setOption({
    color: PAL, tooltip: tip,
    legend: mode === "cost" ? undefined : { bottom: 0, icon: "roundRect", itemWidth: 14, itemHeight: 8 },
    grid,
    xAxis: { type: "category", data: dates, axisLabel: { color: "#8189a3" }, axisLine: { lineStyle: { color: "#e8eaf3" } } },
    yAxis: { type: "value", axisLabel: { formatter: mode === "cost" ? ((v) => "$" + nf(v)) : axfmt, color: "#8189a3" },
             splitLine: { lineStyle: { color: "#f0f2f8" } } },
    series: mode === "cost"
      ? [{ name: "cost", type: "line", smooth: true, symbolSize: 7,
           lineStyle: { width: 3, color: "#0ea572" }, itemStyle: { color: "#0ea572" }, areaStyle: { opacity: .12, color: "#0ea572" },
           data: dates.map((d) => +S.byDate[d].cost.toFixed(6)) }]
      : [
          { name: "input", type: "bar", stack: "t", barMaxWidth: 36, data: dates.map((d) => S.byDate[d].input) },
          { name: "output", type: "bar", stack: "t", barMaxWidth: 36, data: dates.map((d) => S.byDate[d].output) },
          { name: "cache", type: "bar", stack: "t", barMaxWidth: 36, itemStyle: { borderRadius: [6, 6, 0, 0] }, data: dates.map((d) => S.byDate[d].cacheRead + S.byDate[d].cacheWrite) },
        ],
  }, true);
}
const btnTok = document.getElementById("btnTok"), btnCost = document.getElementById("btnCost");
btnTok.onclick = () => { btnTok.classList.add("on"); btnCost.classList.remove("on"); drawDate("token"); };
btnCost.onclick = () => { btnCost.classList.add("on"); btnTok.classList.remove("on"); drawDate("cost"); };
drawDate("token");

const projects = Object.keys(S.byProject);
chart("c3").setOption({
  color: ["#5b6cff"], tooltip: tip, grid: { left: 60, right: 60, top: 16, bottom: 24 },
  xAxis: { type: "value", axisLabel: { formatter: axfmt, color: "#8189a3" }, splitLine: { lineStyle: { color: "#f0f2f8" } } },
  yAxis: { type: "category", data: projects, axisLabel: { color: "#1e2235", fontSize: 12 }, axisLine: { lineStyle: { color: "#e8eaf3" } } },
  series: [{ type: "bar", barMaxWidth: 22, itemStyle: { borderRadius: [0, 6, 6, 0] },
             data: projects.map((p) => S.byProject[p].total) }],
});

document.getElementById("tbl").innerHTML =
  "<thead><tr><th>模型</th><th>次数</th><th>input</th><th>output</th><th>reasoning</th><th>cache read</th><th>cache write</th><th>合计</th><th>cost</th><th>input%</th><th>output%</th></tr></thead><tbody>" +
  models.map((m) => { const a = S.byModel[m];
    return \`<tr><td><span class="pill">\${m}</span></td><td>\${a.requests}</td><td>\${a.input.toLocaleString()}</td><td>\${a.output.toLocaleString()}</td><td>\${a.reasoning.toLocaleString()}</td><td>\${a.cacheRead.toLocaleString()}</td><td>\${a.cacheWrite.toLocaleString()}</td><td><b>\${a.total.toLocaleString()}</b></td><td>$\${a.cost.toFixed(4)}</td><td>\${a.total ? (100 * a.input / a.total).toFixed(1) : 0}%</td><td>\${a.total ? (100 * a.output / a.total).toFixed(1) : 0}%</td></tr>\`; }).join("") +
  "</tbody>";
window.addEventListener("resize", () => { ["c1","c2","c3"].forEach((id) => chart(id).resize()); });
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

  const { records, bad } = readRecords(dataFile);
  const summary = aggregate(dedupe(records), loadPrices(pricesFile));
  summary.bad = bad;

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
  readRecords, dedupe, localDate, loadPrices, estimateCost, aggregate,
  renderText, renderHtml, openBrowser, parseArgs, main,
};
