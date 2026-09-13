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

module.exports = { readRecords, dedupe, localDate, loadPrices, estimateCost, aggregate };
