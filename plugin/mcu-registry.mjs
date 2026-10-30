/**
 * 单片机模式（DSH 用户预设 `mcu`）自带插件：型号登记 + 使用档案 + 会话级型号注入。
 *
 * 它解决三件事：
 *   1. 记录「我用的单片机型号」——型号库（规格）+ 使用档案（会话/工程/功能/踩坑）。
 *   2. 让**每个对话**都知道自己用的是哪颗单片机——把当前会话的绑定注入系统提示，
 *      并在绑定时把会话标题改成「型号 · 功能」，在对话列表里一眼可见。
 *   3. 给 Agent 一组工具去读写这份档案：mcu_scan / mcu_bind / mcu_status / mcu_note / mcu_list / mcu_catalog_set。
 *
 * `mcu_scan` 是这套东西的入口：它用确定性扫描器（plugin/project-scan.mjs）从工程文件里挖出
 * 型号/工具链/库类型/外设/引脚/时钟，逐条附上「哪个文件给出了这个值」；型号明确时**自动绑定**
 * （不依赖模型自觉），并把证据写进使用档案。未绑定的会话里，系统提示还会内联一次廉价探测结果。
 *
 * 存放位置（默认）：$DSH_HOME/mcu/registry.json（机器可读）+ REGISTRY.md（人读汇总）。
 * 首次运行时用预设目录里的 catalog.seed.json 初始化型号库。
 *
 * 为什么不用会话事件记录绑定：会话日志拒绝本 harness 不认识的事件类型
 * （dsh-session-persistence 的 assertEventsSupported），自定义 `mcu/bind` 事件会让
 * 日志无法重建。所以绑定状态存在本插件自己的档案里，以 session id 为键。
 *
 * 本文件是「用户预设」的自带插件：组合里用相对路径 './plugin/mcu-registry.mjs' 引用。
 * 用 .mjs 是为了保证 ESM 语义（预设目录下没有 package.json，.js 会被 Node 当成 CommonJS）。
 *
 * ⚠️ 这里刻意**不 import 任何外部包**（连 @deepseek-ai/dsh-tools 都不用）：
 * 组合文件里只有「行的 name」按 harness 安装目录解析，而插件文件**自己的** import 由 Node
 * 按文件位置正常解析——预设目录上方没有 node_modules，所以 `import '@deepseek-ai/schemastery'`
 * 会让整个预设挂载失败（agent-preset-invalid: Cannot find package …），表现就是
 * 「点新会话没反应」。因此：
 *   - 参数/出参 schema 直接手写**原始 JSON Schema**（注册表本身会校验出参）；
 *   - 入参校验由本文件的 validateRaw() 负责（原始注册不替工具校验参数）；
 *   - 不导出 Config：cordis 的 resolveConfig 在没有 Config 时原样透传配置。
 */

import { existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelMatches, renderScanReport, scanProject } from './project-scan.mjs'

export const name = 'mcu-registry'
export const inject = ['tools', 'systemPrompt']

/**
 * 配置项（组合文件 `agent.cordis.yml` 里 mcu-registry 那一行的 config；默认值见下方 DEFAULTS）：
 * dataDir / renameSessionTitle / promptSection / promptSectionOrder / seedCatalog /
 * historyLimit / recentNotes / titleMaxBytes / autoBindOnScan / probeInSection / probeCacheSeconds
 */

/** 预设目录（本文件在 <预设>/plugin/ 下）。 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const SEED_CATALOG_FILE = join(PLUGIN_DIR, 'catalog.seed.json')

const STORE_VERSION = 1
const NOTE_KINDS = ['bind', 'feature', 'peripheral', 'driver', 'protocol', 'pitfall', 'debug', 'build', 'other']
const KIND_LABEL = {
  bind: '绑定',
  feature: '功能',
  peripheral: '外设',
  driver: '驱动',
  protocol: '协议',
  pitfall: '踩坑',
  debug: '调试',
  build: '构建',
  other: '其他',
}
const DEFAULTS = {
  dataDir: undefined,
  renameSessionTitle: true,
  promptSection: true,
  promptSectionOrder: 90,
  seedCatalog: true,
  historyLimit: 400,
  recentNotes: 3,
  titleMaxBytes: 72,
  autoBindOnScan: true,
  probeInSection: true,
  probeCacheSeconds: 30,
}
/** 型号规格字段：bind / catalog_set 的入参、型号库的存储键共用一份定义。 */
const SPEC_FIELDS = ['vendor', 'family', 'core', 'clockMhz', 'flashKb', 'ramKb', 'packageName', 'voltage', 'board', 'toolchain', 'features', 'notes']
const SPEC_PROPERTIES = {
  vendor: { type: 'string', description: '厂商，如 ST / 意法半导体 / 兆易创新' },
  family: { type: 'string', description: '系列，如 STM32F1 / STM32F4 / STM32H7' },
  core: { type: 'string', description: '内核，如 Cortex-M3 / M4F / M7' },
  clockMhz: { type: 'number', description: '最高主频（MHz）' },
  flashKb: { type: 'number', description: 'Flash 容量（KB）' },
  ramKb: { type: 'number', description: 'SRAM 容量（KB）' },
  packageName: { type: 'string', description: '封装，如 LQFP48 / LQFP100 / UFQFPN48' },
  voltage: { type: 'string', description: '供电范围，如 2.0-3.6V' },
  board: { type: 'string', description: '开发板或自制板，如 Blue Pill / 自制温控板' },
  toolchain: { type: 'string', description: '工具链，如 Keil MDK5 / STM32CubeIDE + GCC' },
  features: { type: 'array', items: { type: 'string' }, description: '片上资源/功能，如 ["USART1-3","TIM3 PWM","CAN"]' },
  notes: { type: 'string', description: '备注：注意事项、踩坑、手册要点' },
}
/**
 * 出参 schema 说明：value schema DSL 里**不能**写 `required`（只有入参 parameters 支持），
 * 所以下面这些对象只声明类型与 additionalProperties；渲染函数与出参形状由本文件自己保证。
 */
const LOOSE_RECORD = { type: 'object', additionalProperties: true }
const NOTE_ITEM = {
  type: 'object',
  additionalProperties: true,
  properties: {
    at: { type: 'string' },
    kind: { type: 'string' },
    text: { type: 'string' },
  },
}
const PATHS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dataDir: { type: 'string' },
    jsonFile: { type: 'string' },
    docFile: { type: 'string' },
  },
}
const STRING_LIST = { type: 'array', items: { type: 'string' } }

