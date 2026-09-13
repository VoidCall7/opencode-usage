"use strict";

function recordFromMessage(info, projectPath, directory, now = () => Date.now()) {
  if (!info || info.role !== "assistant") return null;
  const completed = info.time && info.time.completed;
  const hasError = !!info.error;
  if (!completed && !hasError) return null;
  const t = info.tokens || {};
  const cache = t.cache || {};
  return {
    time: completed || now(),
    projectPath: projectPath || directory || "",
    directory: directory || projectPath || "",
    sessionID: info.sessionID || "",
    messageID: info.id || info.messageID || "",
    providerID: info.providerID || "",
    modelID: info.modelID || "",
    tokens: {
      input: t.input || 0,
      output: t.output || 0,
      reasoning: t.reasoning || 0,
      cacheRead: cache.read || 0,
      cacheWrite: cache.write || 0,
    },
    cost: typeof info.cost === "number" ? info.cost : 0,
  };
}

class UsageStore {
  constructor(appendLine) {
    this.appendLine = appendLine;
    this.seen = new Set();
  }

  record(info, projectPath, directory, now) {
    const rec = recordFromMessage(info, projectPath, directory, now);
    if (!rec || !rec.messageID) return false;
    if (this.seen.has(rec.messageID)) return false;
    this.seen.add(rec.messageID);
    this.appendLine(JSON.stringify(rec));
    return true;
  }
}

module.exports = { recordFromMessage, UsageStore };
