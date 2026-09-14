"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { recordFromMessage, UsageStore } = require("../plugin/usage-monitor/recorder.js");

function msg(overrides = {}) {
  return {
    id: "msg_1",
    role: "assistant",
    sessionID: "ses_1",
    providerID: "acme",
    modelID: "example-model",
    time: { created: 1000, completed: 2000 },
    cost: 0.5,
    tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 5 } },
    ...overrides,
  };
}

test("completed 消息生成记录且扁平化 cache token", () => {
  const r = recordFromMessage(msg(), "E:\\proj", "E:\\proj");
  assert.ok(r);
  assert.equal(r.time, 2000);
  assert.equal(r.tokens.cacheRead, 10);
  assert.equal(r.tokens.cacheWrite, 5);
  assert.equal(r.tokens.input, 100);
  assert.equal(r.cost, 0.5);
});

test("未 completed 且无 error 的消息返回 null（流式中途不计数）", () => {
  const m = msg({ time: { created: 1000 } });
  assert.equal(recordFromMessage(m, "p", "d"), null);
});

test("带 error 的未完成消息仍记录", () => {
  const m = msg({ time: { created: 1000 }, error: { name: "ApiError" } });
  const r = recordFromMessage(m, "p", "d");
  assert.ok(r);
  assert.ok(r.time > 0); // completed 缺失时回退 now() 默认值
});

test("completed 缺失时用 now() 回退", () => {
  const m = msg({ time: { created: 1000 }, error: { name: "ApiError" } });
  const r = recordFromMessage(m, "p", "d", () => 9999);
  assert.equal(r.time, 9999);
});

test("UsageStore 同 messageID 只写一次", () => {
  const lines = [];
  const store = new UsageStore((line) => lines.push(line));
  assert.equal(store.record(msg(), "p", "d"), true);
  assert.equal(store.record(msg(), "p", "d"), false);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).tokens.cacheRead, 10);
});

test("UsageStore 拒绝无 messageID 的记录", () => {
  const lines = [];
  const store = new UsageStore((line) => lines.push(line));
  assert.equal(store.record(msg({ id: "" }), "p", "d"), false);
  assert.equal(lines.length, 0);
});