// ── 小工具 ──────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString()
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function slugOf(model) {
  const slug = String(model ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'mcu' : slug
}

function resolveDataDir(configured) {
  const raw = text(configured)
  if (raw === '') {
    const home = text(process.env.DSH_HOME)
    return join(home === '' ? join(homedir(), '.dsh') : resolve(home), 'mcu')
  }
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') || raw.startsWith('~\\') ? join(homedir(), raw.slice(2)) : raw
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

function truncateBytes(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return value
  let end = Math.max(0, maxBytes)
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

function uniquePush(list, value) {
  const item = text(value)
  if (item === '' || list.includes(item)) return
  list.push(item)
}

function emptyStore() {
  return { version: STORE_VERSION, updatedAt: null, catalog: {}, mcus: {}, sessions: {}, log: [] }
}

function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.(message)
  } catch {
    /* 日志失败不影响功能 */
  }
}

// ── 档案读写 ────────────────────────────────────────────────────────────────

function createState(config) {
  const dataDir = resolveDataDir(config.dataDir)
  const state = {
    config,
    dataDir,
    jsonFile: join(dataDir, 'registry.json'),
    docFile: join(dataDir, 'REGISTRY.md'),
    store: emptyStore(),
    stamp: null,
    corrupted: false,
    writeChain: Promise.resolve(),
  }
  reload(state)
  return state
}

function readJsonFile(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function stampOf(file) {
  try {
    const info = statSync(file)
    return `${info.size}:${info.mtimeMs}`
  } catch {
    return null
  }
}

function normalizeStore(parsed) {
  const store = emptyStore()
  if (!isRecord(parsed)) return store
  if (isRecord(parsed.catalog)) {
    for (const [key, entry] of Object.entries(parsed.catalog)) {
      if (!isRecord(entry)) continue
      const model = text(entry.model) || key
      const id = text(entry.id) || slugOf(model)
      const clean = { ...entry, id, model }
      for (const field of ['vendor', 'family', 'core', 'packageName', 'voltage', 'board', 'toolchain', 'notes', 'source']) {
        if (clean[field] === undefined || clean[field] === null) delete clean[field]
        else clean[field] = text(clean[field])
      }
      for (const field of ['clockMhz', 'flashKb', 'ramKb']) {
        if (typeof clean[field] !== 'number' || !Number.isFinite(clean[field])) delete clean[field]
      }
      clean.features = Array.isArray(clean.features) ? clean.features.filter((item) => typeof item === 'string' && item.trim() !== '') : undefined
      if (clean.features === undefined) delete clean.features
      else if (clean.features.length === 0) delete clean.features
      store.catalog[id] = clean
    }
  }
  if (isRecord(parsed.mcus)) {
    for (const [key, record] of Object.entries(parsed.mcus)) {
      if (!isRecord(record)) continue
      store.mcus[key] = sanitizeRecord(record, key)
    }
  }
  if (isRecord(parsed.sessions)) {
    for (const [key, binding] of Object.entries(parsed.sessions)) {
      if (!isRecord(binding)) continue
      store.sessions[key] = sanitizeBinding(binding, key)
    }
  }
  if (Array.isArray(parsed.log)) {
    store.log = parsed.log.filter(isRecord).map((entry) => ({
      at: text(entry.at) || nowIso(),
      session: text(entry.session),
      mcuId: text(entry.mcuId),
      model: text(entry.model),
      kind: KIND_LABEL[entry.kind] ? entry.kind : 'other',
      text: text(entry.text),
      tags: Array.isArray(entry.tags) ? entry.tags.filter((item) => typeof item === 'string') : [],
    }))
  }
  store.updatedAt = text(parsed.updatedAt) || null
  return store
}

/** 手改过或旧版本的记录也要能被安全读出：输出 schema 依赖这里补齐字段。 */
function sanitizeRecord(record, fallbackId) {
  const id = text(record.id) || fallbackId
  const out = { ...record }
  out.id = id
  out.model = text(out.model) || id
  for (const key of ['sessions', 'projects', 'functions', 'peripherals', 'evidence']) {
    out[key] = Array.isArray(out[key]) ? out[key].filter((item) => typeof item === 'string' && item.trim() !== '') : []
  }
  out.notes = (Array.isArray(out.notes) ? out.notes : []).filter(isRecord).map((note) => ({
    at: text(note.at) || nowIso(),
    session: text(note.session),
    kind: KIND_LABEL[note.kind] ? note.kind : 'other',
    text: text(note.text),
    tags: Array.isArray(note.tags) ? note.tags.filter((item) => typeof item === 'string') : [],
  }))
  out.sessionCount = out.sessions.length
  out.firstUsedAt = text(out.firstUsedAt) || null
  out.lastUsedAt = text(out.lastUsedAt) || null
  return out
}

function sanitizeBinding(binding, fallbackId) {
  return {
    sessionId: text(binding.sessionId) || fallbackId,
    mcuId: text(binding.mcuId),
    model: text(binding.model) || text(binding.mcuId),
    project: text(binding.project),
    purpose: text(binding.purpose),
    peripherals: Array.isArray(binding.peripherals) ? binding.peripherals.filter((item) => typeof item === 'string') : [],
    toolchain: text(binding.toolchain),
    evidence: Array.isArray(binding.evidence) ? binding.evidence.filter((item) => typeof item === 'string') : [],
    boundAt: text(binding.boundAt) || nowIso(),
    updatedAt: text(binding.updatedAt) || nowIso(),
  }
}

function reload(state) {
  const parsed = readJsonFile(state.jsonFile)
  if (parsed === null) {
    // 档案损坏：保留现场（改名），从空档案继续，并在日志里说明。
    try {
      renameSync(state.jsonFile, `${state.jsonFile}.corrupt-${Date.now()}`)
    } catch {
      /* 改名失败也要继续 */
    }
    state.store = emptyStore()
    state.stamp = null
    state.corrupted = true
  } else {
    state.store = parsed === undefined ? emptyStore() : normalizeStore(parsed)
    state.stamp = stampOf(state.jsonFile)
    state.corrupted = false
  }
  seedCatalog(state)
}

/** 型号库为空时用预设自带的种子文件初始化（只影响内存，落盘发生在第一次写入时）。 */
function seedCatalog(state) {
  if (state.config.seedCatalog === false) return
  if (Object.keys(state.store.catalog).length > 0) return
  const parsed = readJsonFile(SEED_CATALOG_FILE)
  if (parsed === undefined || parsed === null) return
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.catalog) ? parsed.catalog : []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const model = text(entry.model)
    if (model === '') continue
    const id = slugOf(model)
    state.store.catalog[id] = { ...entry, id, model, source: text(entry.source) || '预设型号库', updatedAt: nowIso() }
  }
}

/** 档案文件被外部改过（手改 JSON、另一个 DSH 实例写入）就重新读一遍。 */
function ensureFresh(state) {
  const stamp = stampOf(state.jsonFile)
  if (stamp === null) {
    if (state.stamp !== null) {
      state.store = emptyStore()
      state.stamp = null
      seedCatalog(state)
    }
    return
  }
  if (stamp !== state.stamp) reload(state)
}

async function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/** 串行落盘：JSON 档案 + 人读的 REGISTRY.md。 */
function persist(state) {
  const run = () => persistNow(state)
  state.writeChain = state.writeChain.then(run, run)
  return state.writeChain
}

async function persistNow(state) {
  await mkdir(state.dataDir, { recursive: true })
  state.store.version = STORE_VERSION
  state.store.updatedAt = nowIso()
  await writeFileAtomic(state.jsonFile, `${JSON.stringify(state.store, null, 2)}\n`)
  await writeFileAtomic(state.docFile, renderDoc(state))
  state.stamp = stampOf(state.jsonFile)
}

function pathsOf(state) {
  return { dataDir: state.dataDir, jsonFile: state.jsonFile, docFile: state.docFile }
}

// ── 领域操作 ────────────────────────────────────────────────────────────────

function mcuRecord(state, id) {
  const existing = state.store.mcus[id]
  if (isRecord(existing)) {
    ensureArrays(existing)
    return existing
  }
  const record = {
    id,
    model: id,
    firstUsedAt: null,
    lastUsedAt: null,
    sessionCount: 0,
    sessions: [],
    projects: [],
    functions: [],
    peripherals: [],
    evidence: [],
    notes: [],
  }
  state.store.mcus[id] = record
  return record
}

function ensureArrays(record) {
  for (const key of ['sessions', 'projects', 'functions', 'peripherals', 'notes']) {
    if (!Array.isArray(record[key])) record[key] = []
  }
  if (typeof record.sessionCount !== 'number' || !Number.isFinite(record.sessionCount)) {
    record.sessionCount = record.sessions.length
  }
}

function pushLog(state, entry) {
  state.store.log.push(entry)
  const limit = Math.max(50, Math.trunc(Number(state.config.historyLimit) || 400))
  if (state.store.log.length > limit) state.store.log.splice(0, state.store.log.length - limit)
}

