"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readRecords, dedupe, localDate, loadPrices, normProject, reasoningOverflow,
  estimateCost, resolveCost, aggregate, buildCube, renderText, renderHtml, parseArgs,
} = require("../plugin/usage-monitor/report.js");

function rec(overrides = {}) {
  return {
    time: new Date(2026, 8, 13, 12, 0, 0).getTime(), // 2026-09-13 本地
    projectPath: "E:/projA",
    directory: "E:/projA",
    sessionID: "ses_1",
    messageID: "msg_1",
    providerID: "acme",
    modelID: "example-model",
    tokens: { input: 100, output: 50, reasoning: 20, cacheRead: 10, cacheWrite: 5 },
    cost: 0.5,
    ...overrides,
  };
}

test("readRecords 跳过坏行并计数", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  const file = path.join(dir, "data.jsonl");
  fs.writeFileSync(file, JSON.stringify(rec()) + "\n{broken\n\n" + JSON.stringify(rec({ messageID: "msg_2" })) + "\n");
  const { records, bad } = readRecords(file);
  assert.equal(records.length, 2);
  assert.equal(bad, 1);
});

test("dedupe 同 messageID 取最后一条，位置取首次出现处", () => {
  const out = dedupe([rec({ cost: 1 }), rec({ messageID: "msg_9", projectPath: "P9" }), rec({ cost: 2 })]);
  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.messageID === "msg_1").cost, 2);
  assert.deepEqual(out.map((r) => r.messageID), ["msg_1", "msg_9"]);
});

test("localDate 用本地时区分桶", () => {
  const ts = new Date(2026, 8, 13, 23, 59).getTime(); // 本地 2026-09-13 23:59
  assert.equal(localDate(ts), "2026-09-13");
});

test("loadPrices 文件缺失返回空对象", () => {
  assert.deepEqual(loadPrices(path.join(os.tmpdir(), "no-such-prices.json")), {});
});

test("normProject 归一化分隔符、折叠重复斜杠、根目录回落 directory", () => {
  assert.equal(normProject({ projectPath: "D:\\work\\proj" }), "D:/work/proj");
  assert.equal(normProject({ projectPath: "D:/work/proj/" }), "D:/work/proj");
  assert.equal(normProject({ projectPath: "D:/work//proj" }), "D:/work/proj");
  assert.equal(normProject({ projectPath: "/", directory: "D:/work/proj" }), "D:/work/proj");
  assert.equal(normProject({ projectPath: "\\", directory: "D:/work/proj" }), "D:/work/proj");
  assert.equal(normProject({}), "(unknown)");
});

test("reasoningOverflow 只在 reasoning > output 时补计", () => {
  assert.equal(reasoningOverflow({ output: 100, reasoning: 40 }), 0);
  assert.equal(reasoningOverflow({ output: 100, reasoning: 100 }), 0);
  assert.equal(reasoningOverflow({ output: 131, reasoning: 369 }), 369);
  assert.equal(reasoningOverflow({}), 0);
  assert.equal(reasoningOverflow({ reasoning: 5 }), 5);
});

test("parseArgs 解析全部参数（含 --no-db / --db）", () => {
  const o = parseArgs(["--open", "--no-db", "--data", "a.jsonl", "--out", "b.html", "--prices", "c.json", "--db", "d.db"]);
  assert.deepEqual(o, { open: true, noDb: true, data: "a.jsonl", out: "b.html", prices: "c.json", db: "d.db" });
});

test("estimateCost 按每百万单价计算，output 侧并入 reasoning 溢出", () => {
  assert.equal(estimateCost({ input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: 2 }), 2);
  // output 100 + reasoning 300（溢出全补）→ 400 × 10 / 1e6 = 0.004
  const c = estimateCost({ output: 100, reasoning: 300 }, { output: 10 });
  assert.ok(Math.abs(c - 0.004) < 1e-12);
});

test("resolveCost 只认牌价：忽略记录自带 cost，无牌价即 0", () => {
  const price = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
  const r = rec({ cost: 0.5 });
  const expected = (100 * 1 + 50 * 2 + 10 * 0.1 + 5 * 0.2) / 1e6;
  assert.ok(Math.abs(resolveCost(r, price) - expected) < 1e-12);
  assert.equal(resolveCost(r, undefined), 0);
  assert.equal(resolveCost(rec({ cost: 9.9 }), {}), 0);
});

test("aggregate：total 含 reasoning 溢出量，reasoning 单列", () => {
  const s = aggregate([rec()], {}); // reasoning 20 <= output 50，不补
  assert.equal(s.totals.total, 165); // 100+50+10+5
  assert.equal(s.totals.reasoning, 20);
  assert.equal(s.totals.reasoningOver, 0);
  const s2 = aggregate([rec({ tokens: { input: 100, output: 3, reasoning: 10, cacheRead: 10, cacheWrite: 5 } })], {});
  assert.equal(s2.totals.reasoningOver, 10); // reasoning 10 > output 3
  assert.equal(s2.totals.total, 128); // 100+3+10+5 + 10
});

test("aggregate：cost 只按 prices 牌价，记录自带 cost 不参与", () => {
  const prices = { "acme/example-model": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } };
  const s = aggregate([rec({ cost: 0 }), rec({ cost: 999, messageID: "msg_2" })], prices);
  const one = (100 * 1 + 50 * 2 + 10 * 0.1 + 5 * 0.2) / 1e6;
  assert.ok(Math.abs(s.totals.cost - one * 2) < 1e-12);
});

