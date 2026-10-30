# 单片机模式（DSH 用户预设 `mcu`）

一个为单片机/嵌入式开发准备的 DSH 模式。它 = **标准模式的全部能力** + **单片机型号登记与使用档案** + **自带 skills 目录**。

用它的理由：写固件时最怕"给错型号的寄存器/时钟/引脚结论"，也最需要"上次这颗片子怎么调通的"。这个模式把这两件事变成机制：

- **每个对话都知道自己用的是哪颗芯片**：绑定后型号、工程、目标功能、外设会持续注入系统提示；会话标题被改成「型号 · 功能」，在左侧对话列表里一眼就能看出每个对话用的是哪颗单片机。
- **型号与使用记录会沉淀下来**：型号库（规格）+ 使用档案（会话/工程/功能/踩坑/构建命令），写成 `registry.json`（机器读）与 `REGISTRY.md`（人读）。
- **skills 随模式走**：`skills/` 目录里的 SKILL.md 只在本模式生效，你可以随时往里加自己的开发 skill。

## 怎么用

1. 新建对话时，在新建页选择模式 **单片机模式**（或：设置 → 通用 → 模式，把它设为默认，之后新建对话都走它）。
2. 直接说需求即可（也可以先说「看下我这个工程」）。Agent 会先调用 **`mcu_scan` 扫描工程**：
   - 用确定性扫描器把**型号、工具链、固件库、外设、端口、引脚、时钟、存储**连同「哪个文件给出了什么值」一起列出来；
   - **扫到明确型号就自动绑定本会话**（不需要你操作，也不靠模型自觉），并更新会话标题；
   - 然后把那张证据表贴给你，再谈方案。工程不在工作区时直接告诉它路径（它会用 `path` 参数扫）。
3. 绑定后你会看到：会话标题变成「STM32F407VET6 · TFT 屏驱动 · 我的工程」，Agent 每次回答都按这颗型号来，做完一项工作会用 `mcu_note` 记一条。
4. 想看档案：`$DSH_HOME/mcu/REGISTRY.md`（默认 `%USERPROFILE%\.dsh\mcu\REGISTRY.md`），或者直接问 Agent「我现在记录了哪些单片机」。

> 模式的选择是**新建对话时**决定的：已经在跑的对话不会切换组合（它的历史是用旧工具集产生的）。改了本预设的组合文件后，也请开新对话。

## 六个工具

| 工具 | 作用 |
|---|---|
| **`mcu_scan`** | **扫描单片机工程**：型号 / 工具链 / 固件库（HAL·SPL·LL）/ RTOS / 外设 / 端口 / 引脚 / 时钟 / 存储，逐条附「文件 → 关键值」；型号明确时自动绑定本会话。第一步就该用它 |
| `mcu_bind` | 手动把当前对话绑定到某颗型号（型号/工程/目标功能/外设/工具链/规格/依据），写档案、改会话标题 |
| `mcu_status` | 查本会话绑定的是哪颗、该型号的规格、累计会话与最近记录（不确定时先查它，不要凭记忆猜） |
| `mcu_note` | 记一条使用记录：功能 / 外设 / 驱动 / 协议 / 踩坑 / 调试 / 构建 |
| `mcu_list` | 列出用过的型号（会话数、工程、功能、最近使用）与型号库里还没用过的 |
| `mcu_catalog_set` | 新增/补全型号库里的规格（厂商、系列、内核、主频、Flash/RAM、封装、供电、工具链、片上资源、备注） |

### 扫描器能看出来的东西（都是"文件 → 值"级别的证据）

| 项目 | 从哪看 |
|---|---|
| 型号 | `.ioc` 的 `Mcu.Name`/`DeviceId`/`CPN`、`*.uvprojx` 的 `<Device>`、`startup_*.s` 文件名、Makefile 的 `DEVICE`、器件头文件名、源码注释里的 `MCU :` |
| 工具链 | `.uvprojx` → Keil MDK（含 target 名）、`.cproject` → CubeIDE、`Makefile`/`CMakeLists.txt` → GCC、`platformio.ini` → PlatformIO |
| 固件库 | `stm32fXxx_conf.h` / `USE_STDPERIPH_DRIVER` → SPL；`*_hal.h` / `USE_HAL_DRIVER` → HAL；`*_ll_*.h` → LL |
| 外设 / 端口 | 设备宏（`USART1`、`TIM3`、`SPI2`…）、`RCC_APBxPeriph_*`、`XXX_IRQHandler`、`MX_*_Init`；GPIO 端口单列 |
| 引脚 | `GPIO_Pin` + `GPIO_Port` 配对、`PBout(0)`/`PEin(4)` 位带宏、`#define SCK PB13`、注释里的 `SCK=PB13` |
| 时钟 / 存储 | Keil `<Cpu>` 的 `CLOCK`/`IROM`/`IRAM`、`.ioc` 的 `HSE_VALUE`/`PLLM·N·P`、`RCC_PLLConfig`、链接脚本 `MEMORY`、启动文件 Stack/Heap |