function specPatchOf(input) {
  const patch = {}
  for (const key of SPEC_FIELDS) {
    const value = input[key]
    if (key === 'features') {
      if (Array.isArray(value) && value.length > 0) {
        const features = value.map((item) => text(item)).filter((item) => item !== '')
        if (features.length > 0) patch.features = features
      }
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) patch[key] = value
    else if (text(value) !== '') patch[key] = text(value)
  }
  return patch
}

function bindSession(state, input) {
  const at = nowIso()
  const model = text(input.model)
  // 会话绑定是"这个对话用哪颗"的唯一依据：没有 session id 就写进去会污染档案
  // （JSON 会把 undefined 键变成字符串 "undefined"），所以这里直接拒绝。
  if (text(input.sessionId) === '') throw new Error('bindSession 需要 sessionId（调用方忘了传会话 id）')
  const id = slugOf(model)

  // 型号库：绑定即登记（字段缺就用已有值，不覆盖用户填过的规格）。
  const previousCatalog = isRecord(state.store.catalog[id]) ? state.store.catalog[id] : undefined
  const catalog = { ...(previousCatalog ?? {}), ...specPatchOf(input), id, model, updatedAt: at }
  if (text(previousCatalog?.source) === '') catalog.source = '对话绑定'
  state.store.catalog[id] = catalog

  // 使用档案
  const record = mcuRecord(state, id)
  record.model = model
  record.firstUsedAt = record.firstUsedAt ?? at
  record.lastUsedAt = at
  if (text(input.sessionId) !== '') {
    uniquePush(record.sessions, input.sessionId)
    record.sessionCount = record.sessions.length
  }
  uniquePush(record.projects, input.project)
  uniquePush(record.functions, input.purpose)
  for (const item of Array.isArray(input.peripherals) ? input.peripherals : []) uniquePush(record.peripherals, item)
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).map((item) => text(item)).filter((item) => item !== '')
  for (const item of evidence) uniquePush(record.evidence, item)
  if (record.evidence.length > 30) record.evidence.splice(0, record.evidence.length - 30)

  // 会话绑定
  const previous = state.store.sessions[input.sessionId]
  const binding = {
    sessionId: input.sessionId,
    mcuId: id,
    model,
    project: text(input.project) || text(previous?.project),
    purpose: text(input.purpose) || text(previous?.purpose),
    peripherals:
      Array.isArray(input.peripherals) && input.peripherals.length > 0
        ? input.peripherals.map((item) => text(item)).filter((item) => item !== '')
        : Array.isArray(previous?.peripherals)
          ? previous.peripherals
          : [],
    toolchain: text(input.toolchain) || text(catalog.toolchain) || text(previous?.toolchain),
    evidence: evidence.length > 0 ? evidence : Array.isArray(previous?.evidence) ? previous.evidence : [],
    boundAt: text(previous?.boundAt) || at,
    updatedAt: at,
  }
  state.store.sessions[input.sessionId] = binding

  pushLog(state, {
    at,
    session: input.sessionId,
    mcuId: id,
    model,
    kind: 'bind',
    text:
      text(input.notes) ||
      [binding.purpose, binding.project === '' ? '' : `工程 ${binding.project}`].filter((item) => item !== '').join(' · ') ||
      '绑定型号',
    tags: [],
  })

  return { id, model, record, catalog, binding, changed: text(previous?.mcuId) !== id }
}

function addNote(state, input) {
  const binding = state.store.sessions[input.sessionId]
  if (!isRecord(binding)) return undefined
  const at = nowIso()
  const record = mcuRecord(state, binding.mcuId)
  const note = { at, session: input.sessionId, kind: input.kind, text: input.text, tags: input.tags ?? [] }
  record.notes.push(note)
  if (record.notes.length > 200) record.notes.splice(0, record.notes.length - 200)
  record.lastUsedAt = at
  if ((input.kind === 'feature' || input.kind === 'peripheral') && input.text.length <= 32) {
    uniquePush(record.functions, input.text)
  }
  for (const tag of Array.isArray(input.tags) ? input.tags : []) uniquePush(record.peripherals, tag)
  pushLog(state, {
    at,
    session: input.sessionId,
    mcuId: binding.mcuId,
    model: binding.model,
    kind: input.kind,
    text: input.text,
    tags: note.tags,
  })
  return { note, record, binding }
}

/** 候选型号：先用过的（最近优先），再补型号库里预置但没用过的，方便直接问用户「是哪一颗」。 */
function candidateModels(state, limit) {
  const names = Object.values(state.store.mcus)
    .sort((a, b) => String(b.lastUsedAt ?? '').localeCompare(String(a.lastUsedAt ?? '')))
    .map((record) => text(record.model))
    .filter((model) => model !== '')
  const unused = Object.values(state.store.catalog)
    .map((entry) => text(entry?.model))
    .filter((model) => model !== '' && !names.includes(model))
    .sort()
  return [...names, ...unused].slice(0, limit)
}

function describeSpec(catalog) {
  if (!isRecord(catalog)) return ''
  const size = catalog.flashKb || catalog.ramKb ? `${catalog.flashKb ?? '?'}KB/${catalog.ramKb ?? '?'}KB` : ''
  return [catalog.family, catalog.core, catalog.clockMhz ? `${catalog.clockMhz}MHz` : '', size].filter((item) => text(item) !== '').join(' · ')
}

/**
 * 组装会话标题：优先级「型号 · 目标功能 · 工程」，超预算就停在这一段并尽量多保留它
 * （例如「STM32H750VBT6 · 把外部 QSPI Flash 内存映射…」），而不是跳到下一段丢掉重点。
 * 部署的 session-title 有自己的 maxTitleBytes（本机是 80），这里先把自己裁到预算内，
 * 免得服务端不得不拒绝或截断。
 */
function composeTitle(parts, maxBytes) {
  const kept = parts.map((part) => text(part)).filter((part) => part !== '')
  if (kept.length === 0) return ''
  let title = truncateBytes(kept[0], maxBytes)
  for (const part of kept.slice(1)) {
    const candidate = `${title} · ${part}`
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      title = candidate
      continue
    }
    const room = maxBytes - Buffer.byteLength(`${title} · `, 'utf8')
    if (room >= 8) title = `${title} · ${truncateBytes(part, room)}`
    break
  }
  return title
}

function applyTitle(ctx, state, session, title) {
  if (state.config.renameSessionTitle === false) return { applied: false, title: null, reason: '已按配置关闭' }
  try {
    const service = ctx.get('sessionTitle')
    if (typeof service?.rename !== 'function') return { applied: false, title: null, reason: '当前部署没有会话标题服务' }
    const finalTitle = truncateBytes(title, Math.max(16, Math.trunc(Number(state.config.titleMaxBytes) || 72)))
    service.rename(session, finalTitle)
    return { applied: true, title: finalTitle, reason: null }
  } catch (error) {
    return { applied: false, title: null, reason: String(error?.message ?? error) }
  }
}

function requireSession(exec) {
  const session = exec?.agent?.session
  if (session === undefined || session === null) throw new Error('该工具需要会话上下文（agent），当前调用没有')
  return session
}

function bindingView(state, sessionId) {
  const binding = state.store.sessions[sessionId]
  if (!isRecord(binding)) return { bound: false, binding: null, record: {}, catalog: {} }
  const record = state.store.mcus[binding.mcuId]
  return {
    bound: true,
    binding,
    record: isRecord(record)
      ? record
      : { id: binding.mcuId, model: binding.model, sessionCount: 0, sessions: [], projects: [], functions: [], peripherals: [], notes: [] },
    catalog: isRecord(state.store.catalog[binding.mcuId]) ? state.store.catalog[binding.mcuId] : {},
  }
}

function recentNotes(record, limit) {
  if (!isRecord(record) || !Array.isArray(record.notes)) return []
  return record.notes.slice(-limit)
}

// ── 工程探测（系统提示里内联用，带缓存）────────────────────────────────────

/** 工作区廉价探测的缓存：系统提示每一步都会组装，所以同一目录 N 秒内只探一次。 */
const probeCache = new Map()

