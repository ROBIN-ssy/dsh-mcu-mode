/**
 * 单片机模式预设的自检脚本。
 *
 * 它做三件事：
 *   1. 用桩 ctx 加载 plugin/mcu-registry.mjs，验证注册的工具/提示段落数量与行为；
 *   2. 用 harness 自己的校验器（validateArgs / validateJsonSchemaValue）验证每个工具的
 *      入参与出参都符合声明的 schema，且返回值是 lossless JSON（注册表会拒绝其它形状）；
 *   3. 解析 agent.cordis.yml / preset.yml / skills / catalog.seed.json，验证组合结构完整
 *      （!!js 标签需要自定义 YAML 类型，见下）。
 *
 * 运行前提：预设目录下有一个指向 harness node_modules 的 junction，让裸包名
 * （@deepseek-ai/dsh-tools、js-yaml 等）能解析——生产环境由 dsh-agent-presets 的
 * 「裸包名从 harness 安装目录解析」规则完成，本脚本只在本地复现这条规则：
 *
 *   New-Item -ItemType Junction -Path "<预设目录>\node_modules" `
 *     -Target "C:\Users\<你>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules"
 *
 *   node test/run-tests.mjs
 *
 * 数据都写在 test/tmp-data/ 下，跑完会删掉，不碰真实档案 $DSH_HOME/mcu。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TMP = join(ROOT, 'test', 'tmp-data')

let checks = 0
let failures = 0
function check(name, ok, detail) {
  checks += 1
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
function section(title) {
  console.log(`\n== ${title} ==`)
}

/** 找出返回值里不是 lossless JSON 的部分（注册表会拒绝 undefined / 函数 / -0 / 循环引用 / 非普通对象）。 */
function findNonJson(value, path = '$', stack = new Set()) {
  if (value === undefined) return `${path} 是 undefined`
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return `${path} 是 ${typeof value}`
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path} 不是有限数`
    if (Object.is(value, -0)) return `${path} 是 -0`
    return undefined
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined
  // 同一对象出现在两条路径上是 DAG（合法），只有「当前路径上重复出现」才是循环引用。
  if (stack.has(value)) return `${path} 有循环引用`
  stack.add(value)
  let found
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      found = findNonJson(item, `${path}[${index}]`, stack)
      if (found !== undefined) break
    }
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      stack.delete(value)
      return `${path} 不是普通对象`
    }
    for (const [key, item] of Object.entries(value)) {
      found = findNonJson(item, `${path}.${key}`, stack)
      if (found !== undefined) break
    }
  }
  stack.delete(value)
  return found
}

function createHarness(dataDir) {
  const sections = []
  const tools = new Map()
  const titles = []
  const warnings = []
  const ctx = {
    logger: { info() {}, warn(message) { warnings.push(String(message)) } },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`重复注册工具 ${definition.name}`)
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    get(name) {
      if (name === 'sessionTitle') {
        return { rename(session, title) { titles.push({ session: session.id, title }) } }
      }
      return undefined
    },
  }
  return { dataDir, ctx, sections, tools, titles, warnings }
}

async function callTool(harness, toolName, args, sessionId = 'session-test-1', cwd) {
  const definition = harness.tools.get(toolName)
  check(`${toolName}：已注册`, definition !== undefined)
  if (definition === undefined) return undefined

  check(`${toolName}：有 description`, typeof definition.description === 'string' && definition.description.length > 30)
  // defineTool 已经把 DSL 编译成了两种 JSON Schema：parameters 是入参 schema，
  // output.schema 是出参 schema。这里直接用 harness 的校验器验，和生产路径一致。
  const argErrors = validateJsonSchemaValue(definition.parameters, args)
  check(`${toolName}：入参符合 schema`, argErrors.length === 0, argErrors.join('; '))

  const value = await definition.execute(args, {
    signal: new AbortController().signal,
    agent: { session: { id: sessionId, header: cwd === undefined ? {} : { cwd } } },
  })

  const outputErrors = validateJsonSchemaValue(definition.output.schema, value)
  check(`${toolName}：出参符合 schema`, outputErrors.length === 0, outputErrors.join('; '))
  const nonJson = findNonJson(value)
  check(`${toolName}：出参是 lossless JSON`, nonJson === undefined, nonJson)

  const blocks = definition.output.render(args, value)
  check(
    `${toolName}：render 产出文本`,
    Array.isArray(blocks) && blocks.length > 0 && typeof blocks[0]?.text === 'string' && blocks[0].text.length > 0,
  )
  if (typeof definition.presentCall === 'function' && typeof definition.presentCall(args) !== 'object') {
    check(`${toolName}：presentCall 返回对象`, false)
  }
  return value
}

// ── 开始 ────────────────────────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const plugin = await import('../plugin/mcu-registry.mjs')

section('插件模块导出')
check('导出 name', plugin.name === 'mcu-registry', String(plugin.name))
check('inject 声明 tools 与 systemPrompt', Array.isArray(plugin.inject) && plugin.inject.includes('tools') && plugin.inject.includes('systemPrompt'))
check('不导出 Config（cordis 在没有 Config 时原样透传配置）', plugin.Config === undefined, String(plugin.Config))

// 回归守卫：预设目录里没有 node_modules，插件文件**自己的** import 必须全是 node: 内置或相对路径。
// 一旦写了裸包名（如 @deepseek-ai/schemastery），整个预设挂载失败，表现就是「点新会话没反应」
// —— 这是真实踩过的坑：agent-preset-invalid: Cannot find package '@deepseek-ai/schemastery'。
section('插件文件不依赖任何外部包（否则预设无法挂载）')
for (const file of ['plugin/mcu-registry.mjs', 'plugin/project-scan.mjs']) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const fromImports = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  const bareImports = [...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((match) => match[1])
  const dynamicImports = [...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  const all = [...new Set([...fromImports, ...bareImports, ...dynamicImports])]
  const bad = all.filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.'))
  check(`${file}: 只有 node: 与相对路径（共 ${all.length} 条 import）`, bad.length === 0, bad.join(', '))
  check(
    `${file}: 相对 import 的文件都存在`,
    all.filter((specifier) => specifier.startsWith('.')).every((specifier) => existsSync(join(ROOT, file, '..', specifier))),
    all.join(', '),
  )
}

section('挂载：注册 6 个工具 + 1 段系统提示')
const harness = createHarness(TMP)
plugin.apply(harness.ctx, { dataDir: TMP })
const toolNames = [...harness.tools.keys()].sort()
check('工具数量为 6', toolNames.length === 6, toolNames.join(','))
check(
  '工具名符合预期',
  JSON.stringify(toolNames) === JSON.stringify(['mcu_bind', 'mcu_catalog_set', 'mcu_list', 'mcu_note', 'mcu_scan', 'mcu_status']),
  toolNames.join(','),
)
check('注册了 1 段系统提示', harness.sections.length === 1, String(harness.sections.length))

// 手写原始 JSON Schema 之后，注册表会做的那个断言必须在本地先过一遍
// （生产环境里 schema 不受支持会在注册时抛错 → 同样导致预设挂载失败）。
section('注册表原始 schema 断言')
for (const [toolName, definition] of harness.tools) {
  let parametersOk = true
  let outputOk = true
  try {
    assertSupportedJsonSchema(definition.parameters)
  } catch (error) {
    parametersOk = String(error.message)
  }
  try {
    assertSupportedJsonSchema(definition.output.schema)
  } catch (error) {
    outputOk = String(error.message)
  }
  check(`${toolName}: parameters 受支持`, parametersOk === true, String(parametersOk))
  check(`${toolName}: output.schema 受支持`, outputOk === true, String(outputOk))
}
const sectionDef = harness.sections[0]
check('段落名与顺序', sectionDef?.name === 'mcu:session' && sectionDef?.order === 90, `${sectionDef?.name}@${sectionDef?.order}`)
check('段落 text 是函数（惰性注入）', typeof sectionDef?.text === 'function')
check('没有产生告警', harness.warnings.length === 0, harness.warnings.join(' | '))

section('未绑定：提示段落要求先绑定，并列出预置候选型号')
const unboundText = sectionDef.text({ agent: { session: { id: 'session-unbound' } } })
check('提到「尚未绑定」', unboundText.includes('尚未绑定'))
check('要求调用 mcu_bind', unboundText.includes('mcu_bind'))
check('列出预置型号', unboundText.includes('STM32F103C8T6'), unboundText.slice(0, 200))
check('给出档案路径', unboundText.includes('REGISTRY.md'))

section('mcu_bind：绑定型号 + 写档案 + 改会话标题')
const bindValue = await callTool(harness, 'mcu_bind', {
  model: 'STM32F103C8T6',
  project: '温控板固件',
  purpose: 'PWM 驱动 MOS',
  peripherals: ['TIM3 PWM', 'USART1'],
  toolchain: 'Keil MDK5',
}, 'session-test-1')
check('返回已绑定', bindValue?.bound === true)
check('型号正确', bindValue?.model === 'STM32F103C8T6', String(bindValue?.model))
check('会话标题被改成「型号 · 功能 · 工程」', harness.titles.length === 1 && harness.titles[0].title === 'STM32F103C8T6 · PWM 驱动 MOS · 温控板固件', JSON.stringify(harness.titles))
check('标题在字节预算内（部署上限 80）', Buffer.byteLength(harness.titles[0].title, 'utf8') <= 72, String(Buffer.byteLength(harness.titles[0].title, 'utf8')))
check('档案文件已写入', existsSync(join(TMP, 'registry.json')) && existsSync(join(TMP, 'REGISTRY.md')))
const doc = readFileSync(join(TMP, 'REGISTRY.md'), 'utf8')
check('REGISTRY.md 含型号', doc.includes('STM32F103C8T6'))
check('REGISTRY.md 含工程', doc.includes('温控板固件'))
check('汇总文本回显型号', typeof bindValue?.summary === 'string' && bindValue.summary.includes('STM32F103C8T6'))

section('已绑定：提示段落注入本会话型号')
const boundText = sectionDef.text({ agent: { session: { id: 'session-test-1' } } })
check('包含型号', boundText.includes('STM32F103C8T6'))
check('包含目标功能', boundText.includes('PWM 驱动 MOS'))
check('包含外设', boundText.includes('TIM3 PWM'))
check('提醒写记录', boundText.includes('mcu_note'))
const otherSessionText = sectionDef.text({ agent: { session: { id: 'session-other' } } })
check('别的会话不受影响（仍是未绑定）', otherSessionText.includes('尚未绑定'))
check('没有 agent 也不炸', typeof sectionDef.text({}) === 'string')

section('mcu_status / mcu_note / mcu_list')
const statusValue = await callTool(harness, 'mcu_status', { history: true }, 'session-test-1')
check('status 报告已绑定', statusValue?.bound === true && statusValue?.model === 'STM32F103C8T6')
const noteValue = await callTool(harness, 'mcu_note', {
  text: 'TIM3_CH1(PA6) PWM 20kHz 驱动 MOS，ARR=999 PSC=3 @72MHz',
  kind: 'peripheral',
  tags: ['TIM3', 'PWM'],
}, 'session-test-1')
check('记录成功', noteValue?.ok === true && noteValue?.notesCount === 1, JSON.stringify(noteValue))
const listValue = await callTool(harness, 'mcu_list', { includeCatalog: true })
check('list 统计到 1 个型号', listValue?.count === 1, JSON.stringify(listValue?.count))
check('list 含预置但未用过的型号', Array.isArray(listValue?.catalogOnly) && listValue.catalogOnly.length > 0)
check('list 汇总含会话数', typeof listValue?.summary === 'string' && listValue.summary.includes('1 个对话绑定'), listValue?.summary?.slice(0, 120))

section('mcu_status：未绑定的会话给出候选')
const statusUnbound = await callTool(harness, 'mcu_status', {}, 'session-nobody')
check('bound=false', statusUnbound?.bound === false)
check('给出候选型号', Array.isArray(statusUnbound?.candidates) && statusUnbound.candidates.includes('STM32F103C8T6'))
check('提示先绑定', statusUnbound?.summary.includes('mcu_bind'))

section('mcu_note：未绑定时必须报错（让模型先绑定）')
let noteError
try {
  await harness.tools.get('mcu_note').execute({ text: '随便记点什么' }, { signal: new AbortController().signal, agent: { session: { id: 'session-nobody' } } })
} catch (error) {
  noteError = error
}
check('抛错并指向 mcu_bind', noteError !== undefined && String(noteError.message).includes('mcu_bind'), String(noteError?.message))

section('第二个会话 / 换型号：档案按型号累计')
const bindOther = await callTool(harness, 'mcu_bind', { model: 'STM32F407VET6', purpose: '跑 FreeRTOS + 以太网' }, 'session-test-2')
check('第二个会话绑定成功', bindOther?.bound === true && bindOther?.model === 'STM32F407VET6')

section('超长标题：丢尾部而不是硬切')
const longBind = await callTool(harness, 'mcu_bind', {
  model: 'STM32H750VBT6',
  purpose: '把外部 QSPI Flash 内存映射执行 + LTDC 直驱 RGB 屏 + 以太网协议栈移植',
  project: '工控网关',
}, 'session-long-title')
const longTitle = harness.titles.at(-1).title
check('标题不超过预算（72 字节）', Buffer.byteLength(longTitle, 'utf8') <= 72, `${Buffer.byteLength(longTitle, 'utf8')} 字节：${longTitle}`)
check('标题以型号开头', longTitle.startsWith('STM32H750VBT6'), longTitle)
check('超预算的目标功能被截断保留（而不是跳过它）', longTitle.includes('QSPI') && longTitle.length > 'STM32H750VBT6'.length, longTitle)
check('超预算的工程名被丢掉', !longTitle.includes('工控网关'), longTitle)
check('返回里回显标题', longBind?.sessionTitle === longTitle, `${longBind?.sessionTitle} vs ${longTitle}`)

const rebind = await callTool(harness, 'mcu_bind', { model: 'STM32H743VIT6', purpose: 'Cache/DMA 一致性实验' }, 'session-test-2')
check('同会话换型号成功', rebind?.model === 'STM32H743VIT6' && rebind?.summary.includes('换了型号'), rebind?.summary)
const listValue2 = await callTool(harness, 'mcu_list', {})
// 这一刻用过的型号有 4 个：F103、F407（session-test-2 先绑、后来换掉，档案保留）、
// H750（超长标题那次）、H743（session-test-2 当前绑定）；会话绑定数仍是 3。
check('现在有 4 个使用过的型号', listValue2?.count === 4, JSON.stringify(listValue2?.used?.map((item) => item.model)))
check('换型号后旧档案仍在', listValue2?.used?.some((item) => item.model === 'STM32F407VET6'), JSON.stringify(listValue2?.used?.map((item) => item.model)))
check('会话绑定数为 3', listValue2?.sessions === 3, String(listValue2?.sessions))

section('mcu_catalog_set：登记/补全型号库')
const catalogValue = await callTool(harness, 'mcu_catalog_set', {
  model: 'STM32F429IGT6',
  vendor: 'ST',
  family: 'STM32F4',
  core: 'Cortex-M4F',
  clockMhz: 180,
  flashKb: 1024,
  ramKb: 256,
  packageName: 'LQFP176',
  features: ['SDRAM/FMC', 'LTDC', 'ETH', 'USB-OTG HS'],
  notes: '带 LTDC 适合直驱 RGB 屏',
})
check('登记成功', catalogValue?.ok === true && catalogValue?.entry?.clockMhz === 180, JSON.stringify(catalogValue?.entry))
let catalogError
try {
  await harness.tools.get('mcu_catalog_set').execute({ model: 'X' }, { signal: new AbortController().signal, agent: { session: { id: 'session-test-1' } } })
} catch (error) {
  catalogError = error
}
check('空规格被拒绝', catalogError !== undefined && String(catalogError.message).includes('规格字段'), String(catalogError?.message))

section('档案可被手工编辑：形状不对也能安全读出')
const handEdited = {
  version: 1,
  catalog: { stm32f103c8t6: { model: 'STM32F103C8T6', vendor: 'ST', features: 'not-an-array', clockMhz: 'fast' } },
  mcus: { stm32f103c8t6: { model: 'STM32F103C8T6', notes: [{ kind: 'unknown-kind', text: '手工加的一条' }, 'garbage'] } },
  sessions: { 'session-hand': { mcuId: 'stm32f103c8t6', model: 'STM32F103C8T6', peripherals: ['UART1', 42] } },
  log: [{ kind: 'weird', text: 'x' }, 7],
}
writeFileSync(join(TMP, 'registry.json'), JSON.stringify(handEdited, null, 2))
const handStatus = await callTool(harness, 'mcu_status', {}, 'session-hand')
check('手工档案被读出', handStatus?.bound === true && handStatus?.model === 'STM32F103C8T6', JSON.stringify(handStatus?.model))
check('坏字段被清理（notes 只剩合法项）', handStatus?.notes?.length === 1 && handStatus.notes[0].kind === 'other', JSON.stringify(handStatus?.notes))
check('坏外设被过滤', JSON.stringify(handStatus?.peripherals) === JSON.stringify(['UART1']), JSON.stringify(handStatus?.peripherals))
const handSection = sectionDef.text({ agent: { session: { id: 'session-hand' } } })
check('提示段落对畸形档案也不抛', handSection.includes('STM32F103C8T6'))

section('档案损坏：保留现场并从空档案继续')
writeFileSync(join(TMP, 'registry.json'), '{ this is not json ')
const corruptHarness = createHarness(TMP)
plugin.apply(corruptHarness.ctx, { dataDir: TMP })
const corrupted = readdirSync(TMP).filter((name) => name.startsWith('registry.json.corrupt-'))
check('损坏文件被改名保留', corrupted.length >= 1, readdirSync(TMP).join(','))
check('记录了告警', corruptHarness.warnings.some((line) => line.includes('无法解析')), corruptHarness.warnings.join(' | '))
const recovered = await callTool(corruptHarness, 'mcu_status', {}, 'session-test-1')
check('损坏后是干净状态（未绑定）', recovered?.bound === false)

section('配置开关生效')
const noTitleHarness = createHarness(join(TMP, 'no-title'))
plugin.apply(noTitleHarness.ctx, { dataDir: join(TMP, 'no-title'), renameSessionTitle: false, promptSection: false })
check('promptSection=false 时不注册段落', noTitleHarness.sections.length === 0)
await callTool(noTitleHarness, 'mcu_bind', { model: 'STM32F103C8T6' }, 'session-x')
check('renameSessionTitle=false 时不改标题', noTitleHarness.titles.length === 0)

section('组合文件 agent.cordis.yml 结构')
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => String(data),
})
const composition = yaml.load(readFileSync(join(ROOT, 'agent.cordis.yml'), 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([jsTag]) })
check('是顶层数组（Cordis 行列表）', Array.isArray(composition), typeof composition)
const flat = []
const walk = (rows) => {
  for (const row of rows) {
    flat.push(row)
    if (Array.isArray(row?.config)) walk(row.config)
  }
}
walk(composition)
check('每行都有 name（或 group 标记）', flat.every((row) => typeof row?.name === 'string' || row?.group === true))
check('每行都有唯一 id', flat.every((row) => typeof row?.id === 'string' && row.id !== '') && new Set(flat.map((row) => row.id)).size === flat.length)
const byId = new Map(flat.map((row) => [row.id, row]))
for (const requiredId of [
  'persona',
  'agent-instructions',
  'tool-pwsh',
  'tool-bash',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'skill-filesystem',
  'tool-skill',
  'mcu-registry',
  'tool-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-workflow',
  'tool-ralph',
  'tool-ask-user',
  'tool-todo',
  'tool-web',
]) {
  check(`组合里有 ${requiredId}`, byId.has(requiredId))
}
const mcuRow = byId.get('mcu-registry')
check('mcu 行用相对路径引用自带插件', mcuRow?.name === './plugin/mcu-registry.mjs', String(mcuRow?.name))
check('插件文件确实存在', existsSync(join(ROOT, mcuRow.name)), mcuRow?.name)
check('mcu 行带配置', mcuRow?.config?.renameSessionTitle === true && mcuRow?.config?.promptSectionOrder === 90)
const skillRow = byId.get('skill-filesystem')
check(
  'skill-filesystem 指向预设自带 skills 目录',
  Array.isArray(skillRow?.config?.customSkillDirs) && skillRow.config.customSkillDirs.length === 1 && String(skillRow.config.customSkillDirs[0]).includes('skills/'),
  JSON.stringify(skillRow?.config?.customSkillDirs),
)
check('persona 含型号纪律', String(byId.get('persona')?.config?.text ?? '').includes('mcu_status'))
check('persona 保留 {{model}}/{{cwd}} 变量', String(byId.get('persona')?.config?.text ?? '').includes('{{model}}') && String(byId.get('persona')?.config?.text ?? '').includes('{{cwd}}'))

section('preset.yml 显示信息')
const presetMeta = yaml.load(readFileSync(join(ROOT, 'preset.yml'), 'utf8'))
check('有中文模式名', typeof presetMeta?.name === 'string' && presetMeta.name.includes('单片机'), String(presetMeta?.name))
check('有描述', typeof presetMeta?.description === 'string' && presetMeta.description.length > 20)
check('有排序 order', typeof presetMeta?.order === 'number')

section('skills 目录')
const skillsDir = join(ROOT, 'skills')
const skillNames = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
check('至少 3 个 starter skill', skillNames.length >= 3, skillNames.join(','))
for (const dirName of skillNames) {
  const file = join(skillsDir, dirName, 'SKILL.md')
  check(`${dirName}: 有 SKILL.md`, existsSync(file))
  if (!existsSync(file)) continue
  const raw = readFileSync(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)
  check(`${dirName}: frontmatter 完整`, match !== null)
  if (match === null) continue
  const front = yaml.load(match[1])
  check(`${dirName}: name 是 kebab-case`, typeof front?.name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(front.name), String(front?.name))
  check(`${dirName}: name 与目录一致`, front?.name === dirName, `${front?.name} vs ${dirName}`)
  check(`${dirName}: description 够具体`, typeof front?.description === 'string' && front.description.length > 40, String(front?.description?.length))
  check(`${dirName}: 正文非空`, raw.length - match[0].length > 200, String(raw.length))
}

section('catalog.seed.json')
const seed = JSON.parse(readFileSync(join(ROOT, 'catalog.seed.json'), 'utf8'))
const seedEntries = Array.isArray(seed) ? seed : seed.catalog
check('是数组/带 catalog 数组', Array.isArray(seedEntries))
check('每条都有 model', seedEntries.every((entry) => typeof entry?.model === 'string' && entry.model.trim() !== ''))
check(
  '型号不重复',
  new Set(seedEntries.map((entry) => plugin.internals.slugOf(entry.model))).size === seedEntries.length,
)
check('覆盖 STM32（用户主用）', seedEntries.filter((entry) => entry.model.startsWith('STM32')).length >= 4)
check('slugOf 稳定', plugin.internals.slugOf('STM32F103C8T6') === 'stm32f103c8t6')
check('truncateBytes 不切坏多字节字符', plugin.internals.truncateBytes('中文标题abcd', 7) === '中文')

// ── 工程扫描器 ──────────────────────────────────────────────────────────────

section('工程扫描器：构造一个 Keil + SPL 假工程')
const scanner = await import('../plugin/project-scan.mjs')
const fixture = join(TMP, 'fixture-project')
mkdirSync(join(fixture, 'MDK-ARM'), { recursive: true })
mkdirSync(join(fixture, 'USER'), { recursive: true })
mkdirSync(join(fixture, 'HARDWARE', 'LED'), { recursive: true })
mkdirSync(join(fixture, 'FWLIB', 'inc'), { recursive: true })
writeFileSync(
  join(fixture, 'MDK-ARM', 'board.uvprojx'),
  `<?xml version="1.0"?><Project><Targets><Target><TargetName>board</TargetName><TargetOption><TargetArmAds><Cads><VariousControls><Define>USE_STDPERIPH_DRIVER,STM32F103xB</Define></VariousControls></Cads><ArmAdsMisc/></TargetArmAds><Device>STM32F103C8</Device><Vendor>STMicroelectronics</Vendor><Cpu>IRAM(0x20000000,0x00005000) IROM(0x8000000,0x00010000) CPUTYPE("Cortex-M3") CLOCK(8000000)</Cpu></TargetOption></Target></Targets></Project>`,
)
writeFileSync(join(fixture, 'USER', 'stm32f1xx_conf.h'), '#define USE_STDPERIPH_DRIVER\n')
writeFileSync(
  join(fixture, 'USER', 'main.c'),
  `/*
 * MCU   : STM32F103C8T6（标准外设库，Keil MDK）
 * 工具链 : Keil MDK5
 * LED=PC13  KEY=PA0
 */
