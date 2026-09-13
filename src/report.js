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
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>OpenCode Token 用量报告</title>
<style>
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; margin: 24px; background: #f7f8fa; color: #222; }
  h1 { font-size: 20px; } .cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
  .card { background: #fff; border-radius: 8px; padding: 12px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card b { display: block; font-size: 20px; margin-top: 4px; }
  .chart { background: #fff; border-radius: 8px; padding: 12px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  #c1,#c2,#c3 { width: 100%; height: 360px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 13px; }
  th, td { border: 1px solid #e5e5e5; padding: 6px 10px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  .toggle button { margin-right: 8px; padding: 4px 12px; }
</style></head><body>
<h1>OpenCode Token 用量报告${summary.range.from ? `（${summary.range.from} ~ ${summary.range.to}）` : ""}</h1>
<div class="cards" id="cards"></div>
<div class="chart"><h3>按模型</h3><div id="c1"></div></div>
<div class="chart"><h3>按日期 <span class="toggle"><button id="btnTok">token</button><button id="btnCost">cost</button></span></h3><div id="c2"></div></div>
<div class="chart"><h3>按项目</h3><div id="c3"></div></div>
<h3>明细（按模型汇总）</h3><table id="tbl"></table>
<script>${echartsJs}</script>
<script>
const S = ${payload};
const cards = [
  ["总 token", S.totals.total.toLocaleString()], ["总 cost", "$" + S.totals.cost.toFixed(4)],
  ["input 占比", S.totals.total ? (100 * S.totals.input / S.totals.total).toFixed(1) + "%" : "-"],
  ["output 占比", S.totals.total ? (100 * S.totals.output / S.totals.total).toFixed(1) + "%" : "-"],
  ["请求次数", S.totals.requests],
  ["cache 细分", "read " + S.totals.cacheRead.toLocaleString() + " / write " + S.totals.cacheWrite.toLocaleString()],
  ["reasoning（output 子集，不计入总量）", S.totals.reasoning.toLocaleString()],
];
document.getElementById("cards").innerHTML = cards.map(([k, v]) => \`<div class="card">\${k}<b>\${v}</b></div>\`).join("");
const chart = (id) => echarts.init(document.getElementById(id));
const models = Object.keys(S.byModel);
chart("c1").setOption({
  tooltip: { trigger: "axis" }, legend: {},
  xAxis: { type: "category", data: models, axisLabel: { interval: 0, rotate: 30 } },
  yAxis: { type: "value" },
  series: [
    { name: "input", type: "bar", stack: "t", data: models.map((m) => S.byModel[m].input) },
    { name: "output", type: "bar", stack: "t", data: models.map((m) => S.byModel[m].output) },
    { name: "cache", type: "bar", stack: "t", data: models.map((m) => S.byModel[m].cacheRead + S.byModel[m].cacheWrite) },
  ],
});
const dates = Object.keys(S.byDate).sort();
const c2 = chart("c2");
function drawDate(mode) {
  c2.setOption({
    tooltip: { trigger: "axis" }, legend: {},
    xAxis: { type: "category", data: dates },
    yAxis: mode === "cost" ? { type: "value", name: "cost($)" } : { type: "value" },
    series: mode === "cost"
      ? [{ name: "cost", type: "line", data: dates.map((d) => +S.byDate[d].cost.toFixed(6)) }]
      : [
          { name: "input", type: "bar", stack: "t", data: dates.map((d) => S.byDate[d].input) },
          { name: "output", type: "bar", stack: "t", data: dates.map((d) => S.byDate[d].output) },
          { name: "cache", type: "bar", stack: "t", data: dates.map((d) => S.byDate[d].cacheRead + S.byDate[d].cacheWrite) },
        ],
  }, true);
}
document.getElementById("btnTok").onclick = () => drawDate("token");
document.getElementById("btnCost").onclick = () => drawDate("cost");
drawDate("token");
const projects = Object.keys(S.byProject);
chart("c3").setOption({
  tooltip: { trigger: "axis" },
  xAxis: { type: "value" },
  yAxis: { type: "category", data: projects },
  series: [{ type: "bar", data: projects.map((p) => S.byProject[p].total) }],
});
document.getElementById("tbl").innerHTML =
  "<tr><th>模型</th><th>次数</th><th>input</th><th>output</th><th>reasoning</th><th>cache read</th><th>cache write</th><th>合计</th><th>cost</th><th>input%</th><th>output%</th></tr>" +
  models.map((m) => { const a = S.byModel[m]; return \`<tr><td>\${m}</td><td>\${a.requests}</td><td>\${a.input.toLocaleString()}</td><td>\${a.output.toLocaleString()}</td><td>\${a.reasoning.toLocaleString()}</td><td>\${a.cacheRead.toLocaleString()}</td><td>\${a.cacheWrite.toLocaleString()}</td><td>\${a.total.toLocaleString()}</td><td>$\${a.cost.toFixed(4)}</td><td>\${a.total ? (100 * a.input / a.total).toFixed(1) : 0}%</td><td>\${a.total ? (100 * a.output / a.total).toFixed(1) : 0}%</td></tr>\`; }).join("");
</script></body></html>`;
}

module.exports = {
  readRecords, dedupe, localDate, loadPrices, estimateCost, aggregate,
  renderText, renderHtml,
};