/** 会话的工作目录：优先用会话头里记录的 cwd（它是durable 事实），再退回进程 cwd。 */
function cwdOf(context) {
  const fromHeader = text(context?.agent?.session?.header?.cwd)
  if (fromHeader !== '') return fromHeader
  const fromAgent = text(context?.agent?.cwd)
  if (fromAgent !== '') return fromAgent
  return process.cwd()
}

/**
 * 对工作区做一次廉价探测（浅遍历、少读文件），只为了在系统提示里给模型一个确切起点。
 * 失败（目录不存在、权限、工程太大）都降级为"没探到"，绝不抛。
 */
function probeProject(root, config) {
  const key = root
  const ttlMs = Math.max(0, Number(config.probeCacheSeconds) || 30) * 1000
  const cached = probeCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.value
  let value
  try {
    const scan = scanProject(root, { maxDepth: 2, maxDirs: 60, maxContentFiles: 8 })
    value = {
      root,
      model: scan.inferred.model,
      toolchain: scan.inferred.toolchain,
      library: scan.inferred.library,
      confidence: scan.confidence,
      evidence: scan.evidence.slice(0, 6).map((item) => `${item.file} → ${item.value}`),
    }
  } catch {
    value = { root, model: undefined, toolchain: undefined, library: '未知', confidence: 'low', evidence: [] }
  }
  probeCache.set(key, { at: Date.now(), value })
  if (probeCache.size > 32) probeCache.delete(probeCache.keys().next().value)
  return value
}

/** 把扫描结果压成"文件 → 关键值"的依据行，用于绑定记录与展示。 */
function evidenceLines(inferred, evidence, limit) {
  const lines = []
  if (inferred.model !== undefined) {
    const source = evidence.find((item) => item.kind === 'device')
    lines.push(`型号 ${inferred.model}${source === undefined ? '' : `（${source.file} → ${source.value}）`}`)
  }
  if (inferred.toolchain !== undefined) lines.push(`工具链 ${inferred.toolchain}`)
  if (inferred.library !== undefined && inferred.library !== '未知') lines.push(`固件库 ${inferred.library}`)
  if (Array.isArray(inferred.peripherals) && inferred.peripherals.length > 0) lines.push(`外设 ${inferred.peripherals.slice(0, 12).join('、')}`)
  return lines.slice(0, limit)
}

/** 型号库里有没有同一颗（工程写 STM32F407VETx、库里存 STM32F407VET6 这种要认出来）。 */
function findCatalogMatch(state, model) {
  if (text(model) === '') return undefined
  for (const entry of Object.values(state.store.catalog)) {
    if (isRecord(entry) && modelMatches(model, entry.model)) return entry
  }
  return undefined
}

/**
 * 用扫描结果补全型号库字段：型号能扫出来，但厂商/系列/内核/Flash/RAM 要靠扫描的旁证
 * （Keil `<Cpu>` 的 IROM/IRAM、CPUTYPE，或 .ioc 的器件名）。
 * 命中型号库时先拿库里的规格打底，再用扫描到的值覆盖——这样 Keil 通配型号（…VETx）
 * 也能有一份完整档案，而不是表格里一排 "-"。
 */
function scanSpec(inferred, matchedEntry) {
  const spec = isRecord(matchedEntry) ? { ...matchedEntry } : {}
  delete spec.id
  delete spec.model
  delete spec.updatedAt
  delete spec.source
  if (inferred.vendor !== undefined) spec.vendor = inferred.vendor
  if (inferred.family !== undefined) spec.family = inferred.family
  if (inferred.core !== undefined) spec.core = inferred.core
  if (inferred.toolchain !== undefined) spec.toolchain = inferred.toolchain
  if (Array.isArray(inferred.peripherals) && inferred.peripherals.length > 0) spec.features = inferred.peripherals.slice(0, 16)
  for (const item of Array.isArray(inferred.memory) ? inferred.memory : []) {
    const flash = /^IROM\s+(\d+)KB/i.exec(item)
    if (flash !== null) spec.flashKb = Number(flash[1])
    const ram = /^IRAM\s+(\d+)KB/i.exec(item)
    if (ram !== null) spec.ramKb = Number(ram[1])
  }
  return spec
}

// ── 系统提示段落 ────────────────────────────────────────────────────────────

function buildSection(ctx, state) {
  const order = Number.isFinite(Number(state.config.promptSectionOrder)) ? Number(state.config.promptSectionOrder) : 90
  const noteLimit = Math.max(0, Math.trunc(Number(state.config.recentNotes) || 3))
  return {
    name: 'mcu:session',
    order,
    // 每次组装都会调用（惰性段落）：型号绑定变了，模型下一次请求就知道。
    text: (context) => {
      try {
        ensureFresh(state)
        const sessionId = text(context?.agent?.session?.id)
        const view = sessionId === '' ? { bound: false } : bindingView(state, sessionId)
        const header = '## 单片机上下文（单片机模式）'
        if (view.bound) {
          const spec = describeSpec(view.catalog)
          const lines = [`${header}`, `本会话使用的单片机：${view.binding.model}${spec === '' ? '' : `（${spec}）`}`]
          if (text(view.binding.project) !== '') lines.push(`工程：${view.binding.project}`)
          if (text(view.binding.purpose) !== '') lines.push(`本会话目标功能：${view.binding.purpose}`)
          if (Array.isArray(view.binding.peripherals) && view.binding.peripherals.length > 0) {
            lines.push(`涉及外设：${view.binding.peripherals.join('、')}`)
          }
          if (text(view.binding.toolchain) !== '') lines.push(`工具链：${view.binding.toolchain}`)
          if (Array.isArray(view.binding.evidence) && view.binding.evidence.length > 0) {
            lines.push(`绑定依据：${view.binding.evidence.slice(0, 6).join('；')}`)
          }
          const notes = recentNotes(view.record, noteLimit)
          if (notes.length > 0) {
            lines.push('该型号最近记录：')
            for (const note of notes) {
              lines.push(`- ${text(note.at).slice(0, 10)} [${KIND_LABEL[note.kind] ?? note.kind}] ${note.text}`)
            }
          }
          lines.push(
            '',
            '规则：',
            `- 型号相关结论以 ${view.binding.model} 为准；用户换了型号就先调用 mcu_bind 更新绑定。`,
            '- 本会话每次回答涉及型号/引脚/外设时，都要写出依据（哪个文件里的哪个值）；工程里找不到依据的结论，明确说"未在工程中找到"，不许凭别的型号的记忆补。',
            '- 动工程代码之前，先调用 mcu_scan（可带 path）核对工程里的型号/工具链/库类型与绑定是否一致；不一致先报告给用户，不要按绑定硬写。',
            '- 每完成一项有意义的固件工作（外设点亮、驱动调通、协议实现、踩坑修复、构建脚本），调用 mcu_note 记录。',
            `- 使用档案（可直接读取或给用户看）：${state.docFile}`,
          )
          return lines.join('\n')
        }
        const candidates = candidateModels(state, 12)
        const lines = [
          header,
          '本会话尚未绑定单片机型号。开始任何单片机/固件工作之前，**第一步就调用 `mcu_scan`**（不带参数即扫描当前工作区；工程在别处就传 path）：',
          '- mcu_scan 会直接把「哪个文件给出了什么值」列出来，型号明确时会自动绑定本会话，并更新会话标题；',
          '- 然后把那张证据表贴给用户看（文件 → 关键值 → 结论），再往下谈方案；绑定后可用 mcu_bind 补全工程名/目标功能/外设；',
          '- 扫描没识别出型号时，用 ask_user_question 问用户（候选见下），或让用户指明工程目录。',
        ]
        if (state.config.probeInSection !== false) {
          const probe = probeProject(cwdOf(context), state.config)
          lines.push('', `工作区探测（${probe.root}）：`)
          if (probe.model !== undefined || probe.evidence.length > 0) {
            if (probe.model !== undefined) lines.push(`- 探到型号：${probe.model}（置信度 ${probe.confidence}）`)
            if (probe.toolchain !== undefined) lines.push(`- 探到工具链：${probe.toolchain}`)
            if (probe.library !== undefined && probe.library !== '未知') lines.push(`- 探到固件库：${probe.library}`)
            for (const item of probe.evidence) lines.push(`    · ${item}`)
            lines.push('- 这是浅层探测，完整证据请跑 mcu_scan。')
          } else {
            lines.push('- 没有探到任何单片机器件信息。工程不在工作区时，请把工程目录作为 path 传给 mcu_scan。')
          }
        }
        if (candidates.length > 0) lines.push('', `已记录/预置的候选型号：${candidates.join('、')}`)
        lines.push('', `使用档案：${state.docFile}`)
        return lines.join('\n')
      } catch (error) {
        // 段落是系统提示的一部分：这里绝不能抛，否则整个请求组装失败。
        warn(ctx, `[mcu] 单片机上下文段落生成失败：${String(error?.message ?? error)}`)
        return ''
      }
    },
  }
}

