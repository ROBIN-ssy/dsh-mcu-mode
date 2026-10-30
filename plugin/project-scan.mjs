/**
 * 确定性工程扫描器：从一个工程目录里把「具体信息」挖出来，并逐条给出依据。
 *
 * 为什么要有它：光靠模型自己 read/grep，很容易读了一堆文件却只给一句"看起来是 STM32"，
 * 甚至干脆不绑定。这里是纯代码扫描：固定的一组探针 + 有界遍历，输出
 * 「文件 → 关键值 → 推断结论」，型号、工具链、库类型、RTOS、外设、引脚、HSE/PLL、Flash/RAM
 * 都能落到具体文件上，可以直接展示给用户，也可以直接喂给 mcu_bind。
 *
 * 边界（避免在大工程上失控）：
 *   - 遍历深度上限 5 层，目录访问上限 900，命中文件上限 400；
 *   - 内容扫描只读上限 80 个源文件、每个 256KB；
 *   - 跳过 .git / node_modules / Debug / Release / Objects / Listings / RTE / build 等；
 *   - 每一步都 try/catch，任何单点失败只是少一条证据，不会让扫描整体失败。
 *
 * 只依赖 node 内置模块，不依赖 harness（便于单测）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, basename, extname } from 'node:path'

const MAX_DEPTH = 5
const MAX_DIRS = 900
const MAX_NAME_HITS = 400
const MAX_CONTENT_FILES = 80
const MAX_CONTENT_BYTES = 256 * 1024
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.settings', '__pycache__',
  'debug', 'release', 'objects', 'listings', 'build', 'dist', 'out', 'backup', 'backups',
  'rte', 'temp', 'tmp', 'logs', 'obj', '.pnpm-store', '.npm-cache',
])
/** 文件名探针：命中就按对应解析器读内容。 */
const NAME_PROBES = [
  { kind: 'ioc', test: (name) => extname(name).toLowerCase() === '.ioc' },
  { kind: 'uvprojx', test: (name) => /\.uvproj(x)?$/i.test(name) },
  { kind: 'platformio', test: (name) => /^platformio\.ini$/i.test(name) },
  { kind: 'makefile', test: (name) => /^makefile$/i.test(name) },
  { kind: 'cmake', test: (name) => /^CMakeLists\.txt$/i.test(name) },
  { kind: 'linker', test: (name) => /\.(ld|lds|sct)$/i.test(name) },
  { kind: 'startup', test: (name) => /^startup_.*\.s$/i.test(name) },
  { kind: 'freertos', test: (name) => /^FreeRTOSConfig\.h$/i.test(name) },
  { kind: 'header', test: (name) => /^stm32[a-z0-9]*xx(_hal|_ll)?(_conf)?\.h$/i.test(name) },
  { kind: 'userheader', test: (name) => /\.(h|hpp)$/i.test(name) && !/^(stm32|core_cm|system_|cmsis)/i.test(name) },
  { kind: 'source', test: (name) => /\.(c|cpp|cc)$/i.test(name) },
]
/** 这些路径/文件名属于厂商库，只用来判定库类型，不参与"用了哪些外设/引脚"。 */
const LIBRARY_PATH = /(^|[\\/])(fwlib|fwlibraries|libraries|drivers|library|cmsis|hal_driver|spl|vendor|msp|rte)([\\/]|$)/i
/** CMSIS/启动样板文件同样不能当"工程用了什么"的证据（里面按系列列了所有外设）。 */
const LIBRARY_FILE = /^(system_stm32[a-z0-9]*|misc|startup_stm32[a-z0-9_]*)\.(c|s)$/i

const VENDOR_RULES = [
  [/^STC/i, 'STC'],
  [/^(STM32|STM8)/i, 'ST'],
  [/^GD32/i, '兆易创新 GigaDevice'],
  [/^(CH32|CH5|CH6)/i, '沁恒 WCH'],
  [/^HC32/i, '华大 HC32'],
  [/^(MM32|APM32)/i, '国产替代'],
  [/^ESP/i, 'Espressif 乐鑫'],
  [/^(AT|ATMEGA|ATTINY)/i, 'Microchip/Atmel'],
  [/^(RP2040|RP2350)/i, 'Raspberry Pi'],
  [/^NRF/i, 'Nordic'],
  [/^LPC/i, 'NXP'],
  [/^N76E|^M0/i, '新唐 Nuvoton'],
]
/** 系列 → 内核（只覆盖常见 STM32 与少数国产/8051）。 */
const CORE_RULES = [
  [/^STM32F0/i, 'Cortex-M0'],
  [/^STM32L0/i, 'Cortex-M0+'],
  [/^STM32G0/i, 'Cortex-M0+'],
  [/^STM32C0/i, 'Cortex-M0+'],
  [/^STM32F1/i, 'Cortex-M3'],
  [/^STM32L1/i, 'Cortex-M3'],
  [/^STM32F2/i, 'Cortex-M3'],
  [/^STM32F3/i, 'Cortex-M4F'],
  [/^STM32F4/i, 'Cortex-M4F'],
  [/^STM32L4/i, 'Cortex-M4F'],
  [/^STM32G4/i, 'Cortex-M4F'],
  [/^STM32WB/i, 'Cortex-M4'],
  [/^STM32F7/i, 'Cortex-M7'],
  [/^STM32H7/i, 'Cortex-M7'],
  [/^STM32U5/i, 'Cortex-M33'],
  [/^GD32F1/i, 'Cortex-M3'],
  [/^GD32F4/i, 'Cortex-M4F'],
  [/^CH32V/i, 'RISC-V'],
  [/^CH32F/i, 'Cortex-M3'],
  [/^HC32F/i, 'Cortex-M4F'],
  [/^ESP32/i, 'Xtensa/LX7'],
  [/^AT89|^ATmega|^ATtiny/i, 'AVR/8051'],
]

