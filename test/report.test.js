"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readRecords, dedupe, localDate, loadPrices, estimateCost, resolveCost, aggregate,
  renderText, renderHtml,
} = require("../src/report.js");

function rec(overrides = {}) {
  return {
    time: new Date(2026, 8, 13, 12, 0, 0).getTime(), // 2026-09-13 本地
    projectPath: "E:\\projA",
    directory: "E:\\projA",
    sessionID: "ses_1",
    messageID: "msg_1",
    providerID: "tryaigc",
    modelID: "gpt-5.6-luna",
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

test("dedupe 同 messageID 取最后一条", () => {
  const out = dedupe([rec({ cost: 1 }), rec({ cost: 2 }), rec({ messageID: "msg_9" })]);
  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.messageID === "msg_1").cost, 2);
});

test("localDate 用本地时区分桶", () => {
  const ts = new Date(2026, 8, 13, 23, 59).getTime(); // 本地 2026-09-13 23:59
  assert.equal(localDate(ts), "2026-09-13");
});

test("loadPrices 文件缺失返回空对象", () => {
  assert.deepEqual(loadPrices(path.join(os.tmpdir(), "no-such-prices.json")), {});
});

test("estimateCost 按每百万单价计算", () => {
  const c = estimateCost({ input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: 2 });
  assert.equal(c, 2);
});

test("resolveCost：override / 自带 cost / 兜底估算 三档语义", () => {
  const price = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  const r = rec({ cost: 0.5 });
  assert.ok(Math.abs(resolveCost(r, { ...price, override: true }) - 200 / 1e6) < 1e-12); // override 无视自带
  assert.equal(resolveCost(r, price), 0.5); // 自带 cost>0 直接用
  assert.ok(Math.abs(resolveCost(rec({ cost: 0 }), price) - 200 / 1e6) < 1e-12); // cost=0 兜底估算
  assert.equal(resolveCost(rec({ cost: 0 }), undefined), 0); // 无价格无 cost 为 0
});

test("aggregate：total 只含四类，reasoning 不参与求和", () => {
  const s = aggregate([rec()], {});
  assert.equal(s.totals.total, 165); // 100+50+10+5
  assert.equal(s.totals.reasoning, 20);
  assert.equal(s.totals.cost, 0.5);
});

test("aggregate：cost 为 0 时用价格表兜底", () => {
  const prices = { "tryaigc/gpt-5.6-luna": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } };
  const s = aggregate([rec({ cost: 0 })], prices);
  const expect = (100 * 1 + 50 * 2 + 10 * 0.1 + 5 * 0.2) / 1e6;
  assert.ok(Math.abs(s.totals.cost - expect) < 1e-12);
});

test("aggregate：override 无视自带 cost 重新计算", () => {
  const prices = { "tryaigc/gpt-5.6-luna": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, override: true } };
  const s = aggregate([rec({ cost: 0.5 })], prices);
  assert.ok(Math.abs(s.totals.cost - (100 * 1 + 50 * 2) / 1e6) < 1e-12);
});

test("aggregate 分组：按模型/日期/项目，range 取本地日期", () => {
  const r2 = rec({
    messageID: "msg_2",
    providerID: "other",
    modelID: "m2",
    projectPath: "E:\\projB",
    time: new Date(2026, 8, 12, 8, 0, 0).getTime(),
  });
  const s = aggregate([rec(), r2], {});
  assert.deepEqual(Object.keys(s.byModel).sort(), ["other/m2", "tryaigc/gpt-5.6-luna"]);
  assert.deepEqual(Object.keys(s.byDate).sort(), ["2026-09-12", "2026-09-13"]);
  assert.deepEqual(Object.keys(s.byProject).sort(), ["E:\\projA", "E:\\projB"]);
  assert.equal(s.range.from, "2026-09-12");
  assert.equal(s.range.to, "2026-09-13");
});

test("aggregate 空数据时 range 为 null 且不抛错", () => {
  const s = aggregate([], {});
  assert.equal(s.range.from, null);
  assert.equal(s.totals.total, 0);
});

test("renderText 含模型行、总计行与占比", () => {
  const s = aggregate([rec()], {});
  const text = renderText(s);
  assert.ok(text.includes("tryaigc/gpt-5.6-luna"));
  assert.ok(text.includes("TOTAL"));
  assert.ok(text.includes("60.6%")); // input 100/165
  assert.ok(text.includes("30.3%")); // output 50/165
});

test("renderHtml 内嵌 echarts 与数据、无未替换占位符", () => {
  const echartsJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "vendor", "echarts.min.js"), "utf8");
  const s = aggregate([rec()], {});
  s.records = [rec()]; // main() 会把带有效成本的记录嵌入页面供前端筛选
  const html = renderHtml(s, echartsJs);
  assert.ok(html.includes("echarts"));
  assert.ok(html.includes("gpt-5.6-luna"));
  assert.ok(html.includes('data-q="lastmonth"') && html.includes('data-q="quarter"')); // 快捷时间区间
  assert.ok(html.includes('id="dFrom"') && html.includes('id="dTo"') && html.includes('id="applyCustom"')); // 自定义时间区间
  assert.ok(html.includes('id="calPanel"') && html.includes('id="calGrid"')); // 自建日历选区
  assert.ok(html.includes("缓存率")); // 指标卡片含缓存率
  assert.ok(!html.includes("__DATA__"));
  assert.ok(html.startsWith("<!doctype html>"));
});

test("main dry-run：读样例数据、写 HTML、stdout 输出汇总", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-main-"));
  const data = path.join(dir, "data.jsonl");
  const out = path.join(dir, "report.html");
  fs.writeFileSync(data, JSON.stringify(rec()) + "\n");
  const { main } = require("../src/report.js");
  const text = main(["--data", data, "--out", out]);
  assert.ok(text.includes("tryaigc/gpt-5.6-luna"));
  const html = fs.readFileSync(out, "utf8");
  assert.ok(html.startsWith("<!doctype html>"));
});
