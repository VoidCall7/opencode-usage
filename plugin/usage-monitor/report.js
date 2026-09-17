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

/**
 * 按 messageID 去重，同一 messageID 保留「最后出现」的那条（记录可能被后续事件补全）。
 *
 * 为什么要保序：早先的实现是 `rest.concat([...byId.values()])`，把去重后的记录整体挪到末尾，
 * 输出不再按时间单调。现在下游（立方体聚合）不依赖顺序，但保持近似时间升序能让
 * readRecords → dedupe 的产物可被人肉核对，也避免将来做二分查找时踩坑。
 *
 * @param {Array<object>} records 原始记录（按行序）
 * @returns {Array<object>} 去重后的记录，位置取首次出现处，值取最后一次出现
 */
function dedupe(records) {
  const pos = new Map();
  const out = [];
  for (const r of records) {
    if (!r || !r.messageID) { out.push(r); continue; }
    if (pos.has(r.messageID)) out[pos.get(r.messageID)] = r; // 就地覆盖，不动位置
    else { pos.set(r.messageID, out.length); out.push(r); }
  }
  return out;
}

function localDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 项目分组键：把同一项目在不同记录里写法不一致的情况收敛成同一个键。
 *
 * 为什么必须归一化 —— projectPath 由 opencode 写入，会出现两类漂移：
 *   1) 路径分隔符混用：同一目录可能同时以 "E:/a/b" 与 "E:\a\b" 两种写法出现，
 *      不收敛就会被当成两个项目，各自算一份 token；
 *   2) projectPath 退化成根目录 "/"，真实路径只存在于 directory 字段里，
 *      结果「按项目」图里混进一个名为 "/" 的假项目（多个项目的量被并在它名下）。
 * 不归一化的后果不是「少一行」，而是名次和金额都错，且历史数据无从回填，只能在此收敛。
 *
 * 归一化放在取分组键处（而不是 recorder 落盘处），这样历史数据一并修好，无需回填。
 * 只做「明显同一路径」的收敛：反斜杠转正斜杠、折叠重复斜杠、去掉结尾斜杠。
 * 不做大小写折叠 —— Windows 下盘符大小写确实等价，但 POSIX 路径大小写敏感，
 * 统一转小写会把 Linux 上的两个真实目录并成一个，风险大于收益。
 *
 * @param {object} r 单条记录，读取 projectPath 与 directory
 * @returns {string} 归一化后的项目路径；无有效信息时返回 "(unknown)"
 */
function normProject(r) {
  let p = String((r && r.projectPath) || "").trim();
  const dir = String((r && r.directory) || "").trim();
  // 根目录/空值不是项目，回落到 directory（unix 与 windows 两种根写法都算）
  if (!p || p === "/" || p === "\\") p = dir;
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return p || "(unknown)";
}

function loadPrices(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * reasoning 中「确定不在 output 之内」的那部分 token 数。
 *
 * 记录里 reasoning 与 output 的关系并非全局一致：有的渠道 reasoning 是 output 的子集
 * （OpenAI 系 completion_tokens 已含 reasoning_tokens），有的渠道（多为中转站）把思考
 * token 单独计数。判据只有一条可靠的：**若 reasoning > output，则 output 不可能包含
 * reasoning**，此时 reasoning 必然要额外计入。反向（reasoning <= output）无法区分两种
 * 语义，按「已包含」处理，这是偏保守的一侧。
 *
 * 实际语料里存在大量 reasoning > output 的记录，且 reasoning 总量与 output 总量处于同一量级
 * —— 若真是子集，两者不可能接近相等。因此不补这部分会系统性低估 token 合计与成本。
 *
 * @param {{output?: number, reasoning?: number}} tokens
 * @returns {number} 需要额外计入的 reasoning token 数（0 表示无需补）
 */
function reasoningOverflow(tokens) {
  const t = tokens || {};
  const out = t.output || 0;
  const reas = t.reasoning || 0;
  return reas > out ? reas : 0;
}

/**
 * 按牌价计算单条记录成本 —— 全报告唯一的成本算法（resolveCost 只是它的适配壳）。
 * 输出侧按 output + reasoningOverflow 计费，与 reasoning 口径修正保持一致
 * （否则修了 token 合计却没修成本，两边会互相矛盾）。
 *
 * @param {{input?:number,output?:number,reasoning?:number,cacheRead?:number,cacheWrite?:number}} tokens
 * @param {{input?:number,output?:number,cacheRead?:number,cacheWrite?:number}} price 每百万 token 单价
 * @returns {number} 美元成本
 */
function estimateCost(tokens, price) {
  const t = tokens || {};
  return (
    (t.input || 0) * (price.input || 0) +
    ((t.output || 0) + reasoningOverflow(t)) * (price.output || 0) +
    (t.cacheRead || 0) * (price.cacheRead || 0) +
    (t.cacheWrite || 0) * (price.cacheWrite || 0)
  ) / 1e6;
}

// 成本口径只有一条：**记录 token × 牌价**（prices.json）。刻意不读记录自带的 cost 字段 ——
// 该字段由上游/中转渠道按各自口径写入，常与本机 prices.json 的单价明显不同（同一批记录上
// 两个来源能差出近一倍）。两个来源混在同一列里比大小，只会让人把其中一个误当成真实账单，
// 比单一来源更误导。要调价就改 prices.json，不看记录里的 cost。

/**
 * 单条记录成本 = Σ(token × 对应单价) / 1e6。四个桶分别计价，输出侧加上 reasoning 溢出量
 * （与 reasoningOverflow 的合计口径一致，避免「修了 token 合计却没修成本」两边互相矛盾）。
 * 输入只有记录与牌价两样，没有任何来源分支 —— 缺牌价就是 0，不拿记录自带的 cost 兜底。
 *
 * @param {object} r 单条记录（只读 r.tokens）
 * @param {object|undefined} price prices.json 中 `provider/model` 对应的条目
 * @returns {number} 美元成本（无牌价时为 0）
 */
function resolveCost(r, price) {
  return estimateCost(r.tokens || {}, price || {});
}

/**
 * 聚合累加器。字段口径：
 * - requests   记录条数（含空响应）
 * - emptyReqs  其中 token 全为 0 的条数（空响应/错误响应），用于把「请求次数」和「有效请求」分开
 * - reasoningOver  reasoning 超出 output 的部分（见 reasoningOverflow），已计入 total
 * - total      input + output + cacheRead + cacheWrite + reasoningOver
 * - cost       合计成本（牌价单一来源，不做来源拆分）
 */
const emptyAcc = () => ({
  requests: 0, emptyReqs: 0,
  input: 0, output: 0, reasoning: 0, reasoningOver: 0,
  cacheRead: 0, cacheWrite: 0, total: 0,
  cost: 0,
});

function addRecord(acc, r, price) {
  const t = r.tokens || {};
  const over = reasoningOverflow(t);
  acc.requests++;
  if (!((t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) + (t.reasoning || 0))) acc.emptyReqs++;
  acc.input += t.input || 0;
  acc.output += t.output || 0;
  acc.reasoning += t.reasoning || 0;
  acc.reasoningOver += over;
  acc.cacheRead += t.cacheRead || 0;
  acc.cacheWrite += t.cacheWrite || 0;
  acc.total += (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) + over;
  acc.cost += resolveCost(r, price);
  return acc;
}

/** 把 src 累加器并入 dst（浏览器端合并同名模型、verify 里跨实现对照都用它） */
function mergeAcc(dst, src) {
  dst.requests += src.requests; dst.emptyReqs += src.emptyReqs;
  dst.input += src.input; dst.output += src.output;
  dst.reasoning += src.reasoning; dst.reasoningOver += src.reasoningOver;
  dst.cacheRead += src.cacheRead; dst.cacheWrite += src.cacheWrite;
  dst.total += src.total; dst.cost += src.cost;
  return dst;
}

/**
 * 服务端逐条聚合，只为终端输出（HTML 端从立方体重算，不走这里）。
 *
 * @param {Array<object>} records 已去重的记录
 * @param {object} prices prices.json；传 {} 表示成本已在记录上预解析好
 */
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
    const proj = normProject(r);
    addRecord((byProject[proj] = byProject[proj] || emptyAcc()), r, price);
  }
  const dates = Object.keys(byDate).sort();
  return {
    range: { from: dates[0] || null, to: dates[dates.length - 1] || null },
    totals, byModel, byDate, byProject,
    bad: 0,
  };
}

const fmt = (n) => n.toLocaleString("en-US");
const fmtCost = (c) => c >= 100 ? "$" + c.toFixed(2) : "$" + c.toFixed(4);
const pct = (part, whole) => (whole > 0 ? ((part / whole) * 100).toFixed(1) + "%" : "0.0%");

function renderText(summary) {
  const lines = [];
  lines.push(
    `OpenCode Token 用量报告` +
      (summary.range.from ? `（${summary.range.from} ~ ${summary.range.to}）` : "（无数据）")
  );
  if (summary.bad > 0) lines.push(`（跳过坏行：${summary.bad}）`);
  lines.push(
    "模型".padEnd(30) + "次数".padStart(6) + "空响应".padStart(7) + "input".padStart(12) +
    "output".padStart(12) + "cache".padStart(12) + "合计".padStart(12) +
    "cost".padStart(12) + "input%".padStart(9) + "output%".padStart(9)
  );
  const line = (name, a) =>
    name.padEnd(30) + String(a.requests).padStart(6) + String(a.emptyReqs).padStart(7) +
    fmt(a.input).padStart(12) + fmt(a.output).padStart(12) +
    fmt(a.cacheRead + a.cacheWrite).padStart(12) + fmt(a.total).padStart(12) +
    fmtCost(a.cost).padStart(12) +
    pct(a.input, a.total).padStart(9) + pct(a.output, a.total).padStart(9);
  // 按合计降序：byModel 是插入序（首次出现顺序），直接遍历会让终端输出看着像乱序
  Object.entries(summary.byModel)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([key, a]) => lines.push(line(key, a)));
  const t = summary.totals;
  lines.push(line("TOTAL", t));
  // 成本口径在终端也要写明白：这个数字是「记录 × 牌价」算出来的，不是账单。
  lines.push(`成本口径：记录 token × prices.json 单价，合计 ${fmtCost(t.cost)}（单一来源，不读记录自带 cost）`);
  lines.push(
    `reasoning：${fmt(t.reasoning)}（单列）· 其中 ${fmt(t.reasoningOver)} 超出 output，已计入合计与成本`
  );
  return lines.join("\n");
}

/**
 * 把记录压成「字典表 + 数组行」再嵌进 HTML。
 *
 * 逐条嵌入的体积随消息数线性增长，长期使用会到 MB 量级，但真正有区分度的组合极少：
 * 记录数虽大，「日 × 项目 × 渠道 × 模型」的基数通常只有几百。四种时间粒度（日/周/月/年）
 * 都是从日粒度滚动求和得到的，按项目的那张图也只取总量，所以改成日粒度立方体对现有全部
 * 视图是**无损**的，体积则能小两三个数量级，切换区间的工作量也从 O(消息数) 降到 O(立方体行数)。
 *
 * 代价：失去日内时间分布、以及将来按 session 下钻的能力（两者目前都没有用到）。
 *
 * 成本在服务端就按牌价算好，立方体只带一列 cost —— 前端不再做任何成本来源判断。
 *
 * @param {Array<object>} records 已去重的记录
 * @param {object} prices prices.json
 * @returns {{days: string[], hash: {projectPath: string[], providerID: string[], modelID: string[]}, rows: Array<Array<number>>}}
 *   行格式 [dayIdx, projectIdx, providerIdx, modelIdx, requests, emptyReqs,
 *           input, output, reasoning, reasoningOver, cacheRead, cacheWrite, cost]
 */
