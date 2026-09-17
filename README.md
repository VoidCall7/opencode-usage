# OpenCode Usage

本地 OpenCode 的 token 用量监控：一个插件 + 一条 `/usage` 命令 + 一份可交互的 HTML 报告。

插件在后台记录每条 assistant 消息的 token 消耗（写入本地 JSONL），`/usage` 一键生成暗色主题的 ECharts 报告：按模型 / 渠道 / 项目 / 时间的用量与成本、趋势堆叠、区间环比、CSV 导出、自定义时间区间等。**所有数据只留在本机，不联网上传。**

## 特性

- **自动采集**：监听 OpenCode 的 `message.updated` 事件，记录 input / output / reasoning / cache read / cache write / cost；同 messageID 去重，串行写队列避免并发交错，异常绝不冒泡影响主会话。
- **历史回填**：从 OpenCode 本地数据库（`opencode.db`）导入历史用量，按 messageID 幂等，可反复执行。
- **文本汇总**：`/usage` 直接在对话里给出按模型的汇总表，终端即可看。
- **HTML 报告**：ECharts 趋势堆叠图（前 8 模型 + 其他）、模型构成与排行、项目对比、明细表；支持预设与自建时间区间（含双月日历）、日 / 月 / 年粒度自适应、TOKEN / COST 切换、区间环比、悬停交叉高亮、明细 CSV 导出。
- **渠道口径可切换**：默认按「渠道 / 模型」拆分（同名模型走不同渠道分开统计），也可切为「合并同名」视图。
- **项目路径归一化**：反斜杠 / 正斜杠、重复与结尾斜杠、根目录回落 directory 等写法差异收敛为同一个项目，避免同一项目被拆成两行。
- **成本口径单一**：只按 `prices.json` 牌价计算（记录 token × 单价），不读取消息自带的 `cost`，避免两个来源混在一列；未配置价格表的模型成本记为 0。
- **reasoning 口径**：`reasoning` 单列统计；当某条记录的 reasoning 超过 output（部分中转渠道把思考 token 单独计数）时，超出部分计入合计与成本。
- **聚合立方体**：报告页内嵌按「日 × 项目 × 渠道 × 模型」聚合的立方体（不含逐条明细），文件体积小、区间切换快。
- **零运行时依赖**：采集与报告只用 Node 内置模块；报告页的 ECharts 已内联在 `vendor/`，不联网加载。

## 安装

需要：

