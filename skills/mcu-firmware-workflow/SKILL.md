---
name: mcu-firmware-workflow
description: 单片机固件开发的固定流程：先 mcu_scan 扫出工程里的型号/工具链/库/外设/引脚并把证据摊给用户，再补全绑定、勘察代码、改动、构建烧录、把结论写进使用档案。用于「写/改单片机固件」「看下我的工程」「这个板子用的什么芯片」「加一个外设」「驱动调不通」「换型号」「这个板子怎么跑起来」等请求，也用于不确定该从哪下手时。
whenToUse: 任何涉及单片机代码、外设、时钟、引脚、烧录、调试、或需要了解某个单片机工程的请求开始之前。
---

# 单片机固件开发流程

这个模式的核心纪律是：**先扫出工程的真实信息、把证据摊开给用户看，再动手**。所以每一个单片机任务都按下面六步走，不跳步。

## 1. 扫描工程，把证据摆出来（第一步，先于一切）

调用 `mcu_scan`（不带参数 = 扫当前工作区；工程在别处就传 `path`）。它用确定性扫描器把下面这些**连依据一起**列出来：

- 型号：`.ioc` 的 `Mcu.Name` / `ProjectManager.DeviceId`、`*.uvprojx` 的 `<Device>`、`startup_*.s` 文件名、Makefile 的 `DEVICE`、源码注释里的 `MCU :`
- 工具链：`.uvprojx` → Keil MDK；`.cproject` → CubeIDE；`Makefile`/`CMakeLists.txt` → GCC；`platformio.ini` → PlatformIO
- 固件库：HAL / SPL（`stm32fXxx_conf.h`、`USE_STDPERIPH_DRIVER`）/ LL / 寄存器直写
- 外设与端口：设备宏（`USART1`、`TIM3`、`SPI2`…）、`RCC_APBxPeriph_*`、`XXX_IRQHandler`、`MX_*_Init`
- 引脚：`GPIO_Pin` + `GPIO_Port` 配对、`PBout(0)`/`PEin(4)` 位带宏、`#define SCK PB13`、注释里的 `SCK=PB13`
- 时钟与存储：HSE / Keil `CLOCK`、`RCC_PLLConfig`、IROM/IRAM、链接脚本 MEMORY、Stack/Heap

**扫到明确型号时它会自动绑定本会话**（不需要你先 `mcu_bind`）。然后你必须把这张表贴给用户：型号、工具链、固件库、外设、端口、引脚各一行，每条跟上"哪个文件 → 什么值"。用户要的就是这些具体信息——只回一句"看起来是 STM32"等于没做。

扫不出来时才问用户（`ask_user_question`，候选里带 `mcu_list` 的已有型号）。如果返回里 `mismatch: true`（工程型号和本会话绑定不一致），**先跟用户确认**是换型号、工程里有多套配置、还是之前绑错了，不要闷头按绑定改。

## 2. 补全绑定，再勘察代码（改代码之前）

1. `mcu_scan` 只带了型号/工具链/外设/引脚，工程名和"本会话要做什么功能"由你补：`mcu_bind`（同型号再调一次是更新，不会重复计数）。
2. 再看目录结构与构建入口：`glob` / `grep` / `read`。判断固件风格并沿用：HAL(`MX_*_Init` + `HAL_*`)、LL、标准库(`stm32f4xx_*` + `_conf.h`)、寄存器直写、RTOS(FreeRTOS/CMSIS-RTOS)。
3. 新代码跟着既有命名走（`huart1`/`htim3` 或 `USART1_Init`），弄清中断与轮询的分工、`main` 循环、标志位用法。
4. 涉及引脚/外设前核对**这颗型号上确实有**该实例（F103C8 无 DAC、F411 无 DAC/EEPROM、H750 只有 128KB Flash），不确定就查手册或器件头文件，别按别的型号的记忆写。

## 3. 改动

- 最小改动：只碰必要的文件；新增外设时按工程既有方式（CubeMX 重新生成 / 手写初始化）二选一并说清。
- 中断优先级、volatile、共享变量、`__weak` 回调、`HAL_*_Callback` 与用户函数的挂接点要交代清楚。
- 涉及 Flash 读写、看门狗、时钟切换、低功耗、BOOT/启动模式的改动，先说明风险与回退办法。

## 4. 构建 / 烧录 / 调试

具体命令见 `stm32-toolchain` skill。要求：

- 给出**可复制**的完整命令（含路径、target、配置名），并说明成功/失败的判断依据（返回码、日志关键字、"Download verified successfully"）。
- 输出真实执行结果，不要凭经验说"应该能过"。
- 编译不过时按报错原文定位（头文件路径、宏开关、链接脚本、`-mcpu` 不匹配），不要靠猜改代码。

## 5. 记录（做完必须做）

调用 `mcu_note` 写一条，`kind` 按性质选：`feature` / `peripheral` / `driver` / `protocol` / `pitfall` / `debug` / `build` / `other`。

好的记录长这样：

```
[peripheral] TIM3_CH1(PA6) PWM 20kHz 驱动 MOS，ARR=999 PSC=3 @72MHz，已示波器验证占空比线性
[pitfall] F103 的 PA15/PB3/PB4 默认是 JTAG 复用，做普通 GPIO 前要开 AFIO 时钟并 JTAGRemap(SWJ)
[build] Keil: UV4.exe -b MDK-ARM/board.uvprojx -j0 -o build.log；烧录用 STM32_Programmer_CLI -c port=SWD -w build/board.hex -v -rst
```

差记录：`改好了`、`编译通过`——没有型号、没有实例、没有参数，下次等于没记。

## 6. 收尾

- 告诉用户本会话用的是哪颗型号（一行），以及档案文件路径（`$DSH_HOME/mcu/REGISTRY.md`）。
- 换型号（用户换了板子、或发现一开始认错型号）时立刻 `mcu_bind` 更新，并在回答里说明绑定已更新——后续结论按新型号走。
- 之后每次回答涉及型号/引脚/外设，都要能指回工程里的具体文件与值；工程里没有依据的，直接说"工程里没有找到"。