function buildCube(records, prices) {
  const hash = { projectPath: [], providerID: [], modelID: [] };
  const dict = { projectPath: new Map(), providerID: new Map(), modelID: new Map() };
  const idOf = (field, v) => {
    const val = v || "";
    const m = dict[field];
    if (m.has(val)) return m.get(val);
    const i = hash[field].length;
    hash[field].push(val);
    m.set(val, i);
    return i;
  };
  const cells = new Map(); // key: "day|proj|prov|model"
  for (const r of records) {
    const t = r.tokens || {};
    const day = localDate(r.time || 0);
    // 项目列必须走 normProject：浏览器的 byProject 是直接从这份字典重建的，
    // 这里存什么键，前端就按什么键分组。存原始 projectPath 会让 "/" 与反斜杠变体
    // 一直带到屏幕上（历史数据无从回填，只能在此收敛）。
    const key = [day, idOf("projectPath", normProject(r)), idOf("providerID", r.providerID), idOf("modelID", r.modelID)].join("|");
    let c = cells.get(key);
    if (!c) {
      c = { requests: 0, emptyReqs: 0, input: 0, output: 0, reasoning: 0, reasoningOver: 0,
            cacheRead: 0, cacheWrite: 0, cost: 0 };
      cells.set(key, c);
    }
    const over = reasoningOverflow(t);
    c.requests++;
    if (!((t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) + (t.reasoning || 0))) c.emptyReqs++;
    c.input += t.input || 0;
    c.output += t.output || 0;
    c.reasoning += t.reasoning || 0;
    c.reasoningOver += over;
    c.cacheRead += t.cacheRead || 0;
    c.cacheWrite += t.cacheWrite || 0;
    c.cost += resolveCost(r, prices[`${r.providerID || ""}/${r.modelID || ""}`]);
  }
  // 日字符串先排序再转索引，保证 days 升序（前端按下标取日期，且区间过滤要靠字符串可直接比较）
  const days = [...new Set([...cells.keys()].map((k) => k.slice(0, k.indexOf("|"))))].sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  // 只对成本列做舍入（其余都是整数）。立方体只有百来行，用 8 位小数：单格误差 < 5e-9，
  // 全量累计误差可以忽略；逐条聚合时行数一大、只取 6 位就会累出百分之一级别的偏差。
  const r8 = (v) => Math.round(v * 1e8) / 1e8;
  const rows = [];
  for (const [key, c] of cells) {
    const [day, p, pv, m] = key.split("|");
    rows.push([dayIdx.get(day), +p, +pv, +m,
      c.requests, c.emptyReqs, c.input, c.output, c.reasoning, c.reasoningOver,
      c.cacheRead, c.cacheWrite, r8(c.cost)]);
  }
  return { days, hash, rows };
}