// ── 人读汇总 ────────────────────────────────────────────────────────────────

function cell(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function sizeOf(catalog) {
  if (catalog.flashKb === undefined && catalog.ramKb === undefined) return '-'
  return `${catalog.flashKb ?? '?'}KB / ${catalog.ramKb ?? '?'}KB`
}

function sortedIds(state) {
  return Object.keys(state.store.mcus).sort((a, b) =>
    String(state.store.mcus[b]?.lastUsedAt ?? '').localeCompare(String(state.store.mcus[a]?.lastUsedAt ?? '')),
  )
}

function renderDoc(state) {
  const { catalog, mcus, sessions, log } = state.store
  const ids = sortedIds(state)
  const lines = [
    '# 单片机使用档案',
    '',
    '> 由 DSH「单片机模式」自动维护（插件 `mcu-registry`）。手改下面内容会在下次写入时被覆盖。',
    `> 数据文件：\`${state.jsonFile}\``,
    `> 最后更新：${state.store.updatedAt ?? nowIso()}`,
    '',
    `## 型号一览（${ids.length}）`,
    '',
  ]
  if (ids.length === 0) {
    lines.push('_还没有记录任何型号。在单片机模式里绑定型号（mcu_bind）后这里就会出现。_', '')
  } else {
    lines.push('| 型号 | 厂商/系列 | 内核 | 主频 | Flash / RAM | 会话数 | 最近使用 | 工程 |', '|---|---|---|---|---|---|---|---|')
    for (const id of ids) {
      const record = mcus[id] ?? {}
      const spec = catalog[id] ?? {}
      lines.push(
        `| ${cell(record.model ?? spec.model ?? id)} | ${cell([spec.vendor, spec.family].filter(Boolean).join(' / ') || '-')} | ${cell(spec.core ?? '-')} | ${cell(spec.clockMhz ? `${spec.clockMhz}MHz` : '-')} | ${cell(sizeOf(spec))} | ${cell(record.sessionCount ?? 0)} | ${cell(text(record.lastUsedAt).slice(0, 10) || '-')} | ${cell((record.projects ?? []).join('、') || '-')} |`,
      )
    }
    lines.push('')
  }

  const sessionRows = Object.values(sessions)
    .sort((a, b) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')))
    .slice(0, 30)
  lines.push(`## 会话索引（最近 ${sessionRows.length} 条 / 共 ${Object.keys(sessions).length} 个对话）`, '')
  if (sessionRows.length === 0) {
    lines.push('_暂无。_', '')
  } else {
    lines.push('| 会话 | 型号 | 工程 | 目标功能 | 涉及外设 | 绑定时间 |', '|---|---|---|---|---|---|')
    for (const binding of sessionRows) {
      lines.push(
        `| ${cell(binding.sessionId)} | ${cell(binding.model)} | ${cell(binding.project || '-')} | ${cell(binding.purpose || '-')} | ${cell((binding.peripherals ?? []).join('、') || '-')} | ${cell(text(binding.boundAt).slice(0, 10))} |`,
      )
    }
    lines.push('')
  }

  lines.push('## 型号档案', '')
  if (ids.length === 0) {
    lines.push('_暂无。_', '')
  } else {
    for (const id of ids) {
      const record = mcus[id] ?? {}
      const spec = catalog[id] ?? {}
      lines.push(`### ${record.model ?? spec.model ?? id}`, '')
      const specLine = [
        [spec.vendor, spec.family].filter(Boolean).join(' / '),
        spec.core,
        spec.clockMhz ? `${spec.clockMhz}MHz` : '',
        sizeOf(spec) === '-' ? '' : `${sizeOf(spec)}`,
        spec.packageName,
        spec.voltage,
        spec.toolchain ? `工具链 ${spec.toolchain}` : '',
      ]
        .filter((item) => text(item) !== '')
        .join(' · ')
      if (specLine !== '') lines.push(`- 规格：${specLine}`)
      if (Array.isArray(spec.features) && spec.features.length > 0) lines.push(`- 片上资源：${spec.features.join('、')}`)
      if (text(spec.notes) !== '') lines.push(`- 备注：${spec.notes}`)
      if ((record.projects ?? []).length > 0) lines.push(`- 工程：${record.projects.join('、')}`)
      if ((record.functions ?? []).length > 0) lines.push(`- 功能：${record.functions.join('、')}`)
      if ((record.peripherals ?? []).length > 0) lines.push(`- 外设：${record.peripherals.join('、')}`)
      if ((record.evidence ?? []).length > 0) lines.push(`- 判定依据：${record.evidence.slice(0, 8).join('；')}`)
      lines.push(`- 累计会话：${record.sessionCount ?? 0}　首次使用：${text(record.firstUsedAt).slice(0, 10) || '-'}　最近使用：${text(record.lastUsedAt).slice(0, 10) || '-'}`)
      const notes = Array.isArray(record.notes) ? record.notes.slice(-20) : []
      if (notes.length > 0) {
        lines.push('- 记录：')
        for (const note of notes) {
          lines.push(`  - ${text(note.at).slice(0, 19).replace('T', ' ')} [${KIND_LABEL[note.kind] ?? note.kind}] ${note.text}`)
        }
      }
      lines.push('')
    }
  }

  const timeline = Array.isArray(log) ? log.slice(-40).reverse() : []
  lines.push(`## 最近记录（时间线，最新在前 / 共 ${Array.isArray(log) ? log.length : 0} 条）`, '')
  if (timeline.length === 0) {
    lines.push('_暂无。_', '')
  } else {
    for (const entry of timeline) {
      lines.push(`- ${text(entry.at).slice(0, 19).replace('T', ' ')}　${cell(entry.model)}　[${KIND_LABEL[entry.kind] ?? entry.kind}] ${entry.text}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ── 工具 ────────────────────────────────────────────────────────────────────

/**
 * 本插件不用 @deepseek-ai/dsh-tools 的 defineTool（见文件头对依赖的说明），
 * 这个本地 helper 负责把它补上：
 *   - 把「属性表 + required 列表」拼成注册表要的原始 JSON Schema；
 *   - 在真正执行前做一次入参校验（原始注册不会替工具校验参数），
 *     校验失败抛错 → 注册表会把它变成 isError 结果，模型能自我纠正。
 */
function tool(spec) {
  const { name, description, parameters, required, output, presentCall, presentResult, timeoutMs, execute } = spec
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: parameters,
      ...(Array.isArray(required) && required.length > 0 ? { required } : {}),
    },
    output,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(presentCall === undefined ? {} : { presentCall }),
    ...(presentResult === undefined ? {} : { presentResult }),
    async execute(rawArgs, exec) {
      const args = isRecord(rawArgs) ? rawArgs : {}
      const violations = validateRaw(parameters, Array.isArray(required) ? required : [], args)
      if (violations.length > 0) throw new Error(`参数不合法：${violations.join('；')}`)
      return execute(args, exec)
    },
  }
}

/** 按声明做一次基础校验：必填、类型、枚举。只做"能明确判断是错的"的那部分。 */
function validateRaw(properties, required, args) {
  const violations = []
  for (const key of required) {
    const value = args[key]
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) violations.push(`缺少必填参数 ${key}`)
  }
  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key]
    if (value === undefined || value === null) continue
    if (spec.type === 'string' && typeof value !== 'string') violations.push(`${key} 必须是字符串`)
    else if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`${key} 必须是数字`)
    else if (spec.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) violations.push(`${key} 必须是整数`)
    else if (spec.type === 'boolean' && typeof value !== 'boolean') violations.push(`${key} 必须是布尔值`)
    else if (spec.type === 'array' && !Array.isArray(value)) violations.push(`${key} 必须是数组`)
    else if (Array.isArray(spec.enum) && !spec.enum.includes(value)) violations.push(`${key} 必须是 ${spec.enum.join(' / ')} 之一`)
  }
  return violations
}

function scanTool(ctx, state) {
  return {
    name: 'mcu_scan',
    description:
      '扫描单片机工程目录，把里面的具体信息连依据一起列出来：型号、厂商、内核、工具链、固件库（HAL/SPL/LL）、RTOS、外设、引脚、HSE/PLL、Flash/RAM。型号明确且本会话尚未绑定时，会自动绑定本会话（并更新会话标题）。开始任何单片机工作前第一步就调用它：不带参数扫当前工作区，工程在别处就传 path；拿到结果后必须把「文件 → 关键值」证据表贴给用户看，再谈方案。',
    parameters: {
      path: { type: 'string', description: '工程根目录（绝对路径）。省略则用当前会话的工作目录。' },
      bind: { type: 'boolean', description: '型号明确时是否自动绑定本会话（默认按部署配置，通常是 true）。' },
      project: { type: 'string', description: '工程/项目名，自动绑定时一并登记。' },
      purpose: { type: 'string', description: '本会话目标功能，自动绑定时一并登记。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          root: { type: 'string' },
          model: { type: 'string' },
          modelCandidates: STRING_LIST,
          confidence: { type: 'string' },
          toolchain: { type: 'string' },
          library: { type: 'string' },
          rtos: STRING_LIST,
          peripherals: STRING_LIST,
          pins: STRING_LIST,
          clock: STRING_LIST,
          memory: STRING_LIST,
          unknowns: STRING_LIST,
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { file: { type: 'string' }, kind: { type: 'string' }, value: { type: 'string' } },
            },
          },
          fileCount: { type: 'integer' },
          bound: { type: 'boolean' },
          boundModel: { type: 'string' },
          mismatch: { type: 'boolean' },
          sessionTitle: { type: 'string' },
          paths: PATHS_OUTPUT,
          report: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: [value.report, value.summary].filter((item) => text(item) !== '').join('\n\n') }],
    },
    presentCall: (args) => ({ card: 'generic', title: `扫描单片机工程 ${text(args?.path) || '(当前工作区)'}`, kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const session = requireSession(exec)
      ensureFresh(state)
      const root = resolve(text(args.path) === '' ? cwdOf({ agent: exec.agent }) : text(args.path))
      let isDirectory = false
      try {
        isDirectory = statSync(root).isDirectory()
      } catch {
        isDirectory = false
      }
      if (!isDirectory) throw new Error(`工程目录不存在或不可读：${root}`)

      const scan = scanProject(root)
      const report = renderScanReport(scan)
      const model = scan.inferred.model
      const wantBind = args.bind !== false && state.config.autoBindOnScan !== false
      const view = bindingView(state, session.id)

      let bound = false
      let boundModel = view.bound ? text(view.binding.model) : ''
      let mismatch = false
      let sessionTitle = ''
      const status = []

      if (view.bound) {
        if (model !== undefined && !modelMatches(model, boundModel)) {
          mismatch = true
          status.push(
            `⚠️ 不一致：工程里识别到 ${model}，但本会话绑定的是 ${boundModel}。先跟用户确认——是换了型号、工程里有多套配置，还是之前绑错了？确认前不要按 ${boundModel} 写型号相关的代码。`,
          )
        } else {
          status.push(`与绑定一致（本会话是 ${boundModel}）。`)
        }
      } else if (wantBind && model !== undefined && scan.confidence !== 'low') {
        const matched = findCatalogMatch(state, model)
        const evidence = evidenceLines(scan.inferred, scan.evidence, 6)
        if (matched !== undefined && text(matched.model) !== model) {
          evidence.push(`型号库匹配：${matched.model}（工程里写作 ${model}，末尾 x 通常是 Keil 的温度/批次通配符，规格沿用库里的）`)
        }
        const result = bindSession(state, {
          model,
          sessionId: session.id,
          project: args.project,
          purpose: args.purpose,
          peripherals: scan.inferred.peripherals,
          ...scanSpec(scan.inferred, matched),
          evidence,
        })
        const titleBudget = Math.max(16, Math.trunc(Number(state.config.titleMaxBytes) || 72))
        const titleResult = applyTitle(ctx, state, session, composeTitle([result.model, text(args.purpose), text(args.project)], titleBudget))
        await persist(state)
        bound = true
        boundModel = result.model
        sessionTitle = titleResult.applied ? text(titleResult.title) : ''
        status.push(
          `已自动绑定本会话：${result.model}${scan.inferred.toolchain === undefined ? '' : `（${scan.inferred.toolchain}）`}${titleResult.applied ? `，会话标题已改为「${sessionTitle}」` : ''}。`,
        )
        status.push('把上面的证据表贴给用户看；需要补全工程名/目标功能时再调用 mcu_bind。')
        if (matched !== undefined && text(matched.model) !== model) {
          status.push(`型号库里已有同一颗：${matched.model}（工程里写作 ${model}，规格沿用库里的那份）。`)
        }
      } else if (model === undefined) {
        status.push('没能从工程里识别出型号：请让用户指明工程目录（path）或用 ask_user_question 问型号，然后 mcu_bind。')
      } else {
        status.push(`识别到 ${model}（置信度 ${scan.confidence}），但按配置没有自动绑定；确认无误后调用 mcu_bind。`)
      }

      return {
        ok: true,
        root,
        model: model ?? '',
        modelCandidates: scan.inferred.modelCandidates,
        confidence: scan.confidence,
        toolchain: scan.inferred.toolchain ?? '',
        library: text(scan.inferred.library),
        rtos: scan.inferred.rtos,
        peripherals: scan.inferred.peripherals,
        pins: scan.inferred.pins,
        clock: scan.inferred.clock,
        memory: scan.inferred.memory,
        unknowns: scan.unknowns,
        evidence: scan.evidence.slice(0, 60).map((item) => ({ file: item.file, kind: item.kind, value: item.value })),
        fileCount: scan.fileCount,
        bound,
        boundModel,
        mismatch,
        sessionTitle,
        paths: pathsOf(state),
        report,
        summary: status.join('\n'),
      }
    },
  }
}

function bindTool(ctx, state) {
  return {
    name: 'mcu_bind',
    description:
      '把当前对话绑定到一颗单片机，并登记它的用途。开始任何单片机/固件工作前先调用它：绑定后本会话的型号、工程、目标功能会持续注入系统提示，并写入使用档案（型号库 + 使用记录 + REGISTRY.md），会话标题也会改成「型号 · 功能」便于在对话列表里辨认。用户换型号时再调用一次即可（会更新绑定并累计会话）。型号不确定时先从工程文件推断（.ioc/*.uvprojx/Makefile/platformio.ini/链接脚本），仍无法确定就用 ask_user_question 问用户。',
    parameters: {
      model: { type: 'string', description: '单片机型号，如 STM32F103C8T6' },
      project: { type: 'string', description: '工程/项目名，如 温控板固件' },
      purpose: { type: 'string', description: '本会话要用它实现的功能/任务，如 PWM 调光、USART DMA 收发' },
      peripherals: { ...STRING_LIST, description: '本会话涉及的外设/模块，如 ["USART1","TIM3 PWM","I2C OLED"]' },
      evidence: { ...STRING_LIST, description: '判定依据（每个元素一条「文件 → 关键值」，如 "MDK-ARM/TFT.uvprojx → Device=STM32F407VETx"）。mcu_scan 会自动带上；手工绑定时建议写明依据。' },
      ...SPEC_PROPERTIES,
    },
    required: ['model'],
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bound: { type: 'boolean' },
          mcuId: { type: 'string' },
          model: { type: 'string' },
          sessionId: { type: 'string' },
          project: { type: 'string' },
          purpose: { type: 'string' },
          peripherals: STRING_LIST,
          toolchain: { type: 'string' },
          sessionTitle: { type: 'string' },
          titleNote: { type: 'string' },
          spec: LOOSE_RECORD,
          record: LOOSE_RECORD,
          recentNotes: { type: 'array', items: NOTE_ITEM },
          candidates: STRING_LIST,
          paths: PATHS_OUTPUT,
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    presentCall: (args) => ({ card: 'generic', title: `绑定单片机 ${text(args?.model) || ''}`.trim(), kind: 'other', rawInput: args }),
    execute(args, exec) {
      const session = requireSession(exec)
      ensureFresh(state)
      const result = bindSession(state, {
        ...args,
        sessionId: session.id,
        peripherals: Array.isArray(args.peripherals) ? args.peripherals : [],
      })
      const titleBudget = Math.max(16, Math.trunc(Number(state.config.titleMaxBytes) || 72))
      const title = composeTitle([result.model, text(result.binding.purpose), text(result.binding.project)], titleBudget)
      const titleResult = applyTitle(ctx, state, session, title === '' ? result.model : title)
      const spec = describeSpec(result.catalog)
      const evidence = Array.isArray(result.binding.evidence) ? result.binding.evidence : []
      const summary = [
        `已把本会话绑定到 ${result.model}${spec === '' ? '' : `（${spec}）`}。`,
        result.changed ? '（换了型号，本会话后续以新绑定为准）' : '（与之前一致）',
        evidence.length > 0 ? `判定依据：${evidence.slice(0, 6).join('；')}。` : '未记录判定依据——建议改为先跑 mcu_scan，或把依据写进 evidence 参数。',
        titleResult.applied ? `会话标题已改为「${titleResult.title}」。` : `会话标题未改动：${titleResult.reason ?? '未执行'}。`,
        `使用档案：${state.docFile}`,
      ].join('')
      return persist(state).then(() => ({
        bound: true,
        mcuId: result.id,
        model: result.model,
        sessionId: session.id,
        project: text(result.binding.project),
        purpose: text(result.binding.purpose),
        peripherals: result.binding.peripherals ?? [],
        toolchain: text(result.binding.toolchain),
        sessionTitle: titleResult.applied ? text(titleResult.title) : '',
        titleNote: titleResult.applied ? '' : String(titleResult.reason ?? ''),
        spec: result.catalog,
        record: result.record,
        recentNotes: recentNotes(result.record, 5),
        candidates: candidateModels(state, 12),
        paths: pathsOf(state),
        summary,
      }))
    },
  }
}

function statusTool(ctx, state) {
  return {
    name: 'mcu_status',
    description:
      '查看当前对话绑定的是哪颗单片机，以及该型号的规格、累计会话、工程、功能与最近记录。不确定本会话用的是什么型号时调用它（不要凭记忆猜）。返回 bound=false 表示本会话还没绑定，此时应先 mcu_bind。',
    parameters: {
      history: { type: 'boolean', description: '是否附带该型号最近的使用记录（默认 true）' },
      historyLimit: { type: 'number', description: '附带几条记录（默认 5）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bound: { type: 'boolean' },
          sessionId: { type: 'string' },
          model: { type: 'string' },
          project: { type: 'string' },
          purpose: { type: 'string' },
          peripherals: STRING_LIST,
          toolchain: { type: 'string' },
          spec: LOOSE_RECORD,
          record: LOOSE_RECORD,
          notes: { type: 'array', items: NOTE_ITEM },
          candidates: STRING_LIST,
          paths: PATHS_OUTPUT,
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    presentCall: () => ({ card: 'generic', title: '查看本会话的单片机', kind: 'other' }),
    execute(args, exec) {
      const session = requireSession(exec)
      ensureFresh(state)
      const view = bindingView(state, session.id)
      const wantHistory = args.history !== false
      const limit = Math.max(1, Math.trunc(Number(args.historyLimit) || 5))
      if (!view.bound) {
        const candidates = candidateModels(state, 12)
        const summary = [
          `本会话还没有绑定单片机。`,
          candidates.length > 0 ? `已记录/预置的候选型号：${candidates.join('、')}。` : '',
          `确定型号后调用 mcu_bind 绑定（型号可从工程文件推断，或问用户）。使用档案：${state.docFile}`,
        ]
          .filter((item) => item !== '')
          .join(' ')
        return Promise.resolve({
          bound: false,
          sessionId: session.id,
          model: '',
          project: '',
          purpose: '',
          peripherals: [],
          toolchain: '',
          spec: {},
          record: {},
          notes: [],
          candidates,
          paths: pathsOf(state),
          summary,
        })
      }
      const spec = describeSpec(view.catalog)
      const notes = wantHistory ? recentNotes(view.record, limit) : []
      const summary = [
        `本会话使用：${view.binding.model}${spec === '' ? '' : `（${spec}）`}`,
        text(view.binding.project) === '' ? '' : `工程 ${view.binding.project}`,
        text(view.binding.purpose) === '' ? '' : `目标功能 ${view.binding.purpose}`,
        Array.isArray(view.binding.peripherals) && view.binding.peripherals.length > 0 ? `外设 ${view.binding.peripherals.join('、')}` : '',
        text(view.binding.toolchain) === '' ? '' : `工具链 ${view.binding.toolchain}`,
        `累计 ${view.record?.sessionCount ?? 0} 个会话`,
      ]
        .filter((item) => item !== '')
        .join(' · ')
      const noteLines = notes.map((note) => `- ${text(note.at).slice(0, 10)} [${KIND_LABEL[note.kind] ?? note.kind}] ${note.text}`)
      return Promise.resolve({
        bound: true,
        sessionId: session.id,
        model: view.binding.model,
        project: text(view.binding.project),
        purpose: text(view.binding.purpose),
        peripherals: view.binding.peripherals ?? [],
        toolchain: text(view.binding.toolchain),
        spec: view.catalog,
        record: view.record,
        notes,
        candidates: candidateModels(state, 12),
        paths: pathsOf(state),
        summary: [summary, noteLines.length > 0 ? `最近记录：\n${noteLines.join('\n')}` : '', `使用档案：${state.docFile}`]
          .filter((item) => item !== '')
          .join('\n'),
      })
    },
  }
}

function noteTool(ctx, state) {
  return {
    name: 'mcu_note',
    description:
      '把一条使用记录写进当前对话所绑定单片机的档案：完成了什么功能、调通了哪个外设/驱动/协议、踩了什么坑、怎么修的、构建/烧录参数等。每完成一项有意义的固件工作就记一条，下次同型号的对话会看到这些记录（也会出现在系统提示和 REGISTRY.md 里）。本会话尚未绑定型号时会报错，此时先调用 mcu_bind。',
    parameters: {
      text: { type: 'string', description: '记录内容（一句话说清楚：做了什么 + 关键结论/参数）' },
      kind: {
        type: 'string',
        enum: ['feature', 'peripheral', 'driver', 'protocol', 'pitfall', 'debug', 'build', 'other'],
        description: 'feature 功能 / peripheral 外设 / driver 驱动 / protocol 协议 / pitfall 踩坑 / debug 调试 / build 构建 / other 其他',
      },
      tags: { ...STRING_LIST, description: '标签，如 ["TIM3","PWM","DMA"]' },
    },
    required: ['text'],
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          model: { type: 'string' },
          kind: { type: 'string' },
          at: { type: 'string' },
          notesCount: { type: 'integer' },
          paths: PATHS_OUTPUT,
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    presentCall: (args) => ({ card: 'generic', title: `记录单片机使用：${text(args?.kind) || 'other'}`, kind: 'other', rawInput: args }),
    execute(args, exec) {
      const session = requireSession(exec)
      ensureFresh(state)
      const kind = NOTE_KINDS.includes(args.kind) ? args.kind : 'other'
      const body = text(args.text)
      if (body === '') throw new Error('记录内容不能为空')
      const result = addNote(state, {
        sessionId: session.id,
        kind,
        text: body,
        tags: Array.isArray(args.tags) ? args.tags.map((item) => text(item)).filter((item) => item !== '') : [],
      })
      if (result === undefined) {
        throw new Error('本会话尚未绑定单片机，请先调用 mcu_bind 绑定型号后再记录')
      }
      const summary = `已记录到 ${result.binding.model} 的档案：[${KIND_LABEL[kind] ?? kind}] ${body}（该型号共 ${result.record.notes.length} 条记录）`
      return persist(state).then(() => ({
        ok: true,
        model: result.binding.model,
        kind,
        at: result.note.at,
        notesCount: result.record.notes.length,
        paths: pathsOf(state),
        summary,
      }))
    },
  }
}

function listTool(ctx, state) {
  return {
    name: 'mcu_list',
    description:
      '列出已经记录过的单片机型号（含累计会话数、工程、功能、最近使用时间），以及型号库里还没用过的条目。想知道自己用过哪些单片机、每颗用来做什么时调用它。',
    parameters: {
      includeCatalog: { type: 'boolean', description: '是否附带型号库里尚未使用过的型号（默认 true）' },
      limit: { type: 'number', description: '最多返回多少条（默认 50）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          used: { type: 'array', items: LOOSE_RECORD },
          catalogOnly: { type: 'array', items: LOOSE_RECORD },
          sessions: { type: 'integer' },
          paths: PATHS_OUTPUT,
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    presentCall: () => ({ card: 'generic', title: '单片机型号与使用记录', kind: 'other' }),
    execute(args) {
      ensureFresh(state)
      const limit = Math.max(1, Math.trunc(Number(args.limit) || 50))
      const includeCatalog = args.includeCatalog !== false
      const ids = sortedIds(state)
      const used = ids.slice(0, limit).map((id) => {
        const record = state.store.mcus[id] ?? {}
        const spec = state.store.catalog[id] ?? {}
        return {
          id,
          model: record.model ?? spec.model ?? id,
          spec: describeSpec(spec),
          sessions: record.sessionCount ?? 0,
          projects: record.projects ?? [],
          functions: record.functions ?? [],
          peripherals: record.peripherals ?? [],
          notes: Array.isArray(record.notes) ? record.notes.length : 0,
          lastUsedAt: text(record.lastUsedAt),
        }
      })
      const catalogOnly = includeCatalog
        ? Object.keys(state.store.catalog)
            .filter((id) => !isRecord(state.store.mcus[id]))
            .slice(0, limit)
            .map((id) => {
              const spec = state.store.catalog[id] ?? {}
              return { id, model: spec.model ?? id, spec: describeSpec(spec), source: text(spec.source), toolchain: text(spec.toolchain) }
            })
        : []
      const summary = [
        `已记录 ${used.length} 个型号、${Object.keys(state.store.sessions).length} 个对话绑定。`,
        used.length > 0
          ? `使用过的型号：\n${used.map((item) => `- ${item.model}${item.spec === '' ? '' : `（${item.spec}）`}　${item.sessions} 个会话　${(item.projects ?? []).join('、') || '未记工程'}　最近 ${(item.lastUsedAt || '').slice(0, 10) || '-'}`).join('\n')}`
          : '还没有使用记录，调用 mcu_bind 绑定第一颗型号即可。',
        catalogOnly.length > 0 ? `型号库里还没用过的：${catalogOnly.map((item) => item.model).join('、')}` : '',
        `使用档案：${state.docFile}`,
      ]
        .filter((item) => item !== '')
        .join('\n')
      return Promise.resolve({
        count: used.length,
        used,
        catalogOnly,
        sessions: Object.keys(state.store.sessions).length,
        paths: pathsOf(state),
        summary,
      })
    },
  }
}

function catalogTool(ctx, state) {
  return {
    name: 'mcu_catalog_set',
    description:
      '新增或修改型号库里的规格条目（不改变本会话的绑定）：厂商、系列、内核、主频、Flash/RAM、封装、供电、开发板、工具链、片上资源、备注。用户给出数据手册要点、或你想把查到的规格固化下来时调用它；已经绑定过的型号也可以补全规格。',
    parameters: {
      model: { type: 'string', description: '型号，如 STM32F103C8T6' },
      ...SPEC_PROPERTIES,
    },
    required: ['model'],
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mcuId: { type: 'string' },
          entry: LOOSE_RECORD,
          paths: PATHS_OUTPUT,
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    presentCall: (args) => ({ card: 'generic', title: `登记型号规格 ${text(args?.model) || ''}`.trim(), kind: 'other' }),
    execute(args) {
      ensureFresh(state)
      const model = text(args.model)
      if (model === '') throw new Error('model 不能为空')
      const id = slugOf(model)
      const patch = specPatchOf(args)
      if (Object.keys(patch).length === 0) throw new Error('至少要给出一个规格字段（vendor/family/core/clockMhz/flashKb/ramKb/packageName/voltage/board/toolchain/features/notes）')
      const previous = isRecord(state.store.catalog[id]) ? state.store.catalog[id] : {}
      const entry = { ...previous, ...patch, id, model, source: text(previous.source) || '对话登记', updatedAt: nowIso() }
      state.store.catalog[id] = entry
      const summary = `型号库已更新 ${model}：${describeSpec(entry)}${Array.isArray(entry.features) && entry.features.length > 0 ? ` ｜ 片上资源 ${entry.features.join('、')}` : ''}`
      return persist(state).then(() => ({ ok: true, mcuId: id, entry, paths: pathsOf(state), summary }))
    },
  }
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(isRecord(config) ? config : {}) }
  const state = createState(resolved)
  if (state.corrupted) {
    warn(ctx, `[mcu] 档案文件无法解析，已改名保留现场并从空档案继续：${state.jsonFile}`)
  }
  if (resolved.promptSection !== false) {
    ctx.systemPrompt.section(buildSection(ctx, state))
  }
  ctx.tools.register(tool(scanTool(ctx, state)))
  ctx.tools.register(tool(bindTool(ctx, state)))
  ctx.tools.register(tool(statusTool(ctx, state)))
  ctx.tools.register(tool(noteTool(ctx, state)))
  ctx.tools.register(tool(listTool(ctx, state)))
  ctx.tools.register(tool(catalogTool(ctx, state)))
  try {
    ctx.logger?.info?.(
      `[mcu] 单片机模式档案：${state.jsonFile}（型号库 ${Object.keys(state.store.catalog).length} 条，已绑定会话 ${Object.keys(state.store.sessions).length} 个）`,
    )
  } catch {
    /* 日志失败不影响功能 */
  }
}

export const internals = { slugOf, truncateBytes, resolveDataDir, renderDoc, SPEC_FIELDS, NOTE_KINDS }
