---
name: stm32-toolchain
description: STM32 工程在 Keil MDK5 与 STM32CubeIDE / CubeMX + GCC 下的命令行构建、烧录、调试与串口监视，以及常见下载/运行故障的排查顺序。用于「怎么编译」「怎么烧录」「Keil 报错」「CubeMX 生成代码」「下载失败/下载后不运行」「串口没输出」等请求。
whenToUse: 需要构建、烧录、连接调试器或看串口日志时；或编译/下载阶段出错需要定位时。
---

# STM32 工具链（Keil MDK5 与 STM32CubeIDE + GCC）

先认工程类型，再选命令——不要用 CubeIDE 的方式去构建 Keil 工程。

| 工程特征 | 工具链 | 构建入口 |
|---|---|---|
| `*.uvprojx` / `*.uvproj` | Keil MDK5（ARMCC/ARMCLANG） | `UV4.exe` |
| `.project` + `.cproject`（+ `.ioc`） | STM32CubeIDE（GCC） | headlessbuild 或 IDE 内构建 |
| `Makefile` / `CMakeLists.txt` + `*.ld` | GCC（CubeMX 的 Makefile 工程 / CMake） | `make` / `cmake` |
| `platformio.ini` | PlatformIO | `pio run` |

## 路径先确认

下面的可执行文件名是标准名，但**安装路径因机器而异**，第一次用先在 shell 里确认（`Get-Command`、`where.exe` 或直接看安装目录），把真实路径写进命令。

- Keil：`C:\Keil_v5\UV4\UV4.exe`
- STM32CubeIDE：`...\STM32CubeIDE\stm32cubeidec.exe`（headless）与 `stm32cubeide.exe`
- STM32CubeProgrammer CLI：`...\STMicroelectronics\STM32Cube\STM32CubeProgrammer\bin\STM32_Programmer_CLI.exe`
- OpenOCD / pyocd：随 CubeIDE 或独立安装；`openocd.exe`、`pyocd.exe`

## 构建

**Keil（命令行）**

```powershell
& "C:\Keil_v5\UV4\UV4.exe" -b "MDK-ARM\board.uvprojx" -j0 -o build.log   # 增量构建
& "C:\Keil_v5\UV4\UV4.exe" -r "MDK-ARM\board.uvprojx" -j0 -o build.log   # 全量重建
& "C:\Keil_v5\UV4\UV4.exe" -c "MDK-ARM\board.uvprojx"                    # 清理
```

- `-b` 构建、`-r` 重建、`-c` 清理；`-t <target>` 指定 target；`-j0` 不回显（结果看 `build.log`）。
- 返回码：`0` 无错无警、`1` 有警告、`≥2` 有错误。要看 `build.log` 末尾的 `0 Error(s), N Warning(s)`。

**STM32CubeIDE（headless）**

```powershell
& "C:\ST\STM32CubeIDE_1.x\STM32CubeIDE\stm32cubeidec.exe" --launcher.suppressErrors -nosplash `
  -application org.eclipse.cdt.managedbuilder.core.headlessbuild `
  -data "C:\ws" -import "C:\ws\board" -cleanBuild "board/Debug"
```

`-import` 只在首次需要，之后用 `-build board/Debug` / `-cleanBuild board/Debug`。构建日志在工作区的 `.metadata\.log` 与工程 `Debug/` 下。

**GCC（CubeMX Makefile 工程）**

```powershell
make -j8            # 或 make -j8 DEBUG=1
```

**CMake 工程**

```powershell
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
```

## 烧录与复位

**STM32CubeProgrammer CLI（推荐，ST-Link 官方）**

```powershell
& "STM32_Programmer_CLI.exe" -c port=SWD -w "build\board.hex" -v -rst
& "STM32_Programmer_CLI.exe" -c port=SWD -e all          # 全片擦除（慎用，会清选项字节）
& "STM32_Programmer_CLI.exe" -c port=SWD -r0 0x08000000 8 # 读 8 字节验证
```

**OpenOCD**

```powershell
openocd -f interface/stlink.cfg -f target/stm32f1x.cfg -c "program build/board.elf verify reset exit"
```

target 配置按系列选：`stm32f1x.cfg` / `stm32f4x.cfg` / `stm32h7x.cfg`。

**pyocd**

```powershell
pyocd flash -t stm32f103c8 build/board.hex
```

成功的标志是 `Download verified successfully` / `** Verified OK **`，并且复位后能看到串口输出。

## 串口监视

```powershell
python -m serial.tools.miniterm COM5 115200       # 需要 pyserial
```

或 `mode COM5:115200,n,8,1` 后配合终端工具；看日志优先用能保存到文件的方式，便于 grep。

## 下载/运行故障的排查顺序

1. **认不到芯片**：ST-Link 驱动（WinUSB vs ST-Link 驱动）、SWDIO/SWCLK/GND/3V3 接线、目标板是否独立供电、SWD 引脚被固件复用成 GPIO（先按住 NRST 再 connect，或改 `connect under reset`）。
2. **能连但下载失败**：读保护/写保护（解除：`-c port=SWD -ob RDP=0xAA` 后全擦）、Flash 被选项字节锁、供电不足、时钟太高（降 SWD 频率）。
3. **下载成功但不运行**：BOOT0 被拉高（进了系统 bootloader）、复位脚被外设拉低、时钟配置与实际晶振不符（HSE 起振失败会卡在 `HAL_RCC_OscConfig`）、中断向量表偏移（`SCB->VTOR` / `VECT_TAB_OFFSET`）、链接脚本地址与 Flash 起点不一致。
4. **卡死/跑飞**：先看 `HardFault` 现场——`CFSR`/`HFSR`/`BFAR`/`MMFAR` 与压栈的 PC/LR；常见原因是野指针、栈溢出（任务栈/中断嵌套）、访问未使能时钟的外设寄存器、除零（未开 FPU 时浮点运算）。
5. **串口无输出**：TX/RX 是否交叉、GPIO 复用与时钟、波特率（HSE 值配错会导致波特率误差大）、`printf` 重定向（`fputc`/`_write` 是否实现）、半主机模式没关（`microlib` / `__use_no_semihosting`）。
6. **FreeRTOS 下 `HAL_Delay` 卡死**：SysTick 与 RTOS 时基冲突，改用 `osDelay`，并把 HAL 时基换到别的 TIM。
7. **改完 Flash 相关代码后行为异常**：看门狗没喂、擦写期间被中断打断、写保护区域。

## 记录要求

每次成功打通一条构建/烧录/调试链路，调用 `mcu_note(kind="build")` 记下：工程路径、完整命令、参数含义、成功判据、踩到的坑。下次同型号就不用再试一遍。
