/**
 * 用 harness 自己的 preset 花名册（roster）代码验证本模式能被发现、且健康。
 *
 * `discoverPresets()` 正是 DSH 设置页 / 新建对话时的模式选择器背后那次扫描：
 * 它检查目录名是否是合法 preset id（[a-z0-9][a-z0-9-]*）、agent.cordis.yml 是否能用
 * **加载器自己的 YAML 方言**解析（含 !!js）并且是「带 id/name 的行列表」、preset.yml
 * 显示信息是否可读。任何一项不过，GUI 上那一行会显示 "Failed to load" 与原因，
 * 而不是静默消失——本脚本把同一个判断搬到命令行。
 *
 * 用法（同样需要指向 harness node_modules 的 junction，见 test/run-tests.mjs 头部说明）：
 *   node test/verify-roster.mjs
 *   node test/verify-roster.mjs <用户预设根> <随部署附带的预设根>
 */

import { join } from 'node:path'
import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const userRoot = process.argv[2] ?? join(resolveDshHome(), '.agent-presets')
const shippedRoot = process.argv[3]

const roots = [{ path: userRoot, trust: 'user' }]
if (shippedRoot !== undefined) roots.unshift({ path: shippedRoot, trust: 'system' })

console.log(`扫描根目录：`)
for (const root of roots) console.log(`  - [${root.trust}] ${root.path}`)

const presets = await discoverPresets(roots)
console.log(`\n发现 ${presets.length} 个模式：`)
for (const preset of presets) {
  const name = preset.name ?? '(无 preset.yml 名称)'
  const state = preset.broken === undefined ? 'ok' : `BROKEN — ${preset.broken}`
  console.log(`  - ${preset.id.padEnd(12)} [${preset.trust}] ${name}  ${state}`)
  console.log(`      组合：${preset.path}`)
}

const target = presets.find((preset) => preset.id === 'mcu')
const problems = []
if (target === undefined) problems.push(`没有发现 id 为 "mcu" 的模式（用户预设根：${userRoot}）`)
else {
  if (target.broken !== undefined) problems.push(`"mcu" 被判为 broken：${target.broken}`)
  if (target.trust !== 'user') problems.push(`"mcu" 的 trust 是 ${target.trust}，期望 user`)
  if (target.name !== '单片机模式') problems.push(`"mcu" 的显示名是 ${JSON.stringify(target.name)}，期望 "单片机模式"`)
  if (target.path !== join(userRoot, 'mcu', 'agent.cordis.yml')) problems.push(`"mcu" 组合路径异常：${target.path}`)
}

if (problems.length > 0) {
  console.error(`\n单片机模式未被正确发现：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log(`\n单片机模式发现正常：id=mcu / trust=user / name=${target.name} / 组合可解析`)
}
