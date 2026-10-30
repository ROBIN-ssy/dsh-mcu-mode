---
name: authoring-mcu-skills
description: 在单片机模式里新增、修改、调试开发用的 skill：该放哪个目录、SKILL.md 的 frontmatter 怎么写、description 怎么写才容易被触发、改完何时生效、怎么验证。用于「给我加一个 skill」「把这个流程做成 skill」「skill 没被加载/没触发」等请求。
whenToUse: 用户要求新增或修改 skill，或某个 skill 没有按预期生效时。
---

# 在这个模式里加 skill

## 放在哪

| 位置 | 作用范围 | 何时用 |
|---|---|---|
| `<预设目录>\skills\<name>\SKILL.md` | 只在本模式（单片机模式）里可见 | 单片机开发专用知识（默认选这里） |
| `$DSH_HOME\skills\<name>\SKILL.md`（即 `C:\Users\<你>\.dsh\skills\`） | 所有模式可见 | 跨模式的通用习惯 |
| `<工程目录>\.dsh\skills\<name>\SKILL.md` | 只在该工程里可见 | 项目专属约定 |

当前预设目录可以在「设置 → Agent Presets（模式）」里对 `mcu` 那一行点"打开位置"，或直接看 `$DSH_HOME\.agent-presets\mcu\`。

也支持扁平文件：`<root>\<name>.md`。**不支持**嵌套（`a/b/SKILL.md` 不会被发现）。

## frontmatter

```markdown
---
name: my-skill-name          # 必填，kebab-case（小写字母/数字/连字符），要和目录名区分开也没关系，但推荐一致
description: 一句话说清它解决什么问题、什么请求该用它。把触发词写进去：型号、外设名、工具链名、报错名、动作词。
whenToUse: 可选，补充"什么时机用"。
---

# 正文（Markdown）

模型读到的内容是正文；写可执行的步骤、命令、判断依据、反例，不要写空话。
```

可选字段：`disable-model-invocation: true`（不给模型用）、`user-invocable: false`（不给用户用）、`metadata`。

**description 决定它会不会被触发**：写清"做什么 + 什么时候用 + 关键词"。例如：

- 好：`STM32 的 SPI/I2C 屏幕与传感器驱动：初始化顺序、时序参数、常见花屏/无应答排查。用于点亮 OLED/TFT、读传感器、SPI/I2C 通信不通等请求。`
- 差：`一些单片机技巧` —— 模型不知道什么时候该加载它。

## 改完何时生效

- **新增/修改 skill 文件**：技能目录被 watcher 监视，新文件会被实时发现，**不需要重启**；正文每次加载都重新读，所以改正文立即生效。
- **改 `agent.cordis.yml`（组合）**：只对**之后新建**的会话生效，已经在跑的会话仍用挂载时的那份组合。改了组合后开新对话即可。
- **改插件代码（`plugin/*.mjs`）**：同上，需要新会话（或重启 dsh）。

## 验证

1. `skill` 工具（或让 Agent 调 `skill`）列出目录，确认名字出现、description 正确。
2. 让 Agent 加载一次：`skill(name="你的名字")`，看正文是否是你写的内容。
3. frontmatter 写错（缺 `name`、非 kebab-case、`disable-model-invocation` 给了非法值）会让**整个 skill 被静默丢弃**——目录里看不到，说明就是写错了，对着上面的模板改。
4. 想确认发现根目录，可以看会话启动时 `skill-filesystem` 的候选；本模式的预设 skill 根目录是 `<预设目录>\skills`。

## 写 skill 的内容建议

- 一个 skill 一件事；把"判断分支"写清楚（先判断工程用 Keil 还是 CubeIDE，再选命令）。
- 命令给全（路径、参数、成功判据），并把机器相关的路径标成"按本机安装位置调整"。
- 把踩过的坑写成"现象 → 原因 → 处理"，这比抽象原则有用得多。
- 与 `mcu-firmware-workflow` 的分工：流程类纪律留在那个 skill，具体工具链/器件知识各自成 skill。