function renderHtml(summary, echartsJs) {
  // 浏览器端从立方体自行聚合；totals/byModel/byDate/byProject 只有终端输出需要，不进 payload。
  // 成本已在 Node 端按牌价算完，立方体只带一列 cost。
  const cube = buildCube(summary.records || [], summary.prices || {});
  const payload = JSON.stringify({ bad: summary.bad, days: cube.days, hash: cube.hash, rows: cube.rows }).replace(/</g, "\\u003c");
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
  .chip.go { color: var(--ink); }
  /* 时间范围下拉框 */
  .selwrap { position: relative; display: inline-flex; align-items: center; gap: 8px; }
  select.sel { appearance: none; -webkit-appearance: none; background: #161616; color: var(--ink);
               border: 1px solid var(--line); font: inherit; font-size: 12px; padding: 5px 28px 5px 11px;
               cursor: pointer; min-width: 134px; }
  select.sel:hover { border-color: #454545; }
  select.sel:focus { outline: none; border-color: var(--acc); }
  select.sel option, select.sel optgroup { background: #161616; color: var(--ink); }
  .selwrap::after { content: "\\25BE"; position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
                    color: var(--dim); font-size: 10px; pointer-events: none; }
  /* 自定义区间入口：独立于下拉框。虚线边框表示「尚未选定」，选好后 .on 变实色高亮 */
  .rbtn { border: 1px dashed #3a3a3a; background: #161616; color: var(--mut); font: inherit; font-size: 12px;
          padding: 5px 11px; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .rbtn:hover { border-color: #6a6a6a; color: var(--ink); }
  .rbtn.on, .rbtn.open { border-style: solid; border-color: var(--acc); color: var(--acc); }
  /* 双月区间选择器 */
  .cal { position: absolute; top: calc(100% + 8px); left: 0; background: #131313; border: 1px solid #2e2e2e;
         box-shadow: 0 18px 44px rgba(0,0,0,.7); padding: 12px 14px 10px; z-index: 60; display: none;
         max-width: calc(100vw - 40px); }
  .cal.show { display: block; }
  .cal .calh { display: flex; align-items: center; gap: 2px; margin-bottom: 10px;
               padding-bottom: 9px; border-bottom: 1px solid var(--line); }
  .cal .calh b { font-size: 13px; letter-spacing: .5px; margin: 0 6px; white-space: nowrap; }
  .cal .calh .sp { flex: 1; }
  .cal .nav { border: 0; background: transparent; color: var(--mut); font: inherit; font-size: 14px;
              cursor: pointer; padding: 2px 7px; line-height: 1; }
  .cal .nav:hover { color: var(--acc); }
  .cal select.sel { min-width: 84px; padding: 3px 24px 3px 9px; font-size: 11px; }
  /* 固定列宽：容器是收缩包裹的绝对定位元素，用 1fr 会被压成每格 20px 左右 */
  .cal .months { display: grid; grid-template-columns: repeat(2, 210px); gap: 20px; }
  .cal .mlab { color: var(--mut); font-size: 11px; letter-spacing: 1px; text-align: center;
               padding-bottom: 5px; margin-bottom: 4px; }
  .cal .grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; }
  .cal .wd { color: var(--dim); font-size: 10px; text-align: center; padding: 3px 0; }
  .cal .day { border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 12px;
              padding: 5px 0; cursor: pointer; font-variant-numeric: tabular-nums; max-width: 100%; }
  .cal .day:hover { background: #2a2a2a; }
  .cal .day.out { cursor: default; }
  .cal .day.out:hover { background: transparent; }
  .cal .day.today { box-shadow: inset 0 0 0 1px #414141; }
  .cal .day.mid { background: #2b1a07; color: #ffb066; }
  .cal .day.pre { background: #1d1403; color: #9c6a35; }
  .cal .day.sel { background: var(--acc); color: #000; font-weight: 700; }
  .cal .calf { display: flex; align-items: center; gap: 8px; margin-top: 10px;
               padding-top: 9px; border-top: 1px solid var(--line); }
  .cal .calf .pick { color: var(--dim); font-size: 11px; font-variant-numeric: tabular-nums; }
  .cal .calf .pick b { color: var(--acc); font-weight: 400; }
  .cal .calf .sp { flex: 1; }
  .cal .calq { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .cal .calq .chip { font-size: 11px; padding: 3px 9px; }
  section { border-bottom: 1px solid var(--line); padding: 42px 32px 52px; }
  .sec-h { margin: 0 0 8px; font-size: 24px; letter-spacing: -.5px; }
  .sec-h span { color: var(--mut); font-size: 14px; font-weight: 400; margin-left: 10px; }
  /* 「导出 CSV」靠在标题行右侧：float 让副标题（span）仍留在标题后面，不被推走 */
  .sec-h .exp { float: right; margin-top: 3px; }
  .sec-d { color: var(--dim); font-size: 12px; margin: 0 0 26px; }
  .hint { color: var(--dim); font-size: 11px; margin-top: 10px; letter-spacing: .3px; }
  .hint b { color: var(--acc); font-weight: 400; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(136px, 1fr)); gap: 1px;
           background: var(--line); border: 1px solid var(--line); }
  .stat { background: #111; padding: 18px 20px; }
  .stat .k { color: var(--dim); font-size: 10px; letter-spacing: 1.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat .v { font-size: 22px; font-weight: 700; margin-top: 10px; line-height: 1.15; font-variant-numeric: tabular-nums; }
  .stat.a .v { color: var(--acc); } .stat.g .v { color: #4ade80; } .stat.c .v { color: #22d3ee; }
  .stat.o .v { color: #ff9f1c; } .stat.p .v { color: #e879f9; }
  /* reasoning 补计角标：主值右侧一个极小的 *。它是「指针」不是「说明文字」，所以可以内联进主值行
     （说明文字仍一律下沉副值行）。line-height:0 让它挂在基线之上却不撑高行盒 —— 否则这一行的
     行高会比其他卡高一点，整排卡片的底边就参差了。图例见 #mkLegend。 */
  .stat .v sup.mk { font-size: 11px; font-weight: 400; color: var(--dim);
                    vertical-align: super; line-height: 0; margin-left: 2px; }
  /* 副值独占一行，永远不会和主值排在同一行 —— 早先 <small> 内联在 .v 里，内容一长就断行、
     出孤字（数字与限定词被拆散），且无法保证「主值在上、说明在下」的阅读顺序。
     副值内部只由若干「不可断开片段」<i> 拼成（见 renderStats 的 seg()）：中文没有词边界，
     放任浏览器折行会把「补计」「命中」这类词从中间劈开。 */
  .stat .s { color: var(--mut); font-size: 11px; margin-top: 6px; line-height: 1.45; }
  .stat .s i { font-style: normal; display: inline-block; margin-right: 9px; }
  .stat .s i:last-child { margin-right: 0; }
  /* 环比涨跌：颜色只是辅助，箭头和正负号本身已经表达了方向（不依赖颜色也能读） */
  .stat .s .up { color: #f43f5e; }
  .stat .s .dn { color: #4ade80; }
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
       text-align: right; padding: 0 10px 4px; white-space: nowrap; }
  /* 表头即排序开关：data-i 只加在可排序的表头上，鼠标样式据此变化 */
  th[data-i] { cursor: pointer; user-select: none; }
  th[data-i]:hover { color: #dcdcdc; }
  th.on { color: var(--acc); }
  td { background: #161616; text-align: right; padding: 10px 10px; white-space: nowrap; }
  /* 空响应异常率（≥20% 且请求数 ≥5）标红；reasoning 补计用 .dim 弱化，不再内联 <small> */
  td .hot { color: #f43f5e; }
  .dim { color: var(--mut); }
  td:first-child { border-radius: 4px 0 0 4px; } td:last-child { border-radius: 0 4px 4px 0; }
  th:first-child, td:first-child { text-align: left; }
  tbody tr:hover td { background: #1f1f1f; }
  tr.total td { background: #201302; font-weight: 700; }
  tr.total td:first-child { border-left: 2px solid var(--acc); color: var(--acc); }
  .mdot { display: inline-block; width: 8px; height: 8px; margin-right: 8px; vertical-align: baseline; }
  footer { color: var(--dim); font-size: 11px; letter-spacing: .5px; padding: 26px 32px 40px; }
  @media (max-width: 720px) {
    .hero h1 { font-size: 30px; }
    .topbar, .toolbar, section, footer { padding-left: 16px; padding-right: 16px; }
    .cal .months { grid-template-columns: 1fr; gap: 14px; }
    .cal { left: auto; right: 0; }
  }
</style></head><body>
<div class="topbar"><div class="logo">OPENCODE · USAGE</div><div class="gen">GENERATED ${generatedAt}</div></div>
<div class="hero"><div class="wrap">
  <div class="upd">[*] 已更新 ${generatedAt}</div>
  <h1>Token 用量报告<span>.</span></h1>
  <p>本地 OpenCode 的 token 消耗与成本，按模型、按项目、按时间统计。<b>成本口径</b>只有一条：每条记录的 token 乘以 prices.json 里的单价（记录 token × 牌价），没有第二套来源，所以看到的就是按当前价目表算出来的金额，不是账单。<b>reasoning</b>单列统计；当某条记录的 reasoning 超过 output（部分中转渠道把思考 token 单独计数）时，超出部分计入合计与成本。</p>
</div></div>
<div class="toolbar"><div class="tin">
  <span class="grp"><span class="lb">时间</span>
    <span class="selwrap">
      <select id="selRange" class="sel"></select>
      <button id="rangeBtn" class="rbtn" title="选择自定义区间"><span id="rangeTxt">自定义区间</span></button>
      <div class="cal" id="calPanel">
        <div class="calh">
          <button class="nav" id="calPrevY" title="上一年">«</button><button class="nav" id="calPrev" title="上个月">‹</button>
          <b id="calTitle"></b>
          <button class="nav" id="calNext" title="下个月">›</button><button class="nav" id="calNextY" title="下一年">»</button>
          <span class="sp"></span>
          <span class="selwrap"><select id="calYSel" class="sel" title="跳转到年份"></select></span>
        </div>
        <div class="months">
          <div><div class="mlab" id="calT0"></div><div class="grid" id="calWd0"></div><div class="grid" id="calG0"></div></div>
          <div><div class="mlab" id="calT1"></div><div class="grid" id="calWd1"></div><div class="grid" id="calG1"></div></div>
        </div>
        <div class="calq" id="calQuick"></div>
        <div class="calf">
          <span class="pick" id="calPick"></span>
          <span class="sp"></span>
          <button class="chip" id="calClear">清除</button>
          <button class="chip go" id="calOk">确定</button>
        </div>
      </div>
    </span>
  </span>
  <span class="sp"></span>
  <span class="grp"><span class="lb">粒度</span>
    <span class="grp" id="segGran"><button class="chip" data-g="auto">自动</button><button class="chip" data-g="day">日</button><button class="chip" data-g="week">周</button><button class="chip" data-g="month">月</button><button class="chip" data-g="year">年</button></span>
  </span>
  <span class="grp"><span class="lb">指标</span>
    <span class="grp" id="segMetric"><button class="chip" data-m="token">TOKEN</button><button class="chip" data-m="cost">COST</button></span>
  </span>
  <span class="grp"><span class="lb">模型口径</span>
    <span class="grp" id="segScope"><button class="chip" data-s="split">按渠道拆分</button><button class="chip" data-s="merge">合并同名</button></span>
  </span>
</div></div>
<section><div class="wrap">
  <div id="empty">该时间范围内暂无数据</div>
  <div class="stats" id="cards"></div>
  <div class="hint" id="mkLegend" style="display:none"></div>
</div></section>
<section><div class="wrap"><h2 class="sec-h">用量趋势<span>各模型用量占比堆叠（前 8 + 其他）· 悬停看单列明细 · 点击图例隐藏模型 · TOKEN / COST 可切换</span></h2><div id="trend" style="height:340px"></div><div class="hint" id="trendHint"></div></div></section>
<section><div class="wrap"><h2 class="sec-h">模型分布<span>构成与用量排行 · 同名模型跨渠道是否合并见上方「模型口径」</span></h2>
  <div class="strips" id="dist"></div><div id="rank"></div></div></section>
<section><div class="wrap"><h2 class="sec-h">按项目<span>各项目目录的总 token 对比</span></h2><div id="c3"></div></div></section>
<section><div class="wrap"><h2 class="sec-h">明细<span>按模型汇总 · 点表头排序 · cost = 该行 token × prices.json 单价 · 「缓存命中」= cacheRead / (input + cacheRead)，是解释成本高低的主因</span><button id="csvBtn" class="chip exp" title="把当前区间、当前口径下的明细导出为 CSV（含合计行）">导出 CSV</button></h2><div style="overflow-x:auto"><table id="tbl"></table></div></div></section>
<footer>[*] 生成时间 ${generatedAt} · 数据源 ~/.config/opencode/usage/data.jsonl${summary.bad > 0 ? ` · 已跳过坏行 ${summary.bad} 条` : ""} · 页面数据为「日 × 项目 × 渠道 × 模型」立方体，逐条明细在 data.jsonl</footer>
<script>${echartsJs}</script>
<script>
const S = ${payload};
/* payload 是「日 × 项目 × 渠道 × 模型」立方体：逐条嵌入会随消息数线性膨胀（43k 条 → 2.1MB），
   而有区分度的组合只有 241 组。四种时间粒度都是日粒度滚动求和，故立方体对现有视图无损。
   行格式 [dayIdx, projectIdx, providerIdx, modelIdx, requests, emptyReqs,
           input, output, reasoning, reasoningOver, cacheRead, cacheWrite, cost] */
const H = S.hash || { projectPath: [], providerID: [], modelID: [] };
const DAYS = S.days || [];
const R = (S.rows || []).map((a) => ({
  day: DAYS[a[0]] || "",
  projectPath: H.projectPath[a[1]] || "",
  providerID: H.providerID[a[2]] || "",
  modelID: H.modelID[a[3]] || "",
  reqs: a[4], empty: a[5],
  input: a[6], output: a[7], reasoning: a[8], over: a[9],
  cacheRead: a[10], cacheWrite: a[11],
  cost: a[12],
}));
const PAL = ["#ff9f1c", "#e879f9", "#a78bfa", "#22d3ee", "#4ade80", "#f43f5e", "#facc15", "#60a5fa", "#2dd4bf", "#fb7185"];
const INK = "#f2f2f2", MUT = "#8f8f8f", DIM = "#5c5c5c", LINE = "#262626", SPLIT = "#1c1c1c", ACC = "#ff6a00";
const $ = (id) => document.getElementById(id);
/* 报告生成时间由 Node 端在生成时固化进来（客户端不重新取时钟）：导出 CSV 里要写同一时刻，
   与页面页眉显示的保持一致，否则「页面说 14:57 生成、CSV 说 15:20 生成」会让人怀疑数据不同源 */
const GEN = ${JSON.stringify(generatedAt)};
const nf = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e4 ? (v / 1e3).toFixed(1) + "K" : (v || 0).toLocaleString();
/* 自适应精度 + 去尾零。
   大额只给 2 位：这一档数字是牌价算出来的，多给小数位是在制造假精度（$1,549.08 里的 .08 只反映单价的小数位）；
   小额按量级多给几位，否则 $0.0008 会被抹成 $0.0008→$0.001 甚至 $0.00 而丢失信息。 */
const money = (v) => {
  const n = v || 0;
  if (!n) return "$0";
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : 6;
  const [int, frac] = n.toFixed(digits).split(".");
  // 去掉多余尾零，但至少保留 2 位，避免金额看着不像金额（$100.00 不要变成 $100）
  let trimmed = (frac || "").replace(/0+$/, "");
  if (trimmed.length < 2) trimmed = (frac || "").slice(0, 2);
  return "$" + Number(int).toLocaleString("en-US") + (trimmed ? "." + trimmed : "");
};
const tip = { trigger: "axis", backgroundColor: "#1a1a1a", borderColor: "#333", textStyle: { color: "#eee", fontSize: 12 } };
/**
 * 轴标签截断：保留**尾部路径段**，从左侧丢字符。
 *
 * 为什么是尾部而不是居中：这两张图（按项目 / 模型排行）的类目都是「父/父/叶子」形式的标识符，
 * 有区分度的是**叶子**，前面是所有人共享的盘符与仓库目录。原来的居中截断（头 11 + … + 尾 11）
 * 会把「E:/goproject/prompt-gitops-controller」与「E:/goproject/ai-slo-probe-controller」都切成
 * 「E:/goprojec…-controller」—— 类目本身是唯一的（两根柱子都在），但标签长得一模一样，
 * 只能逐个悬停才能分辨，「两根柱子无法区分」的问题只解决了一半。
 *
 * 注意：本段属于客户端脚本（嵌在模板字面量里），注释里也不能出现反引号 —— 单个反引号会
 * 提前结束模板字面量，生成时报 SyntaxError: Unexpected identifier。
 *
 * 规则：≤26 字符原样返回；否则从叶子往上一层一层地拼，能拼到哪层算哪层；
 * 加省略号后仍在预算内就加「…/」，否则退化为只保尾 25 字符（仍带省略号，
 * 不能返回一个看起来像完整路径的裸叶子 —— 那会让人以为路径没被截断）。
 * 26 这个上限来自实测：轴标签区约 140px / 11px 字号，再长就只能从绘图区里抢宽度。
 *
 * @param {string} s 完整路径 / 模型标识
 * @returns {string} 可直接画在轴上的短标签（长度 ≤26，且内容被丢过时必带省略号）
 */
const LABEL_MAX = 26;
function trunc(s) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= LABEL_MAX) return str;
  const parts = str.split("/");
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const cand = parts[i] + "/" + out;
    if (cand.length > LABEL_MAX) break;
    out = cand;
  }
  // 加省略号后仍在预算内 → 保留「丢了头部」这个信息
  if (out.length + 2 <= LABEL_MAX) return "…/" + out;
  // 叶子本身就超长（没有目录层级可丢）→ 只能保尾，但省略号必须在
  return "…" + out.slice(-(LABEL_MAX - 1));
}
// from/to 为本地时间毫秒边界：from = 起始日 00:00，to = 结束日 23:59:59.999。
// 立方体按日字符串存储，过滤实际用的是从它们推出的 fromDay/toDay（千分秒边界换算成日界，含首含尾）。
let from = null, to = null, fromDay = null, toDay = null;
let gran = "day", granAuto = true, metric = "token", scope = "split", rangeKey = "all";
const charts = {};
const DAY = 864e5;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/* 趋势图的列数控制。跨度大时（例如「全部时间」攒到 1000 天以上）柱状图会退化成一片
   1px 宽的色带，x 轴标签也挤成一团，必须有明确的降级策略：
   - ZOOM_AT  列数超过它就启用 dataZoom（滚轮缩放 + 拖动平移 + 底部滑块）
   - WIN_COLS 启用缩放时默认聚焦最近这么多列（长期使用通常只关心最近一段）
   - MAX_COLS 硬上限。手动选定粒度也可能产生几千列（日粒度 × 10 年 = 3650 列），
              超过就逐步粗化粒度，宁可粗也不要卡死浏览器 */
const ZOOM_AT = 60, WIN_COLS = 90, MAX_COLS = 1200;
const GRAN_ORDER = ["day", "week", "month", "year"];
/* 网格留白。滑块必须左对齐网格、右端再多让出 SLIDER_PAD：
   dataZoom 滑块的把手标签画在把手的**外侧**，右端那个如果贴着画布边缘就会超出画布被裁掉
   （表现为只显示成「202」）。左端之所以看不出问题，是因为左侧本来就有 y 轴那 64px 留白。 */
const GRID_L = 64, GRID_R = 24, SLIDER_PAD = 32;

/* 时间范围预设：分组 → [[值, 标签]]。下拉框与日历面板的快捷按钮都由它生成，保证两处不漂移。
   自定义区间不在这里 —— 它是下拉框旁边的独立按钮（#rangeBtn），不走预设通道 */
const PRESET_GROUPS = [
  { g: "快捷", items: [["all", "全部时间"], ["today", "今天"], ["yesterday", "昨天"], ["d7", "近 7 天"], ["d14", "近 14 天"], ["d30", "近 30 天"], ["d90", "近 90 天"]] },
  { g: "自然周期", items: [["week", "本周"], ["lastweek", "上周"], ["month", "本月"], ["lastmonth", "上个月"], ["quarter", "本季度"], ["lastquarter", "上季度"], ["year", "今年"], ["lastyear", "去年"]] },
];
const PRESET_LABEL = {};
PRESET_GROUPS.forEach((g) => g.items.forEach(([v, l]) => { PRESET_LABEL[v] = l; }));
// 日历面板底部的快捷按钮（面板本身就是自定义入口，不再放"自定义"项）
const QUICK_KEYS = ["d7", "d14", "d30", "week", "lastweek", "month", "lastmonth", "quarter", "year", "all"];
let R_MIN = 0, R_MAX = 0; // 全量数据的时间范围，用于「全部时间」下推断粒度

function emptyT() {
  return { requests: 0, emptyReqs: 0, input: 0, output: 0, reasoning: 0, reasoningOver: 0,
           cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}
/**
 * 把一行立方体累加进聚合器。
 * total = input + output + cacheRead + cacheWrite + reasoningOver（口径见服务端 reasoningOverflow）
 * cost 直接透传立方体里的单列成本（已在服务端按牌价算好）
 */
function addT(a, r) {
  a.requests += r.reqs || 0;
  a.emptyReqs += r.empty || 0;
  a.input += r.input || 0;
  a.output += r.output || 0;
  a.reasoning += r.reasoning || 0;
  a.reasoningOver += r.over || 0;
  a.cacheRead += r.cacheRead || 0;
  a.cacheWrite += r.cacheWrite || 0;
  a.total += (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0) + (r.over || 0);
  a.cost += r.cost || 0;
}
function addAcc(dst, a) {
  dst.requests += a.requests; dst.emptyReqs += a.emptyReqs;
  dst.input += a.input; dst.output += a.output;
  dst.reasoning += a.reasoning; dst.reasoningOver += a.reasoningOver;
  dst.cacheRead += a.cacheRead; dst.cacheWrite += a.cacheWrite;
  dst.total += a.total; dst.cost += a.cost;
}

/**
 * 上一「等长区间」的日界，用于环比。
 *
 * 为什么必须按天数而不是按毫秒跨度：from/to 是「起始日 00:00 ~ 结束日 23:59:59.999」，
 * 直接相减再除 DAY 会得到 0.99（单日）这类值，四舍五入后单日区间会被算成 2 天。
 * 这里先用本地年月日算出天数 n，再从起始日往前推 n 天，边界天然落在日界上。
 * 用 new Date(y, m-1, d) 而不是 Date.UTC：fmtD 按本地时区取年月日，
 * 传 UTC 毫秒会在负时区把日期挪前一天。
 *
 * @returns {[string, string]|null} [上一区间起日, 上一区间止日]；「全部时间」无可比区间时返回 null
 */
function prevSpan() {
  if (fromDay === null || toDay === null) return null;
  const a = dayParts(fromDay), b = dayParts(toDay);
  if (!a || !b) return null;
  const aMs = +new Date(a[0], a[1] - 1, a[2]);
  const bMs = +new Date(b[0], b[1] - 1, b[2]);
  const n = Math.round((bMs - aMs) / DAY) + 1;
  const pToMs = aMs - DAY;
  return [fmtD(pToMs - (n - 1) * DAY), fmtD(pToMs)];
}

/** 指定日界区间内的合计（含首含尾，null 表示不限）；环比与导出的基准都走它 */
function rangeTotals(fDay, tDay) {
  const a = emptyT();
  for (const r of R) {
    if (fDay !== null && r.day < fDay) continue;
    if (tDay !== null && r.day > tDay) continue;
    addT(a, r);
  }
  return a;
}
function pad(n) { return String(n).padStart(2, "0"); }
/* ISO 周键：以周一为一周起点，归属年取该周周四所在年份（跨年周不会错位）。
   格式 2026-W38 —— 补零到两位，保证字符串排序即时间排序。
   入参是本地年月日而不是时间戳：立方体按日存储，不能再依赖 new Date(ts) 的时区行为 */
function isoWeekKey(y, m, d) {
  const t = new Date(y, m - 1, d);
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7)); // 移到本周四
  const yy = t.getFullYear();
  const w1 = new Date(yy, 0, 4);
  w1.setDate(w1.getDate() + 3 - ((w1.getDay() + 6) % 7)); // 当年第一个周四
  return yy + "-W" + pad(1 + Math.round((t - w1) / (7 * 864e5)));
}
/** "2026-07-10" → [2026, 7, 10]；格式不符返回 null。
 *  注意用 [0-9] 而不是 \\d：整段客户端脚本是嵌在 report.js 的模板字面量里的，
 *  模板字面量会把无法识别的转义 \d 直接吃掉变成字母 d，正则静默失效且不报错。 */
function dayParts(s) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s || "");
  return m ? [+m[1], +m[2], +m[3]] : null;
}
/* 日字符串 → 粒度桶键。日粒度原样返回；周/月/年直接从年月日算出，不经过 Date(ts)，
   避免字符串被按 UTC 解析而在负时区把日期挪一天 */
function bucketDay(day, g) {
  if (g === "day") return day;
  const p = dayParts(day);
  if (!p) return day;
  if (g === "year") return String(p[0]);
  if (g === "month") return day.slice(0, 7);
  return isoWeekKey(p[0], p[1], p[2]);
}
/** 一组立方体行在指定粒度下会产生多少个桶（用于判断趋势图是否会挤出几千根柱子） */
function countBuckets(rows, g) {
  const s = new Set();
  for (const r of rows) s.add(bucketDay(r.day, g));
  return s.size;
}
/**
 * 把起始粒度逐步粗化，直到桶数不超过上限。
 * 纯函数：countOf 由调用方注入，便于单独测试；year 已是最粗粒度，到顶就不再继续。
 *
 * @param {(g: string) => number} countOf 给定粒度返回桶数
 * @param {string} startGran 起始粒度
 * @param {number} [limit] 桶数上限，默认 MAX_COLS
 * @returns {string} 可用的最细粒度
 */
function coarsenToFit(countOf, startGran, limit) {
  const max = limit === undefined ? MAX_COLS : limit;
  let g = GRAN_ORDER.indexOf(startGran) >= 0 ? startGran : "day";
  while (g !== "year" && countOf(g) > max) g = GRAN_ORDER[GRAN_ORDER.indexOf(g) + 1];
  return g;
}
const day0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayStart = (ts) => +day0(new Date(ts));
/**
 * dataZoom 滑块把手标签的短形式。
 *
 * 滑块的把手标签画在把手**外侧**，默认的全长日期会超出右侧留白被画布裁掉
 * （表现为只显示成「202」）。只删掉「年-」前缀，保留能区分粒度的部分：
 * 日 2026-09-16 → 09-16、周 2026-W38 → W38、月 2026-09 原样、年 2026 原样。
 *
 * @param {string|undefined} k 桶键（bucketDay 的产物）
 * @returns {string} 可直接画在滑块上的短标签；键缺失时返回空串（避免画出 undefined）
 */
function sliderLabel(k) {
  return k == null ? "" : (k.length > 7 ? k.slice(5) : k);
}
/** 本地毫秒时间戳 → "YYYY-MM-DD"；与服务端 localDate 同构，保证区间边界能对上立方体的日键 */
function fmtD(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
/* 预设区间 → [from, to] 毫秒边界；all / custom 返回 [null, null] 表示不设限 */
function presetSpan(q) {
  const n = new Date();
  const t0 = +day0(n);
  const weekStart = (base) => { const t = day0(base); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return +t; };
  const fullMonth = (y, m) => [+new Date(y, m, 1), +new Date(y, m + 1, 1) - 1];
  const fullYear = (y) => [+new Date(y, 0, 1), +new Date(y + 1, 0, 1) - 1];
  const quarter = (offset) => {
    let qs = Math.floor(n.getMonth() / 3) * 3 + offset * 3, y = n.getFullYear();
    while (qs < 0) { qs += 12; y--; }
    while (qs > 11) { qs -= 12; y++; }
    return [+new Date(y, qs, 1), +new Date(y, qs + 3, 1) - 1];
  };
  switch (q) {
    case "today": return [t0, t0 + DAY - 1];
    case "yesterday": return [t0 - DAY, t0 - 1];
    case "d7": return [t0 - 6 * DAY, t0 + DAY - 1];
    case "d14": return [t0 - 13 * DAY, t0 + DAY - 1];
    case "d30": return [t0 - 29 * DAY, t0 + DAY - 1];
    case "d90": return [t0 - 89 * DAY, t0 + DAY - 1];
    case "week": { const f = weekStart(n); return [f, f + 7 * DAY - 1]; }
    case "lastweek": { const f = weekStart(n) - 7 * DAY; return [f, f + 7 * DAY - 1]; }
    case "month": return fullMonth(n.getFullYear(), n.getMonth());
    case "lastmonth": return fullMonth(n.getFullYear(), n.getMonth() - 1);
    case "quarter": return quarter(0);
    case "lastquarter": return quarter(-1);
    case "year": return fullYear(n.getFullYear());
    case "lastyear": return fullYear(n.getFullYear() - 1);
    default: return [null, null]; // all / custom
  }
}
/** 立方体按日字符串存储，区间过滤就是字符串比较（YYYY-MM-DD 的字典序等于时间序） */
function inRange(day) {
  if (fromDay !== null && day < fromDay) return false;
  if (toDay !== null && day > toDay) return false;
  return true;
}
/* 模型口径：默认 provider/model（不同渠道的成本口径不会混在一起）；
   「合并同名」时只用 modelID，用来回答「这个模型跨渠道一共花了多少」 */
const modelKey = (r) => scope === "merge" ? (r.modelID || "") : (r.providerID || "") + "/" + (r.modelID || "");
function agg(rs) {
  const t = emptyT(), byModel = {}, byDate = {}, byProject = {}, byDateModel = {};
  for (const r of rs) {
    addT(t, r);
    const mk = modelKey(r);
    addT(byModel[mk] = byModel[mk] || emptyT(), r);
    const bk = bucketDay(r.day, gran);
    addT(byDate[bk] = byDate[bk] || emptyT(), r);
    /* 项目键不在这里归一化：立方体（服务端 buildCube）存的就是 normProject 的结果，
       r.projectPath 已经是收敛过的路径。这一层没有 directory 字段可回落，重复归一化也没用。
       改 buildCube 时必须同步这个假设，否则「按项目」会重新出现 "/" 假项目与反斜杠拆分。 */
    addT(byProject[r.projectPath || "(unknown)"] = byProject[r.projectPath || "(unknown)"] || emptyT(), r);
    addT((byDateModel[bk] = byDateModel[bk] || {})[mk] = byDateModel[bk][mk] || emptyT(), r);
  }
  return { t, byModel, byDate, byProject, byDateModel };
}

/**
 * 顶部指标卡。每张卡固定三行骨架：标签 / 主值 / 副值。
 *
 * 三条硬约束（都是踩过坑才立的）：
 * 1. **主值行只放数字，且必须存在。** 早先 CACHE R/W 卡把整行塞进 <small>，主视觉退化成
 *    脚注大小；REASONING 卡更把说明写在数字前面，读起来像是「单列，不计入 output」才是主值。
 *    这两类错误都是「主值不再是主值」。**唯一的例外是脚注角标**（如 TOTAL TOKEN 的「*」）：
 *    它是一个指向卡区图例的指针，不是说明文字，可以内联进主值行（见 renderStats 的 mk）。
 * 2. **限定条件一律下沉到副值行**，绝不内联进主值。内联会让「合计 含 / reasoning 补计 / 数量」
 *    这种断行孤字出现，而且每张卡的断行位置取决于内容长度，整排卡片的节奏全乱。
 * 3. **精确值放 title**，副值只留可读的概数 —— 卡面窄，塞不下完整数字。
 *
 * 副值为什么要拆片段：卡面在 1280 视口下只有约 129px 可用宽度，带限定条件的副值文案
 * （如「含 reasoning 补计」）必然要折行。中文没有词边界，交给浏览器自由折行会得到
 * 「含 reasoning 补 / 计」这种词中被切的结果，
 * 加了 text-wrap:balance 反而更糟（它为了均分行长会主动从词中间切）。所以折点必须由代码指定：
 * 副值由 seg() 拆成若干不可断开的片段，片段之间才允许折行，每个片段都不是残句。
 *
 * 副值要带上的限定条件（否则数字会被误读）：
 * - TOTAL TOKEN 注明其中多少是 reasoning 超出 output 补进来的（口径修正的结果），并在主值右侧
 *   挂一个「*」角标 + 卡区下方一行图例 —— 副值只有一段（见上），补计这件事不能只靠副值和 title
 * - TOTAL COST 在 title 里写明清口径（记录 token × prices.json 单价，不是账单）
 * - 请求次数区分总数与有效数（token 全 0 的空响应也会被算进总数）
 * - 缓存 R/W 给的是**命中率**而不是占总比：占比只是「缓存读占全部 token 多少」（数字大不代表省），
 *   命中率 cacheRead/(input+cacheRead) 才是解释成本高低的量（同一模型换渠道后成本差异，
 *   几乎全部来自命中率）
 * - TOTAL TOKEN / TOTAL COST 追加**环比**：与上一等长区间比。只在能算出上一区间时才出现
 *   （「全部时间」没有可比基准，就不编一个出来）
 */
/* ---- 空响应告警阈值：比例 + 最小样本量，两条都满足才算异常 ---- */
const EMPTY_ALERT_RATE = 0.2, EMPTY_ALERT_MIN = 5;

/** 缓存命中率 = cacheRead / (input + cacheRead)；没有 prompt 侧 token 时返回 null（而不是 0%） */
const hitPct = (a) => { const d = (a.input || 0) + (a.cacheRead || 0); return d > 0 ? 100 * a.cacheRead / d : null; };
/** 空响应率 = token 全 0 的请求占该行请求数的比例 */
const emptyRate = (a) => (a.requests ? a.emptyReqs / a.requests : 0);
/**
 * 是否告警。只看比例不够：只发过 2 次请求、其中 1 次空响应就是 50%，
 * 这种样本量说明不了渠道有问题，所以同时要求请求数达到 EMPTY_ALERT_MIN。
 */
const isAlert = (a) => a.requests >= EMPTY_ALERT_MIN && emptyRate(a) >= EMPTY_ALERT_RATE;

function renderStats(t, prevT) {
  // 占总量的比例；total 为 0（无数据）时给 "-" 而不是 "NaN%"
  const share = (x) => (t.total ? (100 * x / t.total).toFixed(1) + "%" : "-");
  const n0 = (v) => (v || 0).toLocaleString("en-US");
  const valid = t.requests - t.emptyReqs;
  const hit = hitPct(t);
  /**
   * 把副值切成一串不可断开的片段。
   * 片段之间用真实空格连接：空格既是唯一的折行机会，也让复制出来的文本有词间隔；
   * 视觉间距靠 .stat .s i 的 margin-right，不靠空格。
   * @param {string[]} parts 片段文案，空串会被丢弃
   * @returns {string} 由 <i> 包裹的片段序列（浏览器只能在片段之间折行）
   */
  const seg = (parts) => parts.filter((x) => x).map((p) => "<i>" + p + "</i>").join(" ");
  /**
   * 环比片段。base 为上一等长区间的量；base <= 0（没有可比基准）时不产出片段 ——
   * 宁可这一行少一段，也不要写「+∞%」或把 0 当分母算出一个假的百分比。
   * 箭头与正负号本身已表达方向，颜色只是辅助。
   */
  const delta = (cur, base, label) => {
    if (base === null || base === undefined || base <= 0) return "";
    const d = 100 * (cur - base) / base;
    const up = d >= 0;
    return '<span class="' + (up ? "up" : "dn") + '">' + label + (up ? " ↑" : " ↓") + Math.abs(d).toFixed(1) + "%</span>";
  };
  // 超标的渠道不在卡片区展示：一个「4 / 最高 100%」的数字说不清在数什么，占着第 8 张卡的位置却
  // 讲不出更多信息。异常渠道改由明细表承担 —— 「空响应」列本身带 (95%) 占比，超标行标红（.hot，
  // hover 给出判据），想知道是哪个渠道时直接看表，比扫卡片更直接。判据定义见 EMPTY_ALERT_* 与 isAlert。
  const card = (k, v, s, c, ti) =>
    '<div class="stat ' + c + '"' + (ti ? ' title="' + ti + '"' : "") + ">" +
    '<div class="k">' + k + '</div><div class="v">' + v + '</div>' +
    // 副值为空时用 &nbsp; 占位，避免这一行塌掉导致同排卡片内部基线不齐
    '<div class="s">' + (s || "&nbsp;") + "</div></div>";
  /* reasoning 溢出补计的脚注角标。补进来的那一块既不是 input 也不是常规 output，只看主值的读者
     不会去悬停 title，于是总额里有一块来历不明的量。给主值右侧挂一个 *，卡区下方配一行图例
     （#mkLegend）说明它是什么 —— 不依赖悬停。补计量为 0 时角标与图例一并消失，不留悬空的星号。 */
  const mk = t.reasoningOver > 0 ? '<sup class="mk">*</sup>' : "";
  const cards = [
    /* 副值只留一个片段。原先拆成「含 reasoning」+「补计 N」两段，但卡面一行只放得下一段，
       再接上环比就会比同排其它卡多一行。合并成「补计 N」一段后：默认态 1 行，带环比 2 行。
       被去掉的「含 reasoning」在 title 里有完整写法，且右侧 REASONING 卡本身就在讲 reasoning。 */
    ["TOTAL TOKEN", nf(t.total) + mk,
     seg([t.reasoningOver ? "补计 " + nf(t.reasoningOver) : "",
          delta(t.total, prevT && prevT.total, "环比")]), "a",
     n0(t.total) + " token" +
       (t.reasoningOver ? "（其中 reasoning 溢出补计 " + n0(t.reasoningOver) + "）" : "") +
       (prevT && prevT.total > 0 ? " · 上一区间 " + n0(prevT.total) + " token" : "")],
    /* 副值只给「按牌价」这一个静态口径标记 + 环比：成本已经只有一条算法，再列出实测/估算
       两个数就回到了「同一格子里两个来源比大小」的老问题。口径的完整写法在 title 里。 */
    ["TOTAL COST", money(t.cost),
     seg(["按牌价", delta(t.cost, prevT && prevT.cost, "环比")]), "g",
     "记录 token × prices.json 单价 = " + money(t.cost) + "（单一来源，非账单）" +
       (prevT && prevT.cost > 0 ? " · 上一区间 " + money(prevT.cost) : "")],
    ["INPUT", nf(t.input), seg(["占总 " + share(t.input)]), "c", n0(t.input) + " token"],
    ["OUTPUT", nf(t.output), seg(["占总 " + share(t.output)]), "o", n0(t.output) + " token"],
    ["缓存 R/W", nf(t.cacheRead),
     seg(["写 " + nf(t.cacheWrite), hit === null ? "" : "命中 " + hit.toFixed(1) + "%"]), "p",
     "读 " + n0(t.cacheRead) + " · 写 " + n0(t.cacheWrite) +
       (hit === null ? "" : " · 命中率 = " + n0(t.cacheRead) + " / (" + n0(t.input) + " + " + n0(t.cacheRead) + ") = " + hit.toFixed(1) + "%")],
    // 拆成两个片段：合成一个「单列，不计入 output」在窄视口下是 109px 的不可断片段，
    // 卡片被挤到 148px 时卡内可用宽度只有 108px → 会被浏览器从词中间强行切开（片段机制等于失效）。
    // 语义上「单列」与「不计入 output」本来就是两句，各自独立成片段即可自由折行。
    ["REASONING", nf(t.reasoning), seg(["单列", "不计入 output"]), "",
     n0(t.reasoning) + " token（单列，不计入 output）"],
    // "空响应" 收短成 "空"：全称会让副值多折一行，全称放进 title
    ["请求次数", n0(t.requests),
     seg(["有效 " + n0(valid), "空 " + n0(t.emptyReqs)]), "",
     "总 " + n0(t.requests) + " · 有效 " + n0(valid) + " · 空响应 " + n0(t.emptyReqs)],
  ];
  $("cards").innerHTML = cards.map((c) => card(c[0], c[1], c[2], c[3], c[4])).join("");
  /* 角标图例跟着一起刷新：补计量为 0（如空区间）时连图例一起收掉，不留一行指向空处的说明 */
  const lg = $("mkLegend");
  if (lg) {
    lg.innerHTML = mk ? "* TOTAL TOKEN 主值里含 reasoning 溢出补计量（悬停该卡看完整口径）" : "";
    lg.style.display = mk ? "block" : "none";
  }
}

/* 复用实例而不是每次 dispose + init：切换区间/粒度会高频重建，反复初始化有明显卡顿 */
function setChart(id, opt, h) {
  if (h) $(id).style.height = h + "px";
  if (!charts[id] || charts[id].isDisposed()) charts[id] = echarts.init($(id));
  else charts[id].resize();
  charts[id].setOption(opt, true); // notMerge：避免旧 option 残留
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
  // 「其他」用中性灰，避免与 PAL[0] 的橙色混淆
  trendColorMap["其他"] = "#6f6f6f";
  const colorOf = (m) => trendColorMap[m] || "#555";
  const series = top.map((m) => ({
    name: m, type: "bar", stack: "t", barMaxWidth: 34, barCategoryGap: "25%",
    itemStyle: { color: colorOf(m) },
    data: keys.map((k) => val((byDateModel[k] || {})[m] || emptyT())),
  }));
  if (ranking.length > 8) series.push({
    name: "其他", type: "bar", stack: "t", barMaxWidth: 34, itemStyle: { color: "#6f6f6f" },
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
  /* 列数过多时启用缩放：默认聚焦最近 WIN_COLS 列，更早的区间靠滚轮 / 拖动 / 底部滑块找回。
     不做这一步，1000+ 列会把每根柱子压到 1px 以下，图直接退化成一条色带。 */
  const zoomed = keys.length > ZOOM_AT;
  const winStart = Math.max(0, keys.length - WIN_COLS);
  const capNote = granCapped ? "列数超出上限，粒度已自动粗化为「" + GRAN_LABEL[gran] + "」" : "";
  const zoomNote = !zoomed ? ""
    : keys.length > WIN_COLS
      ? "共 <b>" + keys.length + "</b> 列，已启用缩放：默认显示最近 " + WIN_COLS + " 列 · 滚轮缩放 / 拖动平移 / 拖底部滑块回看更早区间"
      : "共 <b>" + keys.length + "</b> 列，已启用缩放：滚轮或底部滑块可放大细看";
  const hintEl = $("trendHint");
  if (hintEl) hintEl.innerHTML = [capNote, zoomNote].filter(Boolean).join(" · ");
  const opt = {
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
    // 缩放时给底部的 dataZoom 滑块腾出空间，否则会和图例、柱子叠在一起
    grid: { left: GRID_L, right: GRID_R, top: 28, bottom: zoomed ? 104 : 54 },
    xAxis: { type: "category", data: keys,
             axisLabel: { color: MUT, fontSize: 11, hideOverlap: true }, // hideOverlap 让密排标签自动错开而不是糊成一团
             axisLine: { lineStyle: { color: LINE } } },
    yAxis: { type: "value", axisLabel: { formatter: metric === "cost" ? ((v) => "$" + nf(v)) : nf, color: MUT },
             splitLine: { lineStyle: { color: SPLIT } } },
    series,
  };
  if (zoomed) opt.dataZoom = [
    // inside：滚轮缩放、拖动平移（都是 echarts 默认行为，这里只固定初始窗口）
    { type: "inside", xAxisIndex: 0, startValue: winStart, endValue: keys.length - 1 },
    /* 滑块的左/右留白不能沿用默认值：默认与网格同宽，把手标签画在把手外侧，
       右端标签会顶出画布被裁掉（只看到「202」）。这里左对齐网格、右侧多让 SLIDER_PAD，
       并把标签本身压短（日 "2026-09-16"→"09-16"、周 "2026-W38"→"W38"、月/年原样）。 */
    { type: "slider", xAxisIndex: 0, left: GRID_L, right: GRID_R + SLIDER_PAD,
      bottom: 46, height: 20, startValue: winStart, endValue: keys.length - 1,
      showDetail: true,
      labelFormatter: (v) => sliderLabel(keys[Math.round(v)]),
      brushSelect: false, borderColor: LINE, fillerColor: "rgba(255,106,0,.14)",
      handleStyle: { color: ACC, borderColor: ACC }, moveHandleStyle: { color: ACC },
      dataBackground: { lineStyle: { color: "#333" }, areaStyle: { color: "#1b1b1b" } },
      selectedDataBackground: { lineStyle: { color: ACC }, areaStyle: { color: "#2a1a08" } },
      textStyle: { color: DIM, fontSize: 10 } },
  ];
  setChart("trend", opt, zoomed ? 400 : 340);
  // 复用实例意味着事件处理器不会随 dispose 一起消失，重新绑定前必须先解绑
  charts.trend.off("mouseover");
  charts.trend.off("globalout");
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
  /* 类目用**全名**，只有轴标签走 trunc。
     早先把 trunc(m) 直接当类目值：两个不同渠道的长模型名截断后可能同名，echarts 会把它们
     当成同一个类目，排行图因此少一根柱子、tooltip 还把两者的用量加在一起显示。
     类目是全名之后 tooltip 也能给出完整名字，截断只发生在「画不下」的轴标签上。 */
  const rev = entries.slice().reverse();
  setChart("rank", {
    tooltip: { ...tip, trigger: "item", formatter: (p) => {
      const [m, a] = rev[p.dataIndex] || ["", emptyT()];
      return m + "<br/>" + nf(a.total) + " (" + (total ? (100 * a.total / total).toFixed(1) : "0.0") + "%)" +
             "<br/>" + money(a.cost) + " · 按牌价";
    } },
    grid: { left: 10, right: 92, top: 6, bottom: 6, containLabel: true },
    xAxis: { type: "value", axisLabel: { formatter: nf, color: DIM }, splitLine: { lineStyle: { color: SPLIT } } },
    yAxis: { type: "category", data: rev.map(([m]) => m),
             axisLabel: { formatter: (v) => trunc(v), color: "#dcdcdc", fontSize: 11 },
             axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false } },
    series: [{ type: "bar", barMaxWidth: 14, barCategoryGap: "35%",
               // 颜色仍按**原始排名**取（与构成条、趋势图同色），不能按显示顺序取
               itemStyle: { borderRadius: [0, 3, 3, 0], color: (p) => PAL[(entries.length - 1 - p.dataIndex) % PAL.length] },
               label: { show: true, position: "right", formatter: (p) => nf(p.value), color: MUT, fontSize: 11 },
               data: rev.map(([, a]) => a.total) }],
  }, Math.max(200, entries.length * 30 + 30));
}

function renderProjects(byProject) {
  // 零用量的项目不进图（归一化后仍可能剩下 "(unknown)" 这种没有路径依据的空壳）
  const entries = Object.entries(byProject).sort((a, b) => b[1].total - a[1].total).filter(([, a]) => a.total > 0);
  const total = entries.reduce((s, [, a]) => s + a.total, 0);
  // 与排行图同理：类目放全路径（唯一），轴标签才截断；否则两条长路径截断后同名会被并成一条
  const rev = entries.slice().reverse();
  setChart("c3", {
    tooltip: { ...tip, trigger: "item", formatter: (p) => {
      const [path, a] = rev[p.dataIndex] || ["", emptyT()];
      return path + "<br/>" + nf(a.total) + " (" + (total ? (100 * a.total / total).toFixed(1) : "0.0") + "%)" +
             "<br/>" + a.requests.toLocaleString() + " 次 · " + money(a.cost) + " · 按牌价";
    } },
    grid: { left: 10, right: 92, top: 6, bottom: 6, containLabel: true },
    xAxis: { type: "value", axisLabel: { formatter: nf, color: DIM }, splitLine: { lineStyle: { color: SPLIT } } },
    yAxis: { type: "category", data: rev.map(([p]) => p),
             axisLabel: { formatter: (v) => trunc(v), color: "#dcdcdc", fontSize: 11 },
             axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false } },
    series: [{ type: "bar", barMaxWidth: 14, barCategoryGap: "35%",
               itemStyle: { borderRadius: [0, 3, 3, 0], color: "#a78bfa" },
               label: { show: true, position: "right", formatter: (p) => nf(p.value), color: MUT, fontSize: 11 },
               data: rev.map(([, a]) => a.total) }],
  }, Math.max(200, entries.length * 30 + 30));
}

/**
 * 明细表列定义。v() 给**排序用的值**，t() 给**显示用的 HTML**，两者刻意分开：
 * 排序要按原始数值（命中率按 94.9 而不是 "94.9%" 字符串比），显示才需要格式化和着色。
 * 「模型」是唯一的字符串列，用 s: true 标记，排序走 localeCompare。
 * 「缓存命中」排在「模型」之后：它是解释 cost 高低的主因（同模型换渠道成本差两成，
 * 差异几乎全部来自命中率），放在成本列附近才读得通。
 * 「空响应」列的排序值取**异常率**而不是条数：这条列的意义是「哪个渠道坏了」，
 * 按绝对条数排会把只跑了几次的高异常率渠道埋掉。
 */
let tblColor = {};
const TBL_COLS = [
  { k: "模型", s: true, v: (m) => m,
    t: (m) => m ? '<span class="mdot" style="background:' + (tblColor[m] || "#555") + '"></span>' + m : "TOTAL" },
  /* 列序总规则（配合下面「合计」处的折叠线数据一起看）：
     表格宽 1478px > 1280 视口能给的 1194px，右端必须砍掉约 284px，所以列的前后顺序
     就是「默认能看到什么」的顺序。前 6 列放判断一行所需的最小信息集：
     模型（是谁）· 缓存命中（为什么便宜）· 次数（用了多少次）· 合计（多少 token）
     · cost（多少钱）· 空响应（这个渠道坏没坏）。剩下的桶明细与百分比属于「想深究再看」，
     允许横滚。「缓存命中」因此排在「模型」之后，而不是挨着 cache write ——
     它解释的是成本高低，不是原始计数。 */
  { k: "缓存命中", v: (m, a) => { const h = hitPct(a); return h === null ? -1 : h; },
    t: (m, a) => { const h = hitPct(a); return h === null ? "—" : h.toFixed(1) + "%"; } },
  { k: "次数", v: (m, a) => a.requests, t: (m, a) => a.requests.toLocaleString("en-US") },
  /* 「合计」与「cost」紧跟「次数」是量出来的结果，不是审美：measure-table.py 在 1280 下测到
     合计原本落在 left=1147、宽 111，只露出 47px（被折叠线切一半），cost 更是整列不可见 ——
     等于默认视图里看不到成本和总量。移到第 4、5 列后两者都完整落在 1194px 内，
     代价只是把 cache read/write 与两个百分比推到横滚区（它们本来就不需要一眼看到）。 */
  { k: "合计", v: (m, a) => a.total, t: (m, a) => "<b>" + a.total.toLocaleString("en-US") + "</b>" },
  /* cost 直接给金额：全表只有一条成本算法（记录 token × 牌价），没有需要并排比较的第二个来源，
     所以既不加 ~ 前缀也不挂 title —— 口径写在这个区块的说明与页脚，不必每行重复一遍。 */
  { k: "cost", v: (m, a) => a.cost, t: (m, a) => money(a.cost) },
  { k: "空响应", v: (m, a) => emptyRate(a),
    t: (m, a) => {
      const txt = a.emptyReqs.toLocaleString("en-US") + (a.requests ? " (" + (100 * emptyRate(a)).toFixed(0) + "%)" : "");
      return isAlert(a) ? '<span class="hot" title="空响应占比 ≥ ' + EMPTY_ALERT_RATE * 100 + '% 且请求数 ≥ ' + EMPTY_ALERT_MIN + '">' + txt + "</span>" : txt;
    } },
  { k: "input", v: (m, a) => a.input, t: (m, a) => a.input.toLocaleString("en-US") },
  { k: "output", v: (m, a) => a.output, t: (m, a) => a.output.toLocaleString("en-US") },
  { k: "reasoning", v: (m, a) => a.reasoning,
    t: (m, a) => a.reasoning.toLocaleString("en-US") +
      (a.reasoningOver ? ' <span class="dim" title="其中超出 output、已额外计入合计与成本的部分">+' + a.reasoningOver.toLocaleString("en-US") + "</span>" : "") },
  { k: "cache read", v: (m, a) => a.cacheRead, t: (m, a) => a.cacheRead.toLocaleString("en-US") },
  { k: "cache write", v: (m, a) => a.cacheWrite, t: (m, a) => a.cacheWrite.toLocaleString("en-US") },
  { k: "input%", v: (m, a) => (a.total ? a.input / a.total : -1), t: (m, a) => (a.total ? (100 * a.input / a.total).toFixed(1) : "0.0") + "%" },
  { k: "output%", v: (m, a) => (a.total ? a.output / a.total : -1), t: (m, a) => (a.total ? (100 * a.output / a.total).toFixed(1) : "0.0") + "%" },
];
const TOTAL_COL = TBL_COLS.findIndex((c) => c.k === "合计");
/* 默认按合计降序 —— 与 .strip / 趋势图 / 高亮颜色都一致；切换区间时保留用户选过的排序 */
let sortIdx = TOTAL_COL, sortDir = -1;
/* 当前视图的聚合结果：明细表、CSV 导出、上一区间比较都读它，保证三处数字同源 */
let viewT = emptyT(), viewModels = {};

/**
 * 按当前排序设置排列 [模型, 累计器]。
 * 榜内先按合计降序定位（决定颜色与名次），再按用户选的列重排 —— 两者不能混：
 * 名次/颜色是「谁是主力」的语义，排序只是查看顺序。
 * @param {object} byModel 模型 → 累计器
 * @returns {Array<[string, object]>} 已排序的条目
 */
function sortedRows(byModel) {
  const ranked = Object.entries(byModel).sort((a, b) => b[1].total - a[1].total);
  const col = TBL_COLS[sortIdx] || TBL_COLS[TOTAL_COL];
  return ranked.sort((x, y) => {
    const a = col.v(x[0], x[1]), b = col.v(y[0], y[1]);
    return col.s ? sortDir * String(a).localeCompare(String(b)) : sortDir * (a - b);
  });
}

/**
 * 明细表。cost 列只有一个数字口径（记录 token × 牌价），不再按来源标注 ——
 * 同一行里并排两个来源的金额，读者会默认其中一个是账单，比单一来源更误导。
 * reasoning 列在存在补计时用 + 标出超出 output 的量（.dim 弱化，不再内联 <small>）。
 * 表头是排序开关：data-i 指向 TBL_COLS 下标，当前排序列加 .on 并带 ▾/▴ 方向标。
 * 排序只影响行序，TOTAL 行永远在最后一行。
 *
 * @param {object} byModel 模型 → 累计器
 */
function renderTable(byModel) {
  const ranked = Object.entries(byModel).sort((a, b) => b[1].total - a[1].total);
  // 颜色按**原始名次**分配（构成条、趋势图用的是同一套），不能随排序位置漂移
  tblColor = {};
  ranked.forEach(([m], i) => { tblColor[m] = PAL[i % PAL.length]; });
  const t = emptyT(); ranked.forEach(([, a]) => addAcc(t, a));
  $("tbl").innerHTML =
    "<thead><tr>" + TBL_COLS.map((c, i) =>
      '<th data-i="' + i + '"' + (i === sortIdx ? ' class="on"' : "") + ">" + c.k +
      (i === sortIdx ? (sortDir < 0 ? " ▾" : " ▴") : "") + "</th>").join("") + "</tr></thead><tbody>" +
    sortedRows(byModel).map(([m, a]) => "<tr>" + TBL_COLS.map((c) => "<td>" + c.t(m, a) + "</td>").join("") + "</tr>").join("") +
    '<tr class="total">' + TBL_COLS.map((c) => "<td>" + c.t(null, t) + "</td>").join("") + "</tr></tbody>";
}

/** CSV 单元格：含逗号 / 引号 / 换行时用双引号包裹，内部引号翻倍。
 *  注意正则里的换行转义必须写成双反斜杠：本段客户端脚本整体嵌在 report.js 的模板字面量里，
 *  单反斜杠会在生成阶段就被模板字面量解释成真实换行，正则会在行中断开（实测报
 *  SyntaxError: Invalid regular expression: missing /）。 */
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\\n\\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * 当前视图的 CSV 文本。
 * 与屏幕严格同源（同一个 viewT / sortedRows），所以导出的数字不会和看到的不一致。
 * 表头前加 BOM，否则 Excel 打开中文表头是乱码；换行用 CRLF，Excel 兼容最好。
 * 纯函数、不碰 DOM —— 便于在沙箱里断言内容，下载副作用留在 exportCsv。
 *
 * @returns {string} 含 BOM 的 CSV 全文
 */
function csvText() {
  const head = ["模型", "次数", "空响应", "空响应率", "input", "output",
                "reasoning", "reasoning补计", "cache read", "cache write", "缓存命中",
                "合计", "cost", "input%", "output%"];
  const rowOf = (m, a) => [
    m === null ? "TOTAL" : m, a.requests, a.emptyReqs,
    (100 * emptyRate(a)).toFixed(1) + "%",
    a.input, a.output, a.reasoning, a.reasoningOver, a.cacheRead, a.cacheWrite,
    hitPct(a) === null ? "" : hitPct(a).toFixed(1) + "%",
    a.total, a.cost.toFixed(4),
    (a.total ? (100 * a.input / a.total).toFixed(1) : "0.0") + "%",
    (a.total ? (100 * a.output / a.total).toFixed(1) : "0.0") + "%",
  ].map(csvCell).join(",");
  const lines = [
    "OpenCode 用量明细 · 区间 " + fmtSpan() + " · 模型口径 " + (scope === "merge" ? "合并同名" : "按渠道拆分") +
      " · cost = 记录 token × prices.json 单价 · 报告生成 " + GEN,
    head.join(","),
  ];
  sortedRows(viewModels).forEach(([m, a]) => lines.push(rowOf(m, a)));
  lines.push(rowOf(null, viewT));
  // 同样用双反斜杠：生成阶段模板字面量会吃掉单反斜杠的转义，字符串字面量会跨行而语法报错。
  // （连注释里都不能写单反斜杠的转义 —— 行注释会被真实换行截断。）
  return "\\ufeff" + lines.join("\\r\\n") + "\\r\\n";
}

/** 触发一次文件下载。file:// 下 Blob + a[download] 在 Chrome / Edge / Firefox 都可用 */
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 文件名用区间两端日期，避免中文与空格在不同系统上被转义得难以辨认 */
function exportCsv() {
  download("opencode-usage_" + fmtD(from === null ? R_MIN : from) + "_" + fmtD(to === null ? R_MAX : to) + ".csv", csvText());
}

$("csvBtn").addEventListener("click", exportCsv);
/* 表头点击排序。监听器挂在 <table> 上而不是每个 th：表头每次重绘都被换掉，
   挂在容器上就不用反复重绑（同一列再点一次反向；数值列首次点按从大到小） */
$("tbl").addEventListener("click", (e) => {
  const th = e.target && e.target.closest ? e.target.closest("th[data-i]") : null;
  if (!th) return;
  const i = +th.dataset.i;
  if (i === sortIdx) sortDir = -sortDir;
  else { sortIdx = i; sortDir = TBL_COLS[i].s ? 1 : -1; }
  refresh();
});

/* 是否因为列数硬上限而被强制粗化了粒度（只可能发生在手动选粒度时） */
let granCapped = false;
function refresh() {
  const rs = R.filter((r) => inRange(r.day));
  $("empty").style.display = rs.length ? "none" : "block";
  if (!rs.length) {
    // 空区间：清掉图表与表格，避免留下上一个区间的残影
    ["trend", "rank", "c3"].forEach((id) => { if (charts[id]) charts[id].clear(); });
    viewT = emptyT(); viewModels = {};
    renderStats(emptyT(), null);
    $("dist").innerHTML = "";
    $("tbl").innerHTML = "";
    if ($("trendHint")) $("trendHint").innerHTML = "";
    return;
  }
  // 硬上限：手动选日粒度去看十年数据会产生 3650 列，浏览器会卡死、图也完全没意义。
  // 逐步粗化到能渲染为止，并把实际生效的粒度回写到按钮上（不静默改写用户的选择）。
  granCapped = false;
  if (!granAuto) {
    const fitted = coarsenToFit((g) => countBuckets(rs, g), gran);
    if (fitted !== gran) { gran = fitted; granCapped = true; }
  }
  paintGranChips();
  const { t, byModel, byDate, byProject, byDateModel } = agg(rs);
  viewT = t; viewModels = byModel;
  /* 环比基准：上一「等长区间」。全部时间没有可比区间（prevSpan 返回 null），
     此时卡片不会编出一个假百分比，只是不显示环比那一段。 */
  const p = prevSpan();
  renderStats(t, p ? rangeTotals(p[0], p[1]) : null);
  renderTrend(byDate, byDateModel, byModel);
  renderModels(byModel);
  renderProjects(byProject);
  renderTable(byModel);
}

/* ---- 时间筛选：范围下拉框 + 双月区间选择器 ---- */
const GRAN_LABEL = { day: "日", week: "周", month: "月", year: "年" };
/* 把粒度按钮的高亮同步到「实际生效的粒度」—— 手动选的粒度可能被硬上限粗化，按钮要跟着走 */
function paintGranChips() {
  const active = granAuto ? "auto" : gran;
  $("segGran").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.g === active));
}
/* 粒度自动推断：跨度越长颗粒越粗。手动选过粒度后 granAuto = false，不再被区间变化覆盖。
   阈值设计的目标是让列数始终落在几十列这个区间：≤45 天用日、≤240 天用周、≤1100 天用月，再长用年。
   所以「全部时间」就算攒到 1000 天以上，自动模式也只会给出月/年，不会挤出上千根柱子。 */
function autoGran() {
  if (granAuto) {
    const f = from === null ? R_MIN : from;
    const t = to === null ? R_MAX : to;
    const days = (t - f) / DAY;
    gran = days <= 45 ? "day" : days <= 240 ? "week" : days <= 1100 ? "month" : "year";
  }
  paintGranChips();
}
function fmtSpan() {
  if (from === null || to === null) return "全部时间";
  return fmtD(from) === fmtD(to) ? fmtD(from) : fmtD(from) + " → " + fmtD(to);
}
/* 下拉框内容随「是否有自定义区间」变化：
   非自定义态只放 15 个预设（此时 rangeKey 必为预设值，一定命中，不需要占位项）；
   自定义态在首位插入一项，文本就是当前区间 —— 让下拉框如实显示自己的当前值，而不是空白。
   （不能用 hidden/disabled 的占位项：Chrome 既不渲染 hidden option 的文本，
     也不允许程序选中 disabled option，两种情况都会变成空白框看着像坏了。） */
let rangeHead = null;
function buildRangeOptions() {
  const custom = rangeKey === "custom" && from !== null && to !== null;
  const head = custom ? '<option value="custom">' + fmtSpan() + "</option>" : "";
  if (head === rangeHead) return; // 头部未变就不重建，避免每次重绘都刷 innerHTML
  rangeHead = head;
  $("selRange").innerHTML = head + PRESET_GROUPS.map((g) =>
    '<optgroup label="' + g.g + '">' +
    g.items.map(([v, l]) => '<option value="' + v + '">' + l + "</option>").join("") +
    "</optgroup>").join("");
}
function paintRangeUI() {
  buildRangeOptions();
  $("selRange").value = rangeKey;
  const custom = rangeKey === "custom" && from !== null && to !== null; // 半截区间不算生效
  // 按钮始终只作为「自定义区间」入口；区间值由左侧下拉框承载，避免两处并排显示同一段文字
  $("rangeBtn").classList.toggle("on", custom);
  $("rangeBtn").title = custom ? "当前自定义区间：" + fmtSpan() + "（点击修改）" : "选择自定义区间";
}
function applySpan(f, t, key) {
  if (f !== null && t !== null && f > t) { const x = f; f = t; t = x; }
  from = f; to = t;
  // 立方体按日存，过滤用日字符串。预设给出的边界就是日界（起始日 00:00 ~ 结束日 23:59:59.999），
  // 换算成日串后正好是「含首含尾」的闭区间
  fromDay = f === null ? null : fmtD(f);
  toDay = t === null ? null : fmtD(t);
  if (key !== undefined) rangeKey = key;
  autoGran(); paintRangeUI(); refresh();
}
function setPreset(q, keepOpen) {
  if (q === "custom") return; // 自定义区间只能由日历选定，不走预设通道
  if (q === "all") applySpan(null, null, "all");
  else { const [f, t] = presetSpan(q); applySpan(f, t, q); }
  if (!keepOpen) closeCal();
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
bindSeg("segGran", "g", (v) => {
  if (v === "auto") { granAuto = true; autoGran(); } else { granAuto = false; gran = v; }
  refresh();
});
bindSeg("segMetric", "m", (v) => { metric = v; refresh(); });
// 「按渠道拆分」是默认：同一 modelID 在不同渠道的单价差别很大，合并会把成本口径混在一起
bindSeg("segScope", "s", (v) => { scope = v === "merge" ? "merge" : "split"; refresh(); });

/* 下拉框与日历快捷按钮同源生成，避免两处选项漂移 */
function buildSelectors() {
  buildRangeOptions();
  $("calQuick").innerHTML = QUICK_KEYS.map((v) => '<button class="chip" data-q="' + v + '">' + PRESET_LABEL[v] + "</button>").join("");
  const wd = WEEKDAYS.map((w) => '<span class="wd">' + w + "</span>").join("");
  $("calWd0").innerHTML = wd;
  $("calWd1").innerHTML = wd;
}
$("selRange").addEventListener("change", () => {
  const v = $("selRange").value;
  // 自定义态下首项是当前区间本身（value="custom"），重复选中它不做任何事
  if (v && v !== "custom") setPreset(v);
});
/* 按钮只负责开合面板：不在打开时就切到 custom，否则「打开又直接关掉」会让下拉框落到占位项、
   按钮变成高亮态，却没实际生效任何自定义区间。rangeKey 只在真正选中日期时才变成 custom */
$("rangeBtn").addEventListener("click", () => {
  if (calOpen) closeCal();
  else openCal();
});

/* 双月区间选择器：先点起点、再点终点，中途悬停实时预览区间；选完立即套用但不关面板，方便继续微调 */
let calY = 0, calM = 0, pickFrom = null, pickTo = null, pickStage = "from", hoverTs = null, calOpen = false;
function buildYearSel() {
  const yMin = new Date(R_MIN).getFullYear();
  const yMax = Math.max(new Date(R_MAX).getFullYear(), new Date().getFullYear()) + 1;
  const years = [];
  for (let y = yMax; y >= yMin; y--) years.push('<option value="' + y + '">' + y + " 年</option>");
  $("calYSel").innerHTML = years.join("");
}
function openCal() {
  const base = to !== null ? to : (from !== null ? from : R_MAX);
  const d = new Date(base);
  calY = d.getFullYear(); calM = d.getMonth();
  // 以当前生效区间作为待选值，打开就能看到自己处在哪一段
  pickFrom = from === null ? null : dayStart(from);
  pickTo = to === null ? null : dayStart(to);
  pickStage = "from"; hoverTs = null;
  buildYearSel();
  $("calPanel").classList.add("show");
  $("rangeBtn").classList.add("open");
  calOpen = true;
  renderCal();
}
function closeCal() {
  $("calPanel").classList.remove("show");
  $("rangeBtn").classList.remove("open");
  calOpen = false; hoverTs = null;
}
function monthHtml(y, m) {
  const startWd = (new Date(y, m, 1).getDay() + 6) % 7; // 周一为一周起点
  const daysIn = new Date(y, m + 1, 0).getDate();
  let html = "";
  for (let i = 0; i < startWd; i++) html += '<span class="day out"></span>';
  for (let d = 1; d <= daysIn; d++) {
    const ts = +new Date(y, m, d);
    html += '<button class="day" data-ts="' + ts + '" data-d="' + fmtD(ts) + '">' + d + "</button>";
  }
  return html;
}
function renderCal() {
  const y2 = calM === 11 ? calY + 1 : calY, m2 = (calM + 1) % 12;
  $("calTitle").textContent = calY + " 年 " + pad(calM + 1) + " 月 – " + pad(m2 + 1) + " 月";
  $("calT0").textContent = calY + " 年 " + (calM + 1) + " 月";
  $("calT1").textContent = y2 + " 年 " + (m2 + 1) + " 月";
  $("calG0").innerHTML = monthHtml(calY, calM);
  $("calG1").innerHTML = monthHtml(y2, m2);
  $("calYSel").value = String(calY);
  paintCal();
}
/* 只改 class 不重建 DOM —— 悬停预览时会高频调用 */
function paintCal() {
  const settled = pickStage === "from" && pickTo !== null;
  let a = pickFrom, b = pickTo;
  if (b === null && pickStage === "to" && hoverTs !== null) b = hoverTs; // 悬停预览
  if (a !== null && b !== null && a > b) { const x = a; a = b; b = x; }
  const todayD = fmtD(Date.now());
  document.querySelectorAll("#calPanel .day[data-ts]").forEach((el) => {
    const ts = +el.dataset.ts;
    const cls = ["day"];
    if (el.dataset.d === todayD) cls.push("today");
    if (a !== null && ts === a) cls.push("sel");
    if (b !== null && ts === b && b !== a) cls.push("sel");
    if (a !== null && b !== null && ts > a && ts < b) cls.push(settled ? "mid" : "pre");
    el.className = cls.join(" ");
  });
  $("calPick").innerHTML =
    pickFrom === null ? "请选择开始日期"
      : pickTo === null ? "开始 <b>" + fmtD(pickFrom) + "</b> · 再选结束日期"
        : "<b>" + fmtD(pickFrom) + "</b> → <b>" + fmtD(pickTo) + "</b>";
}
function pickDay(ts) {
  if (pickStage === "from" || pickFrom === null) {
    pickFrom = ts; pickTo = null; pickStage = "to"; hoverTs = null;
    paintCal();
    return;
  }
  let a = pickFrom, b = ts;
  if (b < a) { const x = a; a = b; b = x; }
  pickFrom = a; pickTo = b; pickStage = "from"; hoverTs = null;
  applySpan(a, b + DAY - 1, "custom"); // 面板不关，可继续调整
  paintCal();
}
function shiftMonth(n) {
  const total = calY * 12 + calM + n;
  calY = Math.floor(total / 12);
  calM = ((total % 12) + 12) % 12;
  renderCal();
}
$("calPanel").addEventListener("click", (e) => {
  const q = e.target.closest("[data-q]");
  if (q && PRESET_LABEL[q.dataset.q]) { setPreset(q.dataset.q); return; }
  const day = e.target.closest("button.day");
  if (day && day.dataset.ts) pickDay(+day.dataset.ts);
});
$("calPanel").addEventListener("mouseover", (e) => {
  const day = e.target.closest("button.day");
  const ts = day && day.dataset.ts ? +day.dataset.ts : null;
  if (ts === hoverTs) return;
  hoverTs = ts;
  if (pickStage === "to" && pickFrom !== null) paintCal();
});
$("calPanel").addEventListener("mouseleave", () => {
  if (hoverTs === null) return;
  hoverTs = null;
  if (pickStage === "to" && pickFrom !== null) paintCal();
});
$("calPrev").addEventListener("click", () => shiftMonth(-1));
$("calNext").addEventListener("click", () => shiftMonth(1));
$("calPrevY").addEventListener("click", () => shiftMonth(-12));
$("calNextY").addEventListener("click", () => shiftMonth(12));
$("calYSel").addEventListener("change", () => { calY = +$("calYSel").value; renderCal(); });
$("calClear").addEventListener("click", () => {
  pickFrom = null; pickTo = null; pickStage = "from"; hoverTs = null;
  applySpan(null, null, "all");
  paintCal();
});
$("calOk").addEventListener("click", closeCal);
document.addEventListener("click", (e) => {
  if (!calOpen) return;
  if ($("calPanel").contains(e.target) || $("rangeBtn").contains(e.target) || $("selRange").contains(e.target)) return;
  closeCal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCal(); });
window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));

/* 初始化：全量时间范围直接取立方体的首末日（DAYS 已升序），
   「全部时间」下据此推断粒度、日历年份下拉也用它划范围 */
(function init() {
  const first = DAYS.length ? dayParts(DAYS[0]) : null;
  const last = DAYS.length ? dayParts(DAYS[DAYS.length - 1]) : null;
  R_MIN = first ? +new Date(first[0], first[1] - 1, first[2]) : Date.now();
  R_MAX = last ? +new Date(last[0], last[1] - 1, last[2]) + DAY - 1 : R_MIN;
  $("segScope").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.s === scope));
  buildSelectors();
  setPreset("all");
})();
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
    else if (argv[i] === "--no-db") opts.noDb = true;
    else if (argv[i] === "--data") opts.data = argv[++i];
    else if (argv[i] === "--out") opts.out = argv[++i];
    else if (argv[i] === "--prices") opts.prices = argv[++i];
    else if (argv[i] === "--db") opts.db = argv[++i];
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
    // 使用默认路径时，先静默增量同步 opencode.db 的历史用量（幂等，按 messageID 跳过已存在）。
    // --no-db 跳过这一步（数据量大或数据库不可用时提速）；--db 指定数据库路径
    if (!opts.data && !opts.noDb) {
      const dbArgs = opts.db ? ["--db", opts.db] : [];
      try { require("./import-history.js").main(dbArgs, { quiet: true }); } catch { /* 数据库不可用时只用现有 data.jsonl */ }
    }
    return readRecords(dataFile);
  })();
  const prices = loadPrices(pricesFile);
  // 成本在每条记录上算一次，输入只有「记录 + prices」两样，不存在需要保护的状态：
  // 记录自己的 cost 字段全程不参与，所以预解析、回写、重复聚合都不会改变结果。
  const kept = dedupe(records);
  const summary = aggregate(kept, prices);
  summary.bad = bad;
  summary.records = kept;
  summary.prices = prices;

  const text = renderText(summary);
  console.log(text);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  let echartsJs;
  try {
    echartsJs = fs.readFileSync(path.join(__dirname, "vendor", "echarts.min.js"), "utf8");
  } catch {
    throw new Error(`找不到 ${path.join(__dirname, "vendor", "echarts.min.js")}，请先下载 ECharts 到 vendor/`);
  }
  fs.writeFileSync(outFile, renderHtml(summary, echartsJs));
  console.log(`\nHTML 报告: ${outFile}`);

  if (opts.open) openBrowser(outFile);
  return text;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  readRecords, dedupe, localDate, loadPrices, normProject,
  reasoningOverflow, estimateCost, resolveCost,
  emptyAcc, addRecord, mergeAcc, aggregate, buildCube,
  renderText, renderHtml, openBrowser, parseArgs, main,
};