厂商库目录（FWLIB / Drivers / Libraries / CMSIS / `system_stm32*.c`）只用来判定库类型，**不会被当成"这个工程用了什么"的证据**，所以结论不会被库文件里列出的所有外设污染。扫描有界（深度 5 层、最多 900 个目录、80 个源文件、单文件 256KB），扫不完会明确标出"被截断"。

## 数据放在哪

| 文件 | 内容 |
|---|---|
| `$DSH_HOME/mcu/registry.json` | 权威档案：`catalog`（型号库）+ `mcus`（每颗型号的使用档案）+ `sessions`（每个对话的绑定）+ `log`（时间线） |
| `$DSH_HOME/mcu/REGISTRY.md` | 同一份数据的人读汇总（型号一览表、会话索引、型号档案、时间线），每次写入自动重生成，**手改会被覆盖** |
| `<预设目录>/catalog.seed.json` | 预置型号库（STM32 F1/F4/H7 与 51 的常用型号）。**只在档案里型号库为空时**读入，之后以 `registry.json` 为准 |

`$DSH_HOME` 默认是 `%USERPROFILE%\.dsh`。想换档案目录，改下面配置里的 `dataDir`。

手改 `registry.json` 是允许的（字段形状不完整也能安全读出：缺数组补空、坏项丢弃）；文件坏掉不能解析时，插件会把它改名成 `registry.json.corrupt-<时间戳>` 保留现场，然后从空档案继续，不会让会话起不来。

## 加你自己的 skill

两种放法：

- **只在本模式生效**：`<预设目录>\skills\<名字>\SKILL.md`（推荐，随预设走）
- **所有模式都能用**：`$DSH_HOME\skills\<名字>\SKILL.md`

frontmatter 至少要有 `name`（kebab-case）和 `description`（写清"做什么 + 什么时候用 + 关键词"）：

```markdown
---
name: my-stm32-can
description: STM32 bxCAN 的初始化与过滤器配置、回环测试、常见收不到帧的排查。用于 CAN 通信、收发不上、过滤器配置等请求。
---

# 正文（模型读到的就是这部分）
```

格式细节、触发词写法、何时生效、怎么验证，见本模式自带的 skill `authoring-mcu-skills`（直接问 Agent「怎么在这个模式里加 skill」也行）。新增 skill 文件会被 skill 的 watcher 实时发现，**不需要重启**。

## 改这个模式

组合文件：`<预设目录>\agent.cordis.yml`（就是 `%USERPROFILE%\.dsh\.agent-presets\mcu\agent.cordis.yml`）。它是标准的 Cordis 行列表，`mcu-registry` 那一行的 `config` 就是插件配置：

```yaml
- id: mcu-registry
  name: './plugin/mcu-registry.mjs'
  config:
    renameSessionTitle: true   # 绑定时把会话标题改成「型号 · 功能」
    promptSection: true        # 把本会话型号注入系统提示
    promptSectionOrder: 90     # 段落顺序（0 人格，100-199 工具说明）
    seedCatalog: true          # 首次运行用 catalog.seed.json 初始化型号库
    autoBindOnScan: true       # mcu_scan 扫到明确型号且本会话未绑定时自动绑定
    probeInSection: true       # 未绑定会话里，在系统提示中内联工作区廉价探测结果
    probeCacheSeconds: 30      # 探测结果缓存秒数（系统提示每步都会组装）
    historyLimit: 400          # 时间线保留条数
    recentNotes: 3             # 系统提示里带几条该型号最近记录
    titleMaxBytes: 72          # 会话标题字节上限（要小于部署 session-title 的 80）
    # dataDir: 'D:\mcu-archive'  # 档案目录，省略即 $DSH_HOME/mcu
```

- **改 skill 文件**：立即生效（skill 目录有 watcher），新老对话都能看到。
- **改组合 `agent.cordis.yml`**：对**之后新建**的对话生效（已在跑的对话仍用挂载时那份组合）。
- **改插件代码 `plugin/*.mjs`**：**必须重启后端**（桌面版菜单里有「重启后端服务」）。原因：一行的模块由 Node 按路径缓存，新建对话虽然会挂载新组合，但同一路径的模块仍返回缓存里的旧代码。
- **改 `catalog.seed.json`**：对之后挂载的新组合生效（它是 apply() 时读的）；只在档案里的型号库为空时才会用上。
- 想改人格与纪律（"先扫描、给证据"这类硬要求），改 `persona` 那一行的 `text`。
- 想禁用某个能力（比如禁用 `mcu_note`），删掉 `apply()` 里对应那行 `ctx.tools.register(...)`。

