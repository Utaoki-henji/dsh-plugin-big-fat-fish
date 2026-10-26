# 测试工程师 大肥鱼 · Test Engineer Big Fat Fish

**Black-box functional testing for DeepSeek Harness** — HTTP APIs, Vue/Web pages, and front-end/back-end consistency, driven by conversation.

[中文](#中文说明) · [English](#english)

---

## What it is

`dsh-plugin-big-fat-fish` is a DeepSeek Harness (DSH) Host bundle. It adds three executor tools and one methodology skill:

| Kind | Name | What it does |
| --- | --- | --- |
| Tool | `ft_http_run` | Sends HTTP requests (suite of cases or inline cases), evaluates `status` / `jsonPath` / `headers` / `latencyMs` assertions, extracts variables, persists evidence |
| Tool | `ft_ui_run` | Drives local Chrome/Edge via `playwright-core`: page flows, selectors, waits, assertions, screenshots, console and failed-request capture |
| Tool | `ft_report` | Rebuilds a human-readable report from stored runs (single or aggregated, with known-failure marking) |
| Skill | `functional-testing` | The methodology: requirements → interface/UI entry review → test-case design → data confirmation → execution → attribution → per-round record and report |

The skill owns **what to test, what "expected" means, and whether a failure is a product bug, a test-case bug, or an environment problem**. The tools only execute and keep evidence — they never guess.

What it is good at:

- Acceptance/regression testing of a version or module through its **real interfaces and real pages** (no mocks, no source changes).
- Reusing a **login profile** per project: after a login interface is probed once, every later round runs `login + feature` together.
- Writing per-round records: goal, coverage, test data, anomaly reproduction — so a report can be reproduced by another person.
- Front-end/back-end consistency checks: the same data read through the API and rendered on the page, compared field by field.

## Installation

> Requires a DSH build with the plugin manager and Node 22+. UI tests additionally need local Chrome or Edge.

Pick one:

```sh
# npm (recommended)
dsh plugin --profile web add dsh-plugin-big-fat-fish
```

```sh
# GitHub source (pin a commit for reproducibility)
dsh plugin add github:<owner>/dsh-plugin-big-fat-fish#<commit>
```

**Desktop app**: open **Settings → Plugins → Install**, and enter the npm package name `dsh-plugin-big-fat-fish` (or the GitHub spec above). Then restart the Harness.

**Offline / conversation install**: download the release bundle (`dsh-plugin-big-fat-fish-v<version>.zip`) and ask the assistant to install it — the bundle ships its own `node_modules/playwright-core` and needs no network during install.

After installing, the plugin appears as **测试工程师 大肥鱼** with the `functional-testing` skill.

## Usage

Start a conversation turn with one of:

- 「开始测试」 / 「开始测试接口」 / 「开始测试页面」
- "start testing", "test this API", "test this page"

The skill then walks these steps, asking you for what it cannot know:

1. **Confirm the project** (name / repository / service).
2. **Choose the test kind**: interface only · UI only · module (API + UI + front-end/back-end consistency).
3. **Give the entry**: API base URL and path (or Controller/API doc) or the UI route; environment and credential source.
4. **Login profile**: if the interface needs a token, it reads `.ft/logins/<project>.json`; without a profile it asks you for the login interface rather than guessing a path.
5. **Read the code** (read-only) to derive the contract and branch checklist — never modified, never instrumented.
6. **Confirm execution logic** for multiple interfaces: sequential / branching / parallel, and the concrete order (it will not infer call chains from code structure).
7. **Prepare test data** and show you a data-confirmation card before writing anything.
8. **Execute**: 3–5 smoke cases first, then the full set; one run per topic.
9. **Record and report**: per-round goal, coverage, test data, anomaly reproduction, plus a combined report.

## Workspace state

Everything the plugin keeps lives under `.ft/` in the current workspace (never in your project source):

```text
.ft/
  config.json              # api/ui base URLs, allowed hosts, destructive rules, size limits
  credentials.local.json   # local credential store (gitignored; env vars override it)
  logins/<project>.json    # login profile: endpoint, token path, auth header, env var names
  suites/                  # reusable test suites (credentials stay as ${env:...} placeholders)
  runs/<runId>/            # results.jsonl, evidence, screenshots, report
```

`ensureWorkspaceState` writes a `.ft/.gitignore` so runs, credentials and auth artifacts never leak into your repository.

## Requirements

- DSH with plugin manager (Host bundle support).
- Node.js 22+ (`node --test` era; the bundle is ESM).
- Local Chrome or Edge for `ft_ui_run` (it drives your installed browser; no browser download required).
- Network access to the targets you test.

## Safety and privacy

- **Read-only on your project**: the plugin never edits project source, never injects instrumentation, never runs your build.
- **Writes are confined** to the workspace `.ft/` state directory.
- **Secrets**: credentials come from environment variables or `.ft/credentials.local.json`. Logs, evidence and persisted suites redact secret keys (`authorization`, `cookie`, `password`, `token`, …) and keep `${env:...}` placeholders instead of values.
- **No telemetry**: the tools talk only to the base URLs you provide.
- **Destructive calls are opt-in**: non-GET calls must be marked `destructive: true` in the case and allowed by `.ft/config.json`.
- UI automation launches an isolated browser context; it does not touch your everyday browser profile.

## Scope and limitations

- **Execution is black-box only**: HTTP requests plus real-browser UI flows. There is no unit-test execution, no code coverage, no breakpoints or instrumentation.
- **White-box is static and read-only**: during step 5 the assistant may read Java/Spring controllers, DTOs, validation and service branches, or Vue routes and API layers, to derive expectations. Nothing is executed from that reading.
- `concurrency` is fixed at 1; parallel requests run sequentially in the confirmed order.
- `ft_ui_run` uses the local Chrome/Edge channel. Headless mode and login state (`storageState` / cookies) are supported.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

**面向 DeepSeek Harness 的黑盒功能测试插件**：接口、页面、前后端一致性，用对话驱动。

### 它是什么

一个 DSH Host 组合包，注册 3 个执行工具 + 1 个方法论 skill：

- `ft_http_run`：批量发 HTTP 请求，断言 `status` / `jsonPath` / `headers` / `latencyMs`，提取变量，落盘证据；
- `ft_ui_run`：用 `playwright-core` 驱动本机 Chrome/Edge，跑页面流程、断言、截图、收集控制台报错与失败请求；
- `ft_report`：从已落盘的 run 生成/汇总人读报告，支持标记已知失败；
- `functional-testing` skill：负责「测什么、期望是什么、失败算谁的」——从代码/接口摸底，到用例设计、数据确认、执行、归因、每轮档案与报告。

它擅长：

- 通过**真实接口、真实页面**做版本/模块验收与回归（不 mock、不改项目源码）；
- 每项目复用**登录档案**：登录接口探明一次后，之后每轮默认「登录 + 本轮功能」联合测试；
- 每轮留下**可复现**的档案：目标 / 覆盖范围 / 测试数据 / 异常复现方式；
- 前后端一致性：同一份数据经接口与页面分别读取，逐字段比对。

### 安装

> 需要带插件管理器的 DSH（Host bundle 支持）与 Node 22+；UI 测试还需要本机装有 Chrome 或 Edge。

三选一：

```sh
# npm（推荐）
dsh plugin --profile web add dsh-plugin-big-fat-fish
```

```sh
# GitHub 源码（建议固定 commit）
dsh plugin add github:<owner>/dsh-plugin-big-fat-fish#<commit>
```

**桌面端**：打开 **设置 → 插件 → 安装**，填 npm 包名 `dsh-plugin-big-fat-fish`（或上面的 GitHub spec），然后重启 Harness。

**离线 / 对话安装**：拿到发布包 `dsh-plugin-big-fat-fish-v<version>.zip`，让助手安装即可——发布包自带 `node_modules/playwright-core`，安装时不需要联网。

安装后插件显示为 **测试工程师 大肥鱼**，并带 `functional-testing` skill。

### 用法

在对话里说「开始测试」/「开始测试接口」/「开始测试页面」，或英文 "start testing"。

skill 会按顺序确认：项目 → 测试类型（接口 / 页面 / 模块）→ 入口地址或路由 → 登录档案（需要令牌时**不猜路径**）→ 只读代码得出契约与分支清单 → 多接口执行逻辑（顺序/分支/并行 + 具体顺序）→ 测试数据确认卡 → 先冒烟再全量 → 每轮档案与报告。

### 工作区状态

所有状态都在当前工作区的 `.ft/` 下（不写你的项目源码）：

```text
.ft/
  config.json              # 接口/UI 基址、允许的主机、写操作放行、响应体上限
  credentials.local.json   # 本地凭据库（被 gitignore，环境变量优先）
  logins/<project>.json    # 登录档案：接口、令牌路径、鉴权头、凭据环境变量名
  suites/                  # 可复用测试套件（凭据保留 ${env:...} 占位符）
  runs/<runId>/            # results.jsonl、证据、截图、报告
```

`ensureWorkspaceState` 会写入 `.ft/.gitignore`，避免 run、凭据、鉴权产物进入你的仓库。

### 安全与隐私

- **对项目只读**：不改源码、不插桩、不跑你的构建；
- **只写**工作区 `.ft/`；
- **凭据**来自环境变量或 `.ft/credentials.local.json`，日志/证据/套件按敏感键脱敏，落盘保留 `${env:...}` 占位符；
- **无遥测**：只访问你给的目标地址；
- **写操作需显式授权**：非 GET 用例必须标 `destructive: true` 且被 `.ft/config.json` 放行；
- UI 自动化使用独立浏览器上下文，不碰你日常浏览器的 profile。

### 边界

- **执行层只有黑盒**：HTTP 请求 + 真实浏览器 UI；没有单测执行、没有覆盖率、没有断点插桩；
- **白盒只读静态**：第 5 步允许只读 Java/Spring Controller、DTO、`@Valid`、Service 分支、Vue 路由与 API 层来推导期望，不执行任何代码；
- `concurrency` 固定为 1，并行请求按确认顺序串行；
- `ft_ui_run` 使用本机 Chrome/Edge，支持无头模式与登录态注入（`storageState` / cookies）。

### 许可证

MIT，见 [LICENSE](LICENSE)。