function readText(file, limit = MAX_CONTENT_BYTES) {
  try {
    const info = statSync(file)
    if (!info.isFile() || info.size > limit) return undefined
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function firstMatch(text, patterns) {
  for (const [pattern, group] of patterns) {
    const match = pattern.exec(text)
    if (match !== null) return group === undefined ? match[1] : match[group]
  }
  return undefined
}

/** 把一个型号字符串规整成可比较的大写字母数字形式（STM32F407VETx → STM32F407VETX）。 */
export function normalizeModel(raw) {
  const cleaned = String(raw ?? '')
    .replace(/\(.*?\)/g, ' ')
    .trim()
    .toUpperCase()
  const match = /(STM32[FHLGUWCB][0-9][0-9A-Z]{2,}[A-Z0-9]*|STC[0-9][0-9A-Z]*|GD32[A-Z0-9]+|CH32[A-Z0-9]+|HC32[A-Z0-9]+|ESP32[A-Z0-9-]*|AT89[A-Z0-9]*|ATMEGA[0-9A-Z]+|ATTINY[0-9A-Z]+|RP2040|RP2350|NRF[0-9A-Z]+|N76E[0-9A-Z]+)/.exec(cleaned)
  return match === null ? undefined : match[1].replace(/[^A-Z0-9]/g, '')
}

/** 两个型号是否指向同一颗（工程里常写 xx 或 Tx 占位，如 STM32F407VETx vs STM32F407VET6）。 */
export function modelMatches(left, right) {
  const a = normalizeModel(left)
  const b = normalizeModel(right)
  if (a === undefined || b === undefined) return false
  const length = Math.min(a.length, b.length, 11)
  if (length < 8) return a === b
  let same = 0
  for (let index = 0; index < length; index += 1) {
    const ca = a[index]
    const cb = b[index]
    if (ca === cb) {
      same += 1
      continue
    }
    const wildcard = ca === 'X' || cb === 'X'
    const numberWildcard = (ca === '0' || cb === '0') && index >= 9
    if (wildcard || numberWildcard) {
      same += 1
      continue
    }
    break
  }
  return same >= 8
}

function parseIoc(text, file, report) {
  const model = firstMatch(text, [[/^Mcu\.Name\s*=\s*(\S+)/m], [/^Mcu\.UserName\s*=\s*(\S+)/m], [/^ProjectManager\.DeviceId\s*=\s*(\S+)/m]])
  if (model !== undefined) report.add('device', file, model, 'CubeMX .ioc 里的器件名')
  const cpn = firstMatch(text, [[/^Mcu\.CPN\s*=\s*(\S+)/m]])
  if (cpn !== undefined) report.add('device', file, cpn, '.ioc 的订货号 CPN')
  const packageName = firstMatch(text, [[/^Mcu\.Package\s*=\s*(\S+)/m]])
  if (packageName !== undefined) report.add('package', file, packageName, '.ioc 封装')
  const hse = firstMatch(text, [[/^RCC\.HSE_VALUE\s*=\s*(\d+)/m], [/^Mcu\.HSE_VALUE\s*=\s*(\d+)/m]])
  if (hse !== undefined) report.add('clock', file, `HSE=${hse}Hz`, '.ioc 外部晶振')
  const lse = firstMatch(text, [[/^RCC\.LSE_VALUE\s*=\s*(\d+)/m], [/^RCC\.RTC\.LSE_VALUE\s*=\s*(\d+)/m]])
  if (lse !== undefined) report.add('clock', file, `LSE=${lse}Hz`, '.ioc 低速晶振')
  const pll = [firstMatch(text, [[/^RCC\.PLLM\s*=\s*(\d+)/m]]), firstMatch(text, [[/^RCC\.PLLN\s*=\s*(\d+)/m]]), firstMatch(text, [[/^RCC\.PLLP\s*=\s*(\d+)/m]])]
  if (pll.every((value) => value !== undefined)) report.add('clock', file, `PLLM=${pll[0]} PLLN=${pll[1]} PLLP=${pll[2]}`, '.ioc PLL 参数')
  const ips = [...text.matchAll(/^Mcu\.IP\d+\s*=\s*(\S+)/gm)].map((match) => match[1])
  const useful = ips.filter((name) => !['NVIC', 'RCC', 'SYS', 'GPIO'].includes(name))
  if (useful.length > 0) report.add('peripheral', file, useful.join(', '), '.ioc 启用的外设 IP')
  const board = firstMatch(text, [[/^board\s*=\s*(\S+)/m]])
  if (board !== undefined) report.add('board', file, board, '.ioc 板卡')
}

function parseUvprojx(text, file, report) {
  const device = firstMatch(text, [[/<Device>\s*([^<]+?)\s*<\/Device>/i]])
  if (device !== undefined) report.add('device', file, device, 'Keil 工程 Device 字段')
  const vendor = firstMatch(text, [[/<Vendor>\s*([^<]+?)\s*<\/Vendor>/i]])
  if (vendor !== undefined) report.add('vendor', file, vendor, 'Keil 工程 Vendor 字段')
  const target = firstMatch(text, [[/<TargetName>\s*([^<]+?)\s*<\/TargetName>/i]])
  if (target !== undefined) report.add('toolchain', file, `target=${target}`, 'Keil target 名')
  const cpu = firstMatch(text, [[/<Cpu>\s*([^<]+?)\s*<\/Cpu>/i]])
  if (cpu !== undefined) {
    report.add('toolchain', file, 'Keil MDK (uvprojx)', 'Keil 工程文件存在')
    const core = /CPUTYPE\("([^"]+)"\)/i.exec(cpu)
    if (core !== null) report.add('core', file, core[1], 'Keil Cpu CPUTYPE')
    const irom = /IROM\(0x[0-9a-f]+,\s*(0x[0-9a-f]+)\)/i.exec(cpu)
    if (irom !== null) report.add('memory', file, `IROM ${Math.round(Number.parseInt(irom[1], 16) / 1024)}KB`, 'Keil Cpu IROM 容量')
    const iram = /IRAM\(0x[0-9a-f]+,\s*(0x[0-9a-f]+)\)/i.exec(cpu)
    if (iram !== null) report.add('memory', file, `IRAM ${Math.round(Number.parseInt(iram[1], 16) / 1024)}KB`, 'Keil Cpu IRAM 容量')
    const clock = /CLOCK\((\d+)\)/i.exec(cpu)
    if (clock !== null) report.add('clock', file, `CLOCK=${clock[1]}Hz`, 'Keil Cpu CLOCK 外部时钟')
  }
  const defines = [...text.matchAll(/<Define>\s*([^<]*?)\s*<\/Define>/gi)].flatMap((match) => match[1].split(/[,;\s]+/)).filter(Boolean)
  if (defines.length > 0) report.add('define', file, [...new Set(defines)].slice(0, 12).join(' '), 'Keil 预处理宏')
  const includes = firstMatch(text, [[/<IncludePath>\s*([^<]+?)\s*<\/IncludePath>/i]])
  if (includes !== undefined) report.add('include', file, includes.slice(0, 300), 'Keil 头文件搜索路径')
}

function parseMakefile(text, file, report) {
  const device = firstMatch(text, [[/^\s*DEVICE\s*[:?]?=\s*(\S+)/m], [/^\s*MCU\s*[:?]?=\s*(\S+)/m]])
  if (device !== undefined) report.add('device', file, device, 'Makefile 的 DEVICE/MCU 变量')
  const defines = [...text.matchAll(/-D\s*([A-Za-z0-9_]+)/g)].map((match) => match[1])
  if (defines.length > 0) report.add('define', file, [...new Set(defines)].slice(0, 12).join(' '), 'Makefile 的 -D 宏')
  const ldscript = firstMatch(text, [[/^\s*LDSCRIPT\s*[:?]?=\s*(\S+)/m]])
  if (ldscript !== undefined) report.add('linker', file, ldscript, 'Makefile 链接脚本')
  if (/-mcpu=([^\s]+)/.test(text)) report.add('core', file, firstMatch(text, [[/-mcpu=([^\s]+)/]]), 'Makefile 的 -mcpu')
  report.add('toolchain', file, 'Makefile + GCC/arm-none-eabi', '存在 Makefile')
}

function parseCmake(text, file, report) {
  const mcu = firstMatch(text, [[/-mcpu=([^\s"')]+)/], [/STM32[A-Z0-9]+/]])
  if (mcu !== undefined) report.add('core', file, mcu, 'CMakeLists 的 MCU/-mcpu')
  report.add('toolchain', file, 'CMake + GCC', '存在 CMakeLists.txt')
}

function parseLinker(text, file, report) {
  const memory = /MEMORY\s*\{([\s\S]{0,600}?)\}/i.exec(text)
  if (memory !== null) {
    for (const line of memory[1].split('\n')) {
      const match = /(\w+)\s*\([^)]*\)\s*:\s*ORIGIN\s*=\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*LENGTH\s*=\s*(\d+)\s*([KMG]?)/i.exec(line)
      if (match !== null) report.add('memory', file, `${match[1]} ${match[3]}${match[4].toUpperCase()}B @ ${match[2]}`, '链接脚本 MEMORY 区')
    }
  }
  const stack = firstMatch(text, [[/_estack\s*=\s*(\S+)/]])
  if (stack !== undefined) report.add('memory', file, `_estack=${stack}`, '链接脚本栈顶')
  report.add('linker', file, basename(file), '存在链接脚本')
}

function parseStartup(text, file, report) {
  const match = /startup_(stm32[a-z0-9]+?)\.s$/i.exec(basename(file))
  if (match !== null) report.add('device', file, match[1].toUpperCase(), '启动文件名里的器件型号')
  const stack = firstMatch(text, [[/Stack_Size\s+EQU\s+(\S+)/i]])
  if (stack !== undefined) report.add('memory', file, `Stack_Size=${stack}`, '启动文件栈大小')
  const heap = firstMatch(text, [[/Heap_Size\s+EQU\s+(\S+)/i]])
  if (heap !== undefined) report.add('memory', file, `Heap_Size=${heap}`, '启动文件堆大小')
}

function parsePins(text, file, report) {
  const pins = new Map()
  for (const match of text.matchAll(/^#define\s+(\w+?)_?(Pin|PIN)\s+(GPIO_PIN_\d+)/gm)) pins.set(match[1], { pin: match[3] })
  for (const match of text.matchAll(/^#define\s+(\w+?)_?(GPIO_Port|PORT|Port)\s+(GPIO[A-Z])/gm)) {
    const entry = pins.get(match[1]) ?? {}
    entry.port = match[3]
    pins.set(match[1], entry)
  }
  for (const [label, entry] of pins.entries()) {
    if (entry.port === undefined || entry.pin === undefined) continue
    const number = entry.pin.replace('GPIO_PIN_', '')
    report.add('pin', file, `${label} → P${entry.port.replace('GPIO', '')}${number}`, '引脚宏定义')
  }
  // 正点原子风格位带宏：#define LED0 PBout(0) / #define KEY0 PEin(4)
  for (const match of text.matchAll(/^#define\s+(\w+)\s+P([A-K])(?:out|in)\s*\(\s*(\d+)\s*\)/gm)) {
    report.add('pin', file, `${match[1]} → P${match[2]}${match[3]}`, '位带引脚宏（Pxout/Pxin）')
  }
  // 简单风格：#define SCK PB13（只认 P + 端口字母 + 1~2 位数字，避免误伤）
  for (const match of text.matchAll(/^#define\s+([A-Z][A-Z0-9_]{1,20})\s+P([A-K])(\d{1,2})\s*(?:\/\/.*)?$/gm)) {
    report.add('pin', file, `${match[1]} → P${match[2]}${match[3]}`, '引脚宏定义')
  }
  // 初始化结构体配对：GPIO_Port = GPIOB 与同段的 GPIO_Pin = GPIO_Pin_13|GPIO_Pin_15
  for (const match of text.matchAll(/GPIO_Port\s*=\s*(GPIO[A-K])[\s\S]{0,300}?GPIO_Pin\s*=\s*([^;]{1,160});/g)) {
    const port = match[1].replace('GPIO', '')
    const numbers = [...match[2].matchAll(/GPIO_Pin_(\d+)/g)].map((item) => item[1])
    if (numbers.length > 0) report.add('pin', file, numbers.map((number) => `P${port}${number}`).join('、'), 'GPIO_Init 结构体（端口 + 引脚）')
  }
  // 源码注释里写清楚的引脚步表，如 "SCK=PB13  MOSI=PB15  DC=PC5"
  for (const match of text.matchAll(/([A-Z][A-Z0-9_]{1,14})\s*=\s*P([A-K])(\d{1,2})\b/g)) {
    report.add('pin', file, `${match[1]} → P${match[2]}${match[3]}`, '源码注释里记录的引脚')
  }
}

/** 外设设备宏（HAL/SPL 通用）。用前后非字母数字边界，所以 TIM3_Init、RCC_APB1Periph_TIM3 都能认出来。 */
const PERIPHERAL_MACRO = /(?<![A-Za-z0-9])(USART[1-6]|UART[4-8]|LPUART1|TIM[1-9][0-9]?|SPI[1-6]|I2C[1-3]|ADC[1-3]|DAC|CAN[12]?|SDIO|SDMMC[12]?|FSMC|FMC|LTDC|DCMI|ETH|USB_OTG_(?:FS|HS)|DMA[12](?:_Stream\d)?|RTC|IWDG|WWDG|CRC|RNG|SAI[12]|I2S[1-5]|QUADSPI|QSPI|COMP|OPAMP)(?![A-Za-z0-9])/g
const IRQ_HANDLER = /\b([A-Z][A-Z0-9_]{1,24}?)_IRQHandler\b/g
/** 只认真正的外设中断名：ST 模板里还有 PPP_IRQHandler 这种占位符，不能当证据。 */
const IRQ_PREFIX = /^(USART\d|UART\d|LPUART\d|TIM\d+|SPI\d|I2C\d|ADC\d?|CAN\d?|DMA\d(?:_Stream\d)?|EXTI\d*|SDIO|SDMMC\d|ETH|LTDC|DCMI|FSMC|FMC|RTC|IWDG|WWDG|CRC|RNG|SAI\d|I2S\d|QSPI|OTG_FS|OTG_HS|USB)/

/** 从用户代码里提取"实际用了哪些外设"：设备宏、RCC 时钟宏、中断服务函数名。 */
function parsePeripherals(text, file, report) {
  const found = new Set()
  for (const match of text.matchAll(PERIPHERAL_MACRO)) found.add(match[1])
  for (const match of text.matchAll(/\bRCC_(?:AHB1|AHB2|AHB3|APB1|APB2)Periph(?:_Reset)?_([A-Z][A-Za-z0-9_]*)/g)) {
    if (/^GPIO/.test(match[1])) continue
    found.add(match[1])
  }
  for (const match of text.matchAll(IRQ_HANDLER)) {
    if (IRQ_PREFIX.test(match[1])) found.add(`${match[1]} IRQ`)
  }
  if (found.size > 0) report.add('peripheral', file, [...found].sort().slice(0, 20).join('、'), '设备宏 / RCC 时钟宏 / 中断服务函数')
  const ports = [...text.matchAll(/\bGPIO([A-K])\b/g)].map((match) => `GPIO${match[1]}`)
  if (ports.length > 0) report.add('port', file, [...new Set(ports)].sort().slice(0, 12).join('、'), '源码里用到的 GPIO 端口')
}

/** 用户代码头部注释里常写着 MCU/库/工具链/主频/板卡，这些是最高价值的"具体信息"。 */
function parseDocFacts(text, file, report) {
  const head = text.slice(0, 8000)
  const device = /(?:^|\n)\s*[*#\/\s]*MCU\s*[:：]\s*([^\n*（(]{2,80})/i.exec(head)
  if (device !== null) report.add('device', file, device[1].trim(), '源码注释里写明的 MCU')
  const library = /(?:^|\n)\s*[*#\/\s]*(?:固件库|库|Library)\s*[:：]\s*([^\n*（(]{2,40})/i.exec(head)
  if (library !== null) report.add('library', file, library[1].trim(), '源码注释里写明的固件库')
  const toolchain = /(?:^|\n)\s*[*#\/\s]*(?:工具链|Toolchain|IDE)\s*[:：]\s*([^\n*（(]{2,40})/i.exec(head)
  if (toolchain !== null) report.add('toolchain', file, toolchain[1].trim(), '源码注释里写明的工具链')
  const clock = /(?:主频|系统时钟|SYSCLK)\s*[:：=]?\s*(\d{2,3})\s*M(?:Hz)?/i.exec(head)
  if (clock !== null) report.add('clock', file, `${clock[1]}MHz`, '源码注释里写明的主频')
  const board = /(?:^|\n)\s*[*#\/\s]*(?:开发板|板卡|Board)\s*[:：]\s*([^\n*（(]{2,40})/i.exec(head)
  if (board !== null) report.add('board', file, board[1].trim(), '源码注释里写明的板卡')
}

function parseSource(text, file, report) {
  const handles = [...text.matchAll(/\b(?:UART|USART|TIM|SPI|I2C|ADC|DAC|CAN|SD|SDMMC|ETH|I2S|DMA|CRC|RNG|RTC|IWDG|WWDG|QSPI|QUADSPI|LTDC|FMC|FSMC|USB|COMP|OPAMP|SAI)_HandleTypeDef\s+\*?\s*(h[a-z0-9_]+)/g)].map((match) => match[1])
  if (handles.length > 0) report.add('peripheral', file, [...new Set(handles)].slice(0, 16).join(', '), '外设句柄变量（HAL）')
  const inits = [...text.matchAll(/\bMX_([A-Za-z0-9_]+?)_Init\s*\(/g)].map((match) => match[1]).filter((name) => name !== 'GPIO')
  if (inits.length > 0) report.add('peripheral', file, [...new Set(inits)].slice(0, 16).join(', '), 'CubeMX 外设初始化函数')
  const splInits = [...text.matchAll(/\b[A-Z][A-Za-z0-9_]{1,20}_Init\s*\(\s*(USART[1-6]|UART[4-8]|TIM[1-9][0-9]?|SPI[1-6]|I2C[1-3]|ADC[1-3]|CAN[12]?|DMA[12](?:_Stream\d)?|SDIO|FSMC|LTDC|DCMI|ETH)/g)].map((match) => match[1])
  if (splInits.length > 0) report.add('peripheral', file, [...new Set(splInits)].sort().slice(0, 16).join('、'), '标准库外设初始化调用')
  parsePeripherals(text, file, report)
  const pll = [firstMatch(text, [[/\.PLLM\s*=\s*(\d+)/]]), firstMatch(text, [[/\.PLLN\s*=\s*(\d+)/]]), firstMatch(text, [[/\.PLLP\s*=\s*(\w+)/]])]
  if (pll.every((value) => value !== undefined)) report.add('clock', file, `PLLM=${pll[0]} PLLN=${pll[1]} PLLP=${pll[2]}`, 'SystemClock_Config 的 PLL 参数')
  const splPll = /RCC_PLLConfig\s*\(\s*([A-Za-z0-9_]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(text)
  if (splPll !== null) report.add('clock', file, `RCC_PLLConfig(${splPll[1]}, M=${splPll[2]}, N=${splPll[3]}, P=${splPll[4]})`, '标准库 PLL 配置')
  const hse = firstMatch(text, [[/\.HSEState\s*=\s*RCC_HSE_(\w+)/], [/RCC_HSEConfig\s*\(\s*RCC_HSE_(\w+)/]])
  if (hse !== undefined) report.add('clock', file, `HSE ${hse}`, 'HSE 配置')
  parsePins(text, file, report)
  parseDocFacts(text, file, report)
}

/** 用户自己的板级头文件：引脚宏 + 注释里的说明 + 用到哪些外设。 */
function parseUserHeader(text, file, report) {
  parsePins(text, file, report)
  parsePeripherals(text, file, report)
  parseDocFacts(text, file, report)
}

function parseHeaderForLibrary(text, file, report) {
  if (/stm32[a-z0-9]*_hal\.h$/i.test(basename(file))) report.add('library', file, 'HAL 库', '存在 HAL 头文件')
  if (/stm32[a-z0-9]*_ll_[a-z0-9_]+\.h$/i.test(basename(file))) report.add('library', file, 'LL 库', '存在 LL 头文件')
  if (/stm32[a-z0-9]*(xx)?_conf\.h$/i.test(basename(file)) && !/_hal_/i.test(basename(file))) report.add('library', file, '标准外设库 SPL', '存在 stm32fXxx_conf.h')
  if (/stm32[a-z0-9]+\.h$/i.test(basename(file)) && !/_hal|_ll/.test(basename(file))) report.add('device', file, basename(file).replace(/\.h$/i, '').toUpperCase(), '器件头文件名')
  if (/USE_STDPERIPH_DRIVER/.test(text)) report.add('library', file, '标准外设库 SPL（USE_STDPERIPH_DRIVER）', '预处理宏')
  if (/USE_HAL_DRIVER/.test(text)) report.add('library', file, 'HAL 库（USE_HAL_DRIVER）', '预处理宏')
}

const PARSERS = {
  ioc: parseIoc,
  uvprojx: parseUvprojx,
  makefile: parseMakefile,
  cmake: parseCmake,
  linker: parseLinker,
  startup: parseStartup,
  userheader: parseUserHeader,
  source: parseSource,
  header: parseHeaderForLibrary,
  platformio: (text, file, report) => {
    const board = firstMatch(text, [[/^\s*board\s*=\s*(\S+)/m]])
    if (board !== undefined) report.add('board', file, board, 'platformio.ini 的 board')
    const platform = firstMatch(text, [[/^\s*platform\s*=\s*(\S+)/m]])
    if (platform !== undefined) report.add('toolchain', file, `PlatformIO ${platform}`, 'platformio.ini 的 platform')
    if (/FreeRTOS/i.test(text)) report.add('rtos', file, 'FreeRTOS', 'platformio.ini 依赖')
  },
  freertos: (text, file, report) => {
    report.add('rtos', file, 'FreeRTOS', '存在 FreeRTOSConfig.h')
    const tick = firstMatch(text, [[/#define\s+configTICK_RATE_HZ\s+\(?\s*(\d+)/]])
    if (tick !== undefined) report.add('rtos', file, `configTICK_RATE_HZ=${tick}`, 'FreeRTOS 时基')
    const heap = firstMatch(text, [[/#define\s+configTOTAL_HEAP_SIZE\s+\(?\s*\(?\s*(\d+)/]])
    if (heap !== undefined) report.add('rtos', file, `configTOTAL_HEAP_SIZE=${heap}`, 'FreeRTOS 堆大小')
  },
}

function* walk(root, limits) {
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift()
    visited += 1
    if (visited > limits.maxDirs) return
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
        yield { kind: 'dir', path: full, name: entry.name, depth: current.depth }
        if (current.depth + 1 <= limits.maxDepth) queue.push({ dir: full, depth: current.depth + 1 })
      } else if (entry.isFile()) {
        yield { kind: 'file', path: full, name: entry.name, depth: current.depth }
      }
    }
  }
}

/**
 * 扫描一个工程目录。
 * @param root - 工程根目录（绝对路径）。
 * @param options - 可选的规模上限（系统提示里的廉价探测会调小它）。
 * @returns 扫描报告：证据、推断、候选型号、未知项。
 */
export function scanProject(root, options = {}) {
  const limits = {
    maxDepth: Number.isFinite(options.maxDepth) ? Number(options.maxDepth) : MAX_DEPTH,
    maxDirs: Number.isFinite(options.maxDirs) ? Number(options.maxDirs) : MAX_DIRS,
    maxNameHits: Number.isFinite(options.maxNameHits) ? Number(options.maxNameHits) : MAX_NAME_HITS,
    maxContentFiles: Number.isFinite(options.maxContentFiles) ? Number(options.maxContentFiles) : MAX_CONTENT_FILES,
  }
  const report = {
    root,
    scannedAt: new Date().toISOString(),
    fileCount: 0,
    truncated: false,
    evidence: [],
    inferences: { device: [], toolchain: [], library: [], rtos: [], peripheral: [], port: [], pin: [], memory: [], clock: [], board: [], vendor: [], core: [], define: [], linker: [], include: [], package: [] },
    notes: [],
  }
  const seenEvidence = new Set()
  const add = (kind, file, value, note) => {
    if (value === undefined || value === null) return
    const text = String(value).trim()
    if (text === '') return
    const key = `${kind}|${relative(root, file)}|${text}`
    if (seenEvidence.has(key)) return
    seenEvidence.add(key)
    if (!Array.isArray(report.inferences[kind])) report.inferences[kind] = []
    report.inferences[kind].push(text)
    report.evidence.push({ kind, file: relative(root, file), value: text, note })
  }
  const facade = { add }

  let contentFiles = 0
  const contentCandidates = []
  for (const entry of walk(root, limits)) {
    if (entry.kind === 'dir') {
      const lower = entry.name.toLowerCase()
      if (lower === 'freertos' || lower === 'rtos') add('rtos', join(entry.path, '.'), 'FreeRTOS/RTOS 目录', '工程里存在 RTOS 目录')
      if (['libraries', 'library', 'drivers', 'hardware', 'bsp', 'user', 'core'].includes(lower) && entry.depth === 0) {
        report.notes.push(`发现常用目录 ${entry.name}/`)
      }
      continue
    }
    report.fileCount += 1
    if (report.fileCount > limits.maxNameHits * 6) {
      report.truncated = true
      break
    }
    const probe = NAME_PROBES.find((item) => item.test(entry.name))
    if (probe === undefined) continue
    const isLibraryFile = LIBRARY_PATH.test(entry.path) || LIBRARY_FILE.test(entry.name)
    if (probe.kind === 'source' || probe.kind === 'userheader') {
      contentCandidates.push({ ...entry, kind: probe.kind, library: isLibraryFile })
      continue
    }
    const text = readText(entry.path)
    if (text === undefined) continue
    contentFiles += 1
    try {
      PARSERS[probe.kind](text, entry.path, facade)
    } catch (error) {
      report.notes.push(`${relative(root, entry.path)} 解析失败：${error.message}`)
    }
  }

  // 源文件按"更像用户代码"排序后再读，优先 Core/Src、User、Hardware、main.c。
  const priority = (path) => {
    const lower = path.toLowerCase().replace(/\\/g, '/')
    if (/\/system\/|\/hardware\/|\/user\/|\/core\/src\/|\/bsp\/|\/app\//.test(lower)) return 0
    if (/main\.[ch]$/.test(lower) || /\/src\/|\/inc\//.test(lower)) return 1
    if (LIBRARY_PATH.test(path)) return 3
    return 2
  }
  contentCandidates.sort((left, right) => priority(left.path) - priority(right.path))
  for (const entry of contentCandidates) {
    if (contentFiles >= limits.maxContentFiles) {
      report.truncated = true
      break
    }
    const text = readText(entry.path)
    if (text === undefined) continue
    contentFiles += 1
    try {
      // 厂商库/驱动目录里的文件只用来判定库类型：它们的源码会引用所有外设，
      // 拿来统计"这个工程用了什么"只会污染结论。
      PARSERS[entry.library === true ? 'header' : entry.kind](text, entry.path, facade)
    } catch (error) {
      report.notes.push(`${relative(root, entry.path)} 解析失败：${error.message}`)
    }
  }

  // ── 归并推断 ──────────────────────────────────────────────────────────────
  // 型号候选要按"具体程度"排序：器件头文件名只能给出 STM32F4XX 这种系列级线索，
  // 而 .uvprojx/.ioc 给的是 STM32F407VETx 这种可下单的型号，后者优先。
  /** 型号候选按"具体程度"排序：CMSIS 器件宏（STM32F103xB）不是可下单的型号，要排最后。 */
  const scoreModel = (model) => {
    const body = model.startsWith('STM32') ? model.slice(5 + 1) : undefined
    if (body !== undefined && model.includes('X') && !model.endsWith('X')) return 1
    if (/^STM32[FHLGUWCB]\d{3}[A-Z0-9]{4}$/.test(model)) return 4
    if (/^STM32[FHLGUWCB]\d{3}[A-Z0-9]{2,3}$/.test(model)) return 3
    if (/(XX|X{1,2})$/.test(model)) return 0
    return 2
  }
  const modelCandidates = []
  for (const value of [...report.inferences.device, ...report.inferences.define, ...report.inferences.core]) {
    const model = normalizeModel(value)
    if (model !== undefined && !modelCandidates.includes(model)) modelCandidates.push(model)
  }
  modelCandidates.sort((left, right) => scoreModel(right) - scoreModel(left))
  const primary = modelCandidates[0]
  const vendorRule = primary === undefined ? undefined : VENDOR_RULES.find(([pattern]) => pattern.test(primary))
  const coreRule = primary === undefined ? undefined : CORE_RULES.find(([pattern]) => pattern.test(primary))
  const has = (kind) => report.inferences[kind].length > 0
  const library = has('library')
    ? [...new Set(report.inferences.library.map((value) => (/HAL/.test(value) ? 'HAL' : /LL/.test(value) ? 'LL' : /SPL|STDPERIPH/.test(value) ? 'SPL' : value)))].join(' + ')
    : report.inferences.linker.length > 0 || report.inferences.toolchain.length > 0
      ? '未识别（可能是寄存器直写或自带头文件）'
      : '未知'
  const toolchains = [...new Set(report.inferences.toolchain.map((value) => {
    if (/Keil|uvprojx|target=/.test(value)) return 'Keil MDK'
    if (/PlatformIO/.test(value)) return 'PlatformIO'
    if (/CMake/.test(value)) return 'CMake + GCC'
    if (/Makefile/.test(value)) return 'Makefile + GCC'
    return value
  }))]

  const inferred = {
    model: primary ?? undefined,
    modelCandidates,
    vendor: vendorRule?.[1],
    family: primary === undefined ? undefined : (/^(STM32[FHLGUWCB]\d)/.exec(primary)?.[1] ?? undefined),
    core: coreRule?.[1] ?? (report.inferences.core.length > 0 ? report.inferences.core[0] : undefined),
    toolchain: toolchains.join(' / ') || undefined,
    library,
    rtos: has('rtos') ? [...new Set(report.inferences.rtos)] : [],
    peripherals: [...new Set(report.inferences.peripheral.flatMap((value) => value.split(/[,、]\s*/).map((item) => item.trim()).filter(Boolean)))].slice(0, 30),
    ports: [...new Set(report.inferences.port.flatMap((value) => value.split(/[,、]\s*/).map((item) => item.trim()).filter(Boolean)))].slice(0, 12),
    pins: [...new Set(report.inferences.pin.map((value) => (value.includes(' → ') ? value.split(' → ')[1] : value)))].slice(0, 40),
    memory: [...new Set(report.inferences.memory)].slice(0, 8),
    clock: [...new Set(report.inferences.clock)].slice(0, 8),
    board: [...new Set(report.inferences.board)].slice(0, 4),
  }

  const signals = [inferred.model !== undefined, toolchains.length > 0, inferred.library !== '未知', inferred.peripherals.length > 0]
  const strength = signals.filter(Boolean).length
  const confidence = inferred.model === undefined ? 'low' : strength >= 3 ? 'high' : strength === 2 ? 'medium' : 'low'
  const unknowns = []
  if (inferred.model === undefined) unknowns.push('没有在工程里找到器件型号（.ioc / *.uvprojx / startup_*.s / Makefile DEVICE / 器件头文件名都没有）')
  if (toolchains.length === 0) unknowns.push('没有找到构建工程文件（.uvprojx / .cproject / Makefile / CMakeLists.txt / platformio.ini）')
  if (inferred.library === '未知') unknowns.push('没有识别出固件库类型（HAL / SPL / LL）')
  if (report.truncated) unknowns.push('工程较大或文件过深，扫描被截断，可能漏掉证据')

  return { ...report, inferred, confidence, unknowns }
}

/** 把扫描报告渲染成人读的 Markdown（模型会把它贴给用户，也是工具卡的正文）。 */
export function renderScanReport(result) {
  const lines = [`工程目录：${result.root}`, `扫描到 ${result.fileCount} 个文件，证据 ${result.evidence.length} 条，置信度：${result.confidence}`]
  const inferred = result.inferred
  lines.push('', '推断结论：')
  lines.push(`- 型号：${inferred.model ?? '未识别'}${inferred.modelCandidates.length > 1 ? `（候选：${inferred.modelCandidates.join('、')}）` : ''}`)
  if (inferred.vendor !== undefined) lines.push(`- 厂商：${inferred.vendor}`)
  if (inferred.core !== undefined) lines.push(`- 内核：${inferred.core}`)
  if (inferred.toolchain !== undefined) lines.push(`- 工具链：${inferred.toolchain}`)
  lines.push(`- 固件库：${inferred.library}`)
  if (inferred.rtos.length > 0) lines.push(`- RTOS：${inferred.rtos.join('、')}`)
  if (inferred.peripherals.length > 0) lines.push(`- 外设：${inferred.peripherals.join('、')}`)
  if (Array.isArray(inferred.ports) && inferred.ports.length > 0) lines.push(`- 端口：${inferred.ports.join('、')}`)
  if (inferred.pins.length > 0) lines.push(`- 引脚：${inferred.pins.join('、')}`)
  if (inferred.clock.length > 0) lines.push(`- 时钟：${inferred.clock.join('；')}`)
  if (inferred.memory.length > 0) lines.push(`- 存储：${inferred.memory.join('；')}`)
  lines.push('', '依据（文件 → 关键值）：')
  const byFile = new Map()
  for (const item of result.evidence) {
    const list = byFile.get(item.file) ?? []
    list.push(item)
    byFile.set(item.file, list)
  }
  for (const [file, items] of [...byFile.entries()].slice(0, 20)) {
    lines.push(`- ${file}`)
    for (const item of items.slice(0, 8)) lines.push(`    · [${item.kind}] ${item.value}${item.note === undefined ? '' : `　(${item.note})`}`)
  }
  if (result.unknowns.length > 0) lines.push('', `没能确认：`, ...result.unknowns.map((item) => `- ${item}`))
  return lines.join('\n')
}
