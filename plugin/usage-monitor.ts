import fs from "fs";
import os from "os";
import path from "path";
import type { Plugin } from "@opencode-ai/plugin";
import { UsageStore } from "./usage-monitor/recorder.js";

const usageDir = path.join(os.homedir(), ".config", "opencode", "usage");
const dataFile = path.join(usageDir, "data.jsonl");

const UsageMonitorPlugin: Plugin = async (input) => {
  let dirReady = false;
  const store = new UsageStore((line) => {
    if (!dirReady) {
      fs.mkdirSync(usageDir, { recursive: true });
      dirReady = true;
    }
    fs.appendFileSync(dataFile, line + "\n");
  });

  // 串行写队列：同一插件进程内并发事件不交错
  let pending: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => void) => {
    pending = pending.then(fn).catch(() => {});
  };

  return {
    event: async ({ event }) => {
      try {
        if (event.type !== "message.updated") return;
        const info = (event.properties as any)?.info;
        if (!info || info.role !== "assistant") return;
        const projectPath = input.worktree || input.directory;
        enqueue(() => store.record(info, projectPath, input.directory));
      } catch {
        // 绝不影响主会话
      }
    },
  };
};

export default UsageMonitorPlugin;
export { UsageMonitorPlugin };