- [OpenCode](https://opencode.ai)（插件从 `~/.config/opencode/plugin/` 加载）
- [Node.js](https://nodejs.org)：生成报告 18+ 即可；历史回填使用 `node:sqlite`，需要 22.5+（本仓库在 Node 24 上测试）

把仓库里的 `plugin/`、`command/` 两个目录合并进 OpenCode 配置目录（`~/.config/opencode`，Windows 即 `%USERPROFILE%\.config\opencode`）。

macOS / Linux：

```bash
git clone https://github.com/VoidCall7/opencode-usage
mkdir -p ~/.config/opencode/plugin ~/.config/opencode/command
cp -r opencode-usage/plugin/* ~/.config/opencode/plugin/
cp -r opencode-usage/command/* ~/.config/opencode/command/
```

Windows PowerShell：

```powershell
git clone https://github.com/VoidCall7/opencode-usage
Copy-Item -Recurse -Force opencode-usage\plugin\* "$env:USERPROFILE\.config\opencode\plugin\"
Copy-Item -Recurse -Force opencode-usage\command\* "$env:USERPROFILE\.config\opencode\command\"
```

安装后重启 OpenCode 生效。首次产生用量时会在 `~/.config/opencode/usage/` 下自动创建 `data.jsonl`。

> 如果你的配置目录不在 `~/.config/opencode`（例如设置了 `XDG_CONFIG_HOME`），需要同步修改 `command/usage.md` 与插件里的路径。

## 使用

在 OpenCode 中执行：

```
/usage
```

会运行报告脚本：终端输出汇总、写入并打开 HTML 报告。

手动运行（默认路径）：

```bash
node ~/.config/opencode/plugin/usage-monitor/report.js --open
```

报告默认写到 `~/.config/opencode/usage/usage-report.html`。

### CLI 参数

| 参数 | 说明 |
| --- | --- |
| `--open` | 生成后用默认浏览器打开 |
| `--no-db` | 跳过历史回填（数据量大或数据库不可用时提速） |
| `--data <path>` | 指定 `data.jsonl`（默认 `~/.config/opencode/usage/data.jsonl`） |
| `--out <path>` | 指定输出 HTML（默认 `~/.config/opencode/usage/usage-report.html`） |
| `--prices <path>` | 指定价格表（默认 `~/.config/opencode/usage/prices.json`） |
| `--db <path>` | 指定 OpenCode 数据库路径（默认 `~/.local/share/opencode/opencode.db`），用于增量回填 |

### 历史回填

`report.js` 在使用默认数据路径时会先静默增量回填一次；也可以手动执行：

```bash
node ~/.config/opencode/plugin/usage-monitor/import-history.js
```

输出形如「回填完成：导入 N 条，已存在跳过 M 条，无完成时间跳过 K 条」。重复执行不会重复导入。

## 价格表（可选）

`~/.config/opencode/usage/prices.json`，单位 **USD / 每 1M tokens**：

```json
{
  "provider/model-id": {
    "input": 0.15,
    "output": 0.6,
    "cacheRead": 0.003,
    "cacheWrite": 0
  }
}
```

- key 为 `providerID/modelID`（与报告中的模型名一致）。
- 成本只按此表计算：记录 token × 对应单价（输出侧包含 reasoning 溢出量）；表里没有的模型成本记 0。
- 示例见 [prices.example.json](prices.example.json)，复制改名为 `prices.json` 即可。

## 数据与隐私

- 采集数据只写入本机 `~/.config/opencode/usage/data.jsonl`，不上传任何地方。
- 生成的 HTML 报告内嵌按日聚合的立方体（含项目路径，但不含逐条消息与价格表），**分享前注意脱敏**。
- 仓库不含任何个人数据；`data.jsonl`、`usage-report.html`、`prices.json` 已列入 `.gitignore`。

## 目录结构

```
plugin/
  usage-monitor.ts                  # OpenCode 插件入口（事件钩子 + 串行写队列）
  usage-monitor/
    recorder.js                     # 采集核心（记录判定、token 扁平化、messageID 去重）
    report.js                       # CLI：读数据 → 文本汇总 + HTML 报告
    import-history.js               # 从 opencode.db 回填历史用量
    vendor/echarts.min.js           # Apache ECharts 5.6.0 自定义轻量构建（按需打包图表与组件，Apache-2.0）
command/
  usage.md                          # /usage 命令（shell 替换调用 report.js）
test/                               # node:test 测试 + 样例数据
```

## 开发

```bash
npm test          # 等价于 node --test
```

测试覆盖采集判定、去重、项目路径归一化、reasoning 口径、牌价成本、立方体聚合、参数解析、文本 / HTML 渲染与 CLI dry-run；不装任何依赖也能跑。

## 兼容性

- OpenCode：插件基于 `@opencode-ai/plugin` 1.x 接口；报告 CLI 与 OpenCode 版本无关。
- Node.js：报告 18+；`node:sqlite`（历史回填）需要 22.5+（22.5–23.3 可能需要 `--experimental-sqlite`，23.4+ 默认可用）。
- 平台：Windows / macOS / Linux 均可（报告打开浏览器已做三平台适配）。

## 许可

[MIT](LICENSE)。内联的 [Apache ECharts](https://echarts.apache.org/) 5.6.0 自定义轻量构建（含 zrender 5.6.1）为 Apache-2.0，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 [licenses/APACHE-2.0.txt](licenses/APACHE-2.0.txt)。
