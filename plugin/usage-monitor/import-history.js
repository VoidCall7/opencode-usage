"use strict";
// 回填 OpenCode 历史用量：从 opencode.db（SQLite，node:sqlite 只读）读取 assistant 消息，
// 用与插件相同的规则（completed/error、扁平化 token）转成统一记录，追加到 data.jsonl。
// 已存在于 data.jsonl 的 messageID 会跳过，可重复执行。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { recordFromMessage } = require("./recorder.js");

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data") opts.data = argv[++i];
    else if (argv[i] === "--db") opts.db = argv[++i];
  }
  return opts;
}

function main(argv = [], { quiet = false } = {}) {
  const home = os.homedir();
  const usageDir = path.join(home, ".config", "opencode", "usage");
  const opts = parseArgs(argv);
  const dataFile = opts.data || path.join(usageDir, "data.jsonl");
  const dbPath = opts.db || path.join(home, ".local", "share", "opencode", "opencode.db");

  const existing = new Set();
  if (fs.existsSync(dataFile)) {
    for (const line of fs.readFileSync(dataFile, "utf8").split("\n")) {
      try { existing.add(JSON.parse(line).messageID); } catch { /* 坏行忽略 */ }
    }
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const dirs = new Map(
    db.prepare("SELECT id, directory FROM session").all().map((s) => [s.id, s.directory])
  );
  const rows = db
    .prepare(
      "SELECT id, session_id, data FROM message " +
      "WHERE json_extract(data,'$.role')='assistant' AND json_extract(data,'$.tokens') IS NOT NULL"
    )
    .all();

  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  let imported = 0, skippedExisting = 0, skippedIncomplete = 0;
  for (const row of rows) {
    if (existing.has(row.id)) { skippedExisting++; continue; }
    let info;
    try { info = JSON.parse(row.data); } catch { continue; }
    info.id = info.id || row.id;
    const dir = dirs.get(row.session_id) || (info.path && info.path.cwd) || "";
    const rec = recordFromMessage(info, dir, dir);
    if (!rec) { skippedIncomplete++; continue; } // 未 completed 且无 error
    existing.add(rec.messageID);
    fs.appendFileSync(dataFile, JSON.stringify(rec) + "\n");
    imported++;
  }
  db.close();
  if (!quiet) {
    console.log(`回填完成：导入 ${imported} 条，已存在跳过 ${skippedExisting} 条，无完成时间跳过 ${skippedIncomplete} 条`);
    console.log(`数据文件: ${dataFile}`);
  }
  return imported;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main, parseArgs };