#include "stm32f1xx.h"
RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1 | RCC_APB2Periph_GPIOA, ENABLE);
RCC_PLLConfig(RCC_PLLSource_HSE, 8, 336, 2);
USART_Init(USART1, &USART_InitStructure);
TIM3_Init(1000);
void USART1_IRQHandler(void) { }
void PPP_IRQHandler(void) { }
`,
)
writeFileSync(join(fixture, 'HARDWARE', 'LED', 'led.h'), '#define LED0 PCout(13)\n#define KEY0 PAin(0)\n#define SCK PB13\n')
// 库与 CMSIS 样板里的外设不能污染结论（它们按系列列了所有外设）
writeFileSync(join(fixture, 'FWLIB', 'inc', 'stm32f1xx_usart.h'), 'USART2 USART3 TIM9 TIM10 ADC2 SDIO FMC RNG LTDC DCMI\n')
writeFileSync(join(fixture, 'USER', 'system_stm32f1xx.c'), '/* FMC SDIO RNG LTDC DCMI ETH */\n')

const scan = scanner.scanProject(fixture)
check('识别出型号（取更具体的完整订货号）', scan.inferred.model === 'STM32F103C8T6', String(scan.inferred.model))
check('候选里同时保留 Keil Device 的 STM32F103C8', scan.inferred.modelCandidates.includes('STM32F103C8'), JSON.stringify(scan.inferred.modelCandidates))
check('厂商/内核正确', scan.inferred.vendor === 'ST' && scan.inferred.core === 'Cortex-M3', `${scan.inferred.vendor}/${scan.inferred.core}`)
check('工具链是 Keil MDK', String(scan.inferred.toolchain).includes('Keil MDK'), String(scan.inferred.toolchain))
check('固件库是 SPL', scan.inferred.library === 'SPL', String(scan.inferred.library))
check('外设来自用户代码', scan.inferred.peripherals.includes('USART1') && scan.inferred.peripherals.includes('TIM3'), JSON.stringify(scan.inferred.peripherals))
check('库里的外设没有污染结论', !scan.inferred.peripherals.some((item) => ['USART2', 'USART3', 'TIM9', 'SDIO', 'FMC', 'RNG', 'LTDC'].includes(item)), JSON.stringify(scan.inferred.peripherals))
check('PPP_IRQHandler 占位符被过滤', !scan.inferred.peripherals.some((item) => item.includes('PPP')), JSON.stringify(scan.inferred.peripherals))
check('引脚从位带宏/宏定义/注释三种写法都提取到', ['PC13', 'PA0', 'PB13'].every((pin) => scan.inferred.pins.includes(pin)), JSON.stringify(scan.inferred.pins))
check('时钟证据含 Keil CLOCK 与标准库 PLL', scan.inferred.clock.some((item) => item.includes('CLOCK=8000000')) && scan.inferred.clock.some((item) => item.includes('RCC_PLLConfig')), JSON.stringify(scan.inferred.clock))
check('存储证据含 IROM 64KB', scan.inferred.memory.some((item) => item.includes('IROM 64KB')), JSON.stringify(scan.inferred.memory))
check('置信度 high', scan.confidence === 'high', scan.confidence)
check('每条证据都能指到文件', scan.evidence.length > 0 && scan.evidence.every((item) => typeof item.file === 'string' && item.file !== '' && typeof item.value === 'string'))
check('证据文件是相对路径', scan.evidence.every((item) => !item.file.includes(':')), scan.evidence[0]?.file)
const scanText = scanner.renderScanReport(scan)
check('报告里有依据表', scanText.includes('依据（文件 → 关键值）') && scanText.includes('board.uvprojx'), scanText.slice(0, 120))
check('空目录不报错、置信度低', scanner.scanProject(join(TMP, 'no-title')).confidence === 'low')

section('mcu_scan：扫到明确型号就自动绑定')
const scanHarness = createHarness(join(TMP, 'scan-data'))
plugin.apply(scanHarness.ctx, { dataDir: join(TMP, 'scan-data') })
const scanValue = await callTool(scanHarness, 'mcu_scan', { path: fixture, purpose: 'TFT 屏驱动' }, 'session-scan-1')
check('mcu_scan 成功', scanValue?.ok === true && scanValue?.model === 'STM32F103C8T6', JSON.stringify(scanValue?.model))
check('自动绑定本会话', scanValue?.bound === true && scanValue?.boundModel === 'STM32F103C8T6', JSON.stringify(scanValue))
check('自动改了会话标题', typeof scanValue?.sessionTitle === 'string' && scanValue.sessionTitle.startsWith('STM32F103C8T6'), String(scanValue?.sessionTitle))
check('返回里带证据表', String(scanValue?.report).includes('USER\\main.c') || String(scanValue?.report).includes('USER/main.c'), String(scanValue?.report).slice(0, 200))
check('summary 提示把证据表给用户看', String(scanValue?.summary).includes('证据表'), String(scanValue?.summary))
const scanStatus = await callTool(scanHarness, 'mcu_status', {}, 'session-scan-1')
check('绑定里记下了判定依据', Array.isArray(scanStatus?.record?.evidence) && scanStatus.record.evidence.length > 0, JSON.stringify(scanStatus?.record?.evidence))
const scanDoc = readFileSync(join(TMP, 'scan-data', 'REGISTRY.md'), 'utf8')
check('REGISTRY.md 里带判定依据', scanDoc.includes('判定依据'), scanDoc.slice(0, 200))

section('mcu_scan：用扫描旁证补全型号库字段')
// ① 型号库里没有的型号：厂商/系列/内核/容量应来自扫描（Keil <Cpu> 的 CPUTYPE/IROM/IRAM）
const g0 = join(TMP, 'fixture-g0')
mkdirSync(join(g0, 'MDK-ARM'), { recursive: true })
writeFileSync(
  join(g0, 'MDK-ARM', 'g0.uvprojx'),
  '<Project><Device>STM32G030C8T6</Device><Cpu>IRAM(0x20000000,0x00002000) IROM(0x8000000,0x00010000) CPUTYPE("Cortex-M0+")</Cpu></Project>',
)
const g0Harness = createHarness(join(TMP, 'g0-data'))
plugin.apply(g0Harness.ctx, { dataDir: join(TMP, 'g0-data') })
const g0Scan = await callTool(g0Harness, 'mcu_scan', { path: g0 }, 'session-g0')
check('绑定到新型号', g0Scan?.bound === true && g0Scan?.model === 'STM32G030C8T6', JSON.stringify(g0Scan?.model))
const g0Store = JSON.parse(readFileSync(join(TMP, 'g0-data', 'registry.json'), 'utf8'))
const g0Entry = g0Store.catalog?.['stm32g030c8t6']
check('型号库补上了厂商/系列/内核', g0Entry?.vendor === 'ST' && g0Entry?.family === 'STM32G0' && g0Entry?.core === 'Cortex-M0+', JSON.stringify(g0Entry))
check('型号库补上了 Flash/RAM（来自 IROM/IRAM）', g0Entry?.flashKb === 64 && g0Entry?.ramKb === 8, JSON.stringify({ flash: g0Entry?.flashKb, ram: g0Entry?.ramKb }))
const g0Doc = readFileSync(join(TMP, 'g0-data', 'REGISTRY.md'), 'utf8')
check('REGISTRY.md 不再是空规格', g0Doc.includes('STM32G0') && g0Doc.includes('64KB / 8KB'), g0Doc.slice(0, 400))

// ② 工程写 Keil 通配型号（F407VETx），型号库里有 STM32F407VET6：应认出来并沿用库里规格
const wild = join(TMP, 'fixture-wild')
mkdirSync(join(wild, 'MDK-ARM'), { recursive: true })
writeFileSync(join(wild, 'MDK-ARM', 'wild.uvprojx'), '<Project><Device>STM32F407VETx</Device><Cpu>IRAM(0x20000000,0x00030000) IROM(0x8000000,0x00080000) CPUTYPE("Cortex-M4")</Cpu></Project>')
const wildHarness = createHarness(join(TMP, 'wild-data'))
plugin.apply(wildHarness.ctx, { dataDir: join(TMP, 'wild-data') })
const wildScan = await callTool(wildHarness, 'mcu_scan', { path: wild }, 'session-wild')
check('通配型号也能自动绑定', wildScan?.bound === true, JSON.stringify(wildScan?.model))
check('识别出与型号库同一颗并说明', String(wildScan?.summary).includes('STM32F407VET6'), String(wildScan?.summary))
const wildStatus = await callTool(wildHarness, 'mcu_status', {}, 'session-wild')
check('沿用了库里的片上资源', Array.isArray(wildStatus?.spec?.features) && wildStatus.spec.features.length > 3, JSON.stringify(wildStatus?.spec?.features))
check('依据里说明了通配后缀', JSON.stringify(wildStatus?.record?.evidence ?? []).includes('型号库匹配'), JSON.stringify(wildStatus?.record?.evidence))

section('mcu_scan：与现有绑定不一致时只报告不切换')
const mismatchHarness = createHarness(join(TMP, 'mismatch-data'))
plugin.apply(mismatchHarness.ctx, { dataDir: join(TMP, 'mismatch-data') })
await callTool(mismatchHarness, 'mcu_bind', { model: 'STM32H743VIT6', purpose: '别的板子' }, 'session-mismatch')
const mismatchValue = await callTool(mismatchHarness, 'mcu_scan', { path: fixture }, 'session-mismatch')
check('报告不一致', mismatchValue?.mismatch === true, JSON.stringify(mismatchValue?.mismatch))
check('没有偷偷改绑定', mismatchValue?.bound === false && mismatchValue?.boundModel === 'STM32H743VIT6', JSON.stringify(mismatchValue?.boundModel))
check('提示先跟用户确认', String(mismatchValue?.summary).includes('不一致') && String(mismatchValue?.summary).includes('确认'), String(mismatchValue?.summary))

section('未绑定会话：系统提示里内联工作区探测结果')
const probeHarness = createHarness(join(TMP, 'probe-data'))
plugin.apply(probeHarness.ctx, { dataDir: join(TMP, 'probe-data') })
const probeText = probeHarness.sections[0].text({ agent: { session: { id: 'session-probe', header: { cwd: fixture } } } })
check('提示里出现工作区探测段', probeText.includes('工作区探测'), probeText.slice(0, 160))
check('探测到型号', probeText.includes('STM32F103C8T6'), probeText.slice(0, 400))
check('提示第一步调用 mcu_scan', probeText.includes('mcu_scan'))
const emptyProbeText = probeHarness.sections[0].text({ agent: { session: { id: 'session-probe2', header: { cwd: join(TMP, 'no-title') } } } })
check('空目录时提示把工程目录传给 path', emptyProbeText.includes('path'), emptyProbeText.slice(0, 300))

section('mcu_scan：路径不存在时报错而不是瞎猜')
let scanPathError
try {
  await probeHarness.tools.get('mcu_scan').execute({ path: join(TMP, 'not-exist-dir') }, { signal: new AbortController().signal, agent: { session: { id: 'x', header: {} } } })
} catch (error) {
  scanPathError = error
}
check('不存在的工程目录抛错', scanPathError !== undefined && String(scanPathError.message).includes('不存在'), String(scanPathError?.message))

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '全部通过' : '有失败项'}：${checks - failures}/${checks}`)
process.exitCode = failures === 0 ? 0 : 1