### ⚠️ 给插件写代码时的硬规则

预设目录上方**没有** `node_modules`：组合文件里只有「一行的 `name`」会按 harness 安装目录解析，插件文件**自己的** `import` 由 Node 按文件位置解析。所以插件里只能 `import` `node:` 内置模块或相对路径；一旦写了裸包名（`import z from '@deepseek-ai/schemastery'`），这一行导入失败会让**整个预设挂载失败**，表现就是「点新会话没反应」。参数/出参 schema 因此手写成**原始 JSON Schema**，入参校验由插件自己做（`validateRaw`）。自检脚本里有专门一条守卫检查这件事。

## 自检与排障

预设自带两个脚本。第一个覆盖六个工具的入参/出参 schema、系统提示段落、会话标题、档案读写、畸形/损坏档案恢复、工程扫描器、组合文件与 skills 结构：

```powershell
# 预设目录下需要有一个指向 harness node_modules 的 junction，让测试脚本能 import
# harness 的校验器与 js-yaml（**只有测试需要**；插件本体不依赖任何外部包）
$root = "%USERPROFILE%\.dsh\.agent-presets\mcu"
New-Item -ItemType Junction -Path "$root\node_modules" `
  -Target "%USERPROFILE%\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules"
node "$root\test\run-tests.mjs"
```

第二个用 DSH 花名册自己的发现代码验证「这个模式能被选到」——它检查目录名是否合法、`agent.cordis.yml` 能否用加载器方言解析、是不是带 id/name 的行列表，也就是设置页里显示 "Failed to load" 的那套判断：

```powershell
node "$root\test\verify-roster.mjs"
```

两个脚本都只写 `test/tmp-data/`，跑完自动删除，不碰真实档案。跑完可以删掉 junction。

### 「点新会话没反应」怎么查

GUI 里新建会话失败时，**真实原因在客户端日志里**（桌面版）：

```powershell
Get-Content "%USERPROFILE%\.dsh\logs\desktop.log" -Tail 20 | Select-String "new session failed"
```

想不看 GUI 直接复现「新建会话」这一步（走的是同一个 RPC），用下面两条：第一条必须是花名册检查（只读），第二条才是真的建会话：

```powershell
# 花名册：能看到 mcu / trust=user / isDefault
curl.exe -s -X POST "http://127.0.0.1:3080/api/agentPreset.list" `
  -H "Content-Type: application/json" `
  --data-binary '{\"type\":\"client-request\",\"rpcId\":\"r1\",\"method\":\"agentPreset.list\",\"payload\":{}}'

# 真的建一个会话：ok:true 且 agentPreset 正确 = 预设挂载正常；失败会直接回 agent-preset-invalid 的原因
curl.exe -s -X POST "http://127.0.0.1:3080/api/session.create" `
  -H "Content-Type: application/json" `
  --data-binary '{\"type\":\"client-request\",\"rpcId\":\"r2\",\"method\":\"session.create\",\"payload\":{\"cwd\":\"E:\\\\DSH_work\"}}'
```

（`/api` 只信任 loopback 的 `Host`，本机 curl 直接可用。）

## 限制与注意

- **模式不能中途切换**：会话建立后就固定了（历史是用该组合的工具集产生的），要换模式请新建对话。
- **档案是进程外的事实**：它按 session id 记绑定，所以复制/迁移 DSH 数据目录时，`$DSH_HOME/mcu/` 要一起带上。
- **同一台机器同时跑两个 dsh 实例**时，两个进程各自持有内存副本并以文件 mtime 感知对方改动：极少见的并发写可能以"后写覆盖"收场（会先把对方的改动读进来再写，正常使用不会丢记录）。
- **本预设属于你的用户目录**（`.dsh\.agent-presets\mcu`），升级 dsh 不会覆盖它；反过来，dsh 升级若改了工具包接口，可能需要你同步更新插件。
- 想删掉这个模式：设置 → Agent Presets 里对 `mcu` 那一行执行删除（或直接删目录）。**注意**：删预设不会删档案，`$DSH_HOME/mcu/` 里的记录仍在。
- 它和 **PTC 模式**的区别：PTC 用 Code Mode 把工具折叠成一个 `run_code` 程序入口；本模式用原生工具调用，行为更可预期，适合逐条命令、逐次阅读寄存器/日志的嵌入式工作流。