test("aggregate 分组：项目路径归一化，range 取本地日期", () => {
  const r2 = rec({
    messageID: "msg_2",
    providerID: "other",
    modelID: "m2",
    projectPath: "E:\\projB",
    directory: "E:\\projB",
    time: new Date(2026, 8, 12, 8, 0, 0).getTime(),
  });
  const s = aggregate([rec(), r2], {});
  assert.deepEqual(Object.keys(s.byModel).sort(), ["acme/example-model", "other/m2"]);
  assert.deepEqual(Object.keys(s.byDate).sort(), ["2026-09-12", "2026-09-13"]);
  assert.deepEqual(Object.keys(s.byProject).sort(), ["E:/projA", "E:/projB"]);
  assert.equal(s.range.from, "2026-09-12");
  assert.equal(s.range.to, "2026-09-13");
});

test("aggregate 空数据时 range 为 null 且不抛错", () => {
  const s = aggregate([], {});
  assert.equal(s.range.from, null);
  assert.equal(s.totals.total, 0);
});

test("buildCube：同日同项目同渠道同模型合并，跨渠道/跨日分开，空响应单列", () => {
  const at = (d, h) => +new Date(2026, 0, d, h);
  const recs = [
    { time: at(5, 1), projectPath: "E:/p", providerID: "P", modelID: "M", messageID: "m1",
      tokens: { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 0 }, cost: 0.5 },
    { time: at(5, 9), projectPath: "E:/p", providerID: "P", modelID: "M", messageID: "m2",
      tokens: { input: 20, output: 8, reasoning: 30, cacheRead: 4, cacheWrite: 1 }, cost: 0 },
    { time: at(6, 3), projectPath: "E:/p", providerID: "P", modelID: "M", messageID: "m3",
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.25 },
    { time: at(5, 5), projectPath: "E:/p", providerID: "Q", modelID: "M", messageID: "m4",
      tokens: { input: 7, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
    { time: at(5, 6), projectPath: "E:/p", providerID: "P", modelID: "M", messageID: "m5",
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
  ];
  const prices = { "P/M": { input: 2, output: 20, cacheRead: 0.2, cacheWrite: 2 } }; // Q/M 刻意无价
  const cube = buildCube(recs, prices);
  assert.deepEqual(cube.days, ["2026-01-05", "2026-01-06"]);
  assert.equal(cube.rows.length, 3); // 1/5 P/M 合并成一格、1/5 Q/M、1/6 P/M
  const merged = cube.rows.find((r) => r[4] === 3); // 行格式见 buildCube 的 JSDoc
  assert.ok(merged, "存在三笔合并的格子");
  assert.equal(merged[5], 1, "空响应计入 emptyReqs");
  assert.equal(merged[6], 30); // input 10+20+0
  assert.equal(merged[7], 12); // output 4+8+0
  assert.equal(merged[9], 30); // reasoning 溢出：仅 m2 的 30
  const expected = (30 * 2 + (12 + 30) * 20 + (2 + 4) * 0.2 + (0 + 1) * 2) / 1e6;
  assert.ok(Math.abs(merged[12] - expected) < 1e-8, "成本按牌价并计入 reasoning 补计");
});

test("renderText 含模型行、总计行、成本口径与 reasoning 说明", () => {
  const s = aggregate([rec()], {});
  const text = renderText(s);
  assert.ok(text.includes("acme/example-model"));
  assert.ok(text.includes("TOTAL"));
  assert.ok(text.includes("60.6%")); // input 100/165
  assert.ok(text.includes("30.3%")); // output 50/165
  assert.ok(text.includes("prices.json"));
});

test("renderHtml 内嵌 echarts 与立方体数据、无未替换占位符", () => {
  const echartsJs = fs.readFileSync(
    path.join(__dirname, "..", "plugin", "usage-monitor", "vendor", "echarts.min.js"), "utf8");
  const summary = aggregate([rec()], {});
  summary.records = [rec()]; // main() 会把去重后的记录交给 renderHtml 压成立方体
  summary.prices = {};
  const html = renderHtml(summary, echartsJs);
  assert.ok(html.includes("echarts"));
  assert.ok(html.includes("example-model")); // 模型名保存在立方体字典里
  assert.ok(html.includes('id="selRange"') && html.includes('id="segGran"') && html.includes('id="segScope"')); // 时间 / 粒度 / 渠道口径
  assert.ok(html.includes('id="rangeBtn"') && html.includes('id="calPanel"')); // 自定义区间与日历
  assert.ok(html.includes('id="csvBtn"') && html.includes("导出 CSV")); // CSV 导出入口
  assert.ok(html.includes('id="tbl"'));
  assert.ok(html.includes("空响应"));
  assert.ok(!html.includes("__DATA__"));
  assert.ok(html.startsWith("<!doctype html>"));
});

test("main dry-run：读样例数据、写 HTML、stdout 输出汇总", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-main-"));
  const data = path.join(dir, "data.jsonl");
  const out = path.join(dir, "report.html");
  fs.writeFileSync(data, JSON.stringify(rec()) + "\n");
  const { main } = require("../plugin/usage-monitor/report.js");
  const text = main(["--data", data, "--out", out, "--prices", path.join(dir, "none.json")]);
  assert.ok(text.includes("acme/example-model"));
  const html = fs.readFileSync(out, "utf8");
  assert.ok(html.startsWith("<!doctype html>"));
});
