"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readRecords, dedupe, localDate, loadPrices, estimateCost, aggregate,
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
