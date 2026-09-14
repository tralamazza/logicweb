# 交接文档：32U3 采集、软件触发与传输层优化

> **2026-09-14 增补（接手修复轮）**：在本文档描述的 5 个提交之上又做了一轮缺陷修复，
> 见文末「10. 接手修复轮（2026-09-14）」。原第 6 节的"次要观察"第 2 条所描述的
> 触发模式投递路径中，实际存在两个用户可见的缺陷，已修复并有回归测试。

## 1. 概览

本分支把此前 66 个迭代提交按功能重写为 5 个关键提交，只改变提交粒度，代码与文档内容不变。
相对 `origin/main` 的改动规模为 57 个文件、+9231 / -703。

**尚未推送**。历史已重写，推送需要 `git push --force-with-lease origin main`。

## 2. 提交结构（`origin/main..HEAD`）

顺序按依赖排列，每个提交都独立通过 `tsc --noEmit`，可直接用于 `git bisect`。

| 提交 | 标题 | 文件数 | 增/删 |
| --- | --- | --- | --- |
| `d130d46` | feat(data): bounded software trigger and 4..128-channel sample stores | 12 | +883 / -61 |
| `27a7974` | feat(device): stream 32U3 over WebUSB from a dedicated worker | 16 | +6963 / -474 |
| `a950f65` | feat(ui): inline AND trigger, capture controls and sample-aware rendering | 18 | +818 / -95 |
| `01f5e17` | feat(dist): ship a portable single-file decoder build | 8 | +482 / -55 |
| `6be55f7` | docs: record the 32U3 protocol, architecture and status | 3 | +85 / -18 |

分组原则：按架构层而非时间线切分，同一功能的反复修补合并为一个提交。各模块的 `NOTES.md`
随所属代码提交一起移动，`docs/` 与 `status.json` 单独作为文档提交。

## 3. 各提交要点

### `d130d46` feat(data) — 触发与存储

- 新增 `src/data/softwareTrigger.ts`：同步、有界的软件触发状态机。
  - 条件类型 `level` / `rising` / `falling` / `edge`，多条件为同一个完整样本上的逻辑 AND。
  - `feed()` 接受任意传输片段，用一个至多 `bytesPerSample - 1` 字节的 `partial` 把跨 USB 边界的
    样本补全后再匹配；这正是"触发匹配必须作用于完整样本"的落点。
  - 等待期只持有一个预触发环形缓冲，上界为
    `min(preTriggerSamples, maxSamples - 1, MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / bytesPerSample)`，
    `MAX_SOFTWARE_TRIGGER_PREFIX_BYTES = 64 MiB`，不存在无界的搜索前缀。
  - 命中时以最多两次连续 `slice` 吐出环形缓冲，再输出触发样本与后触发样本，总数封顶于 `maxSamples`。
  - `finish()` 只重置环形索引后标记 `noTrigger`，不产生拷贝；`resetContinuity()` / `noteGap()`
    用于传输断流，禁止跨 gap 的边沿匹配。
- 新增 `src/data/softwareTriggerSelftest.ts`：8 项确定性用例，含三种边沿加 level 跨传输边界、
  no-trigger 有界丢弃、预算边界保留、自动停止有界、无限等待滚动。
- 存储层：`interleavedStore.ts`（原生 32 位小端字）、`planarStore.ts`、`rleStore.ts` 覆盖
  4/8/16/32/64/128 通道；`gaps.ts`、`types.ts`、`index.ts` 相应扩展；`src/types.ts` 增加
  `bytesPerSampleForChannels` / `isChannelCount` 等共享谓词。

### `27a7974` feat(device) — 设备协议与流式传输

- `src/device/protocol.ts`：寄存器级协议。`R32_CTRL` 用读 → 写 → 读校验（厂商 spec 的读回
  不可全信，见 NOTES 8.11）；`RB_FLAG_FIFO_OV` 以 write-1-to-clear 清除而不是相信 reset；
  `R32_SAMPLE_LEN`（单位 1024 样本、固定偏移 2048）让设备在捕获长度处自行停止。
- `src/device/slogic16u3.ts`：采集主循环。
  - 16U3/32U3 字节打包与每样本字节数；`< 8` 通道走 `expandPacked`，`>= 8` 通道按
    `bytesPerSampleForChannels` 对齐，并用 `sampleCarry` 保留不足一个样本的尾部。
  - 队列受 `MAX_SAFE_QUEUED_BYTES = LIBSIGROK_TRANSFER_BYTES * LIBSIGROK_TRANSFER_DEPTH`
    约束，调用方也可用 `queueBudgetBytes` 声明；读取块大小受 Chromium WebUSB 上限约束。
  - 每个控制传输都有超时（对齐 libusb 的 500 ms）；慢传输看门狗与调度抖动区分开。
  - 可选 `coalesceBytes` 合并投递；投递时把 sink 的 Promise 向上暴露，让 worker 泵按
    `lagChunks` 施加背压。
  - 软件触发模式下由触发状态机拥有投递权，其队列上界由调用方要求的捕获长度决定。
  - stop / 重启：先停生产者再排空，失败时也停；FIFO overflow 在两次采集之间清除；二次采集重新武装。
- Dedicated Worker 传输：`usbWorker.ts`、`usbWorkerProtocol.ts`、`usbWorkerSpawn.ts`、
  `workerTransport.ts`，配合 `src/ui/main.ts` 注入 Worker 构造器，使 `device/` 保持可由 esbuild 打包。
- 测试与测量：`offline-test.ts`、`fakeUsb.ts`、`tools/fakeUsbWorker.ts` 提供离线与假 USB 回归；
  `bench-rate.ts`、`tools/geometry-bench.mjs`、`tools/window-bench.mjs`、`tools/windowHarness.ts`
  提供吞吐、队列间隙与线程停顿的测量。

### `a950f65` feat(ui) — 触发 UI 与渲染

- `src/ui/channelList.ts` 每通道触发模式，`modesToConditions()` 合成逻辑 AND 条件；
  `capturePanel.ts` 增加预触发百分比、软件触发开关与高级采集控制；`state.ts` / `app.ts` 承载
  `off | waiting | triggered | not-found` 状态与 `triggerSampleIndex`。
- `overlay.ts` 绘制触发游标；`render/transform.ts`、`waveformRenderer.ts` 增加样本感知缩放与
  实时边沿跟随；`timeAxis.ts` 的时间原点跟随触发点。
- 兼容性：默认 `softwareTrigger: false`，此时走原有 `emitSamples` 路径，行为不变。

### `01f5e17` feat(dist) — 便携构建

- `src/decode/tools/build-dist.mjs`：内联 pyodide 与解码器，产出可双击打开的 `dist/index.html`
  （`LOGICWEB_PORTABLE=1` 下 Vite 单文件打包，见 `vite.config.ts`）。
- `src/decode/tools/portable-smoke.mjs`：通过 `file://` 在 Chromium 中做已知答案的 uart 解码冒烟。
- `package.json` 增加 `dist` / `check:portable` 脚本；`src/decode/worker.ts` 适配单文件打包。

### `6be55f7` docs — 文档与状态

- `docs/ARCHITECTURE.md`、`docs/PROTOCOL-SLOGIC16U3.md` 更新触发、流式与 worker 设计；
  `status.json` 刷新浏览器与原生的吞吐测量与已知限制。

## 4. 必须保住的不变量

改动或后续维护时，这几条是设计约束，不要回退：

1. 触发匹配必须作用于完整设备样本，包括跨 USB 传输边界的那一个。
2. 等待触发期间不得保留无界的搜索前缀；预触发缓冲受 64 MiB 与输出预算双重限制。
3. 后触发保留量不得超过配置的捕获预算。
4. 传输断流后必须 `resetContinuity()`，不允许跨 gap 判定边沿。
5. SLogic/libsigrok 驱动只作为协议证据，不得把 GPL 实现代码抄进本 TypeScript 项目。

## 5. 验证

- 5 个关键提交 `npm run check` 全部通过。
- `npm run build` 通过（49 modules，`dist/assets/index-*.js` 约 552 kB / gzip 138 kB）。
- 数据自测 47/47 通过，含触发子套件 8/8（level/rising/falling/edge 跨传输边界、no-trigger
  有界丢弃、预算边界、自动停止有界、无限等待）。
- `npm run dist` + `npm run check:portable` 通过：`{"ok": true, "protocol": "uart", "annotations": 11}`。

复现：

```bash
npm run check
npm run build
node_modules/.bin/esbuild src/data/bench/runtests.ts --bundle --format=esm \
  --platform=node --outfile=/tmp/logicweb-tests.mjs && node /tmp/logicweb-tests.mjs
npm run dist && npm run check:portable
```

## 6. 已知的次要观察

两处都已确认有界，不构成内存或正确性风险：

1. `SoftwareTrigger.noteGap()` 会推进 `inspectedSamples`，但不复查 `searchLimitSamples`；
   跨 gap 后可能多搜索到下一个完整样本才停止，上界仍然成立。
2. 触发模式下 `deliver()` 不返回 sink 的 Promise，因此 worker 的 `lagChunks` 背压在该模式下不生效；
   有界性由捕获长度与预触发上界保证，源码已注释说明。

## 7. 风险与未决事项

- 无硬件验证：本环境没有 SLogic 板子，`offline-test.ts` / `fakeUsb.ts` 覆盖协议与状态机，
  真机吞吐与"卡死板子"的判据以 `src/device/NOTES.md` 的实测记录为准。
- 浏览器差异：NOTES 记录的 64 KiB / 1 MiB 复制阈值与 usbfs 预算都是特定 Chromium 版本上的测量，
  换内核版本需重跑 `npm run bench:geometry`。
- 便携包体积：单文件 `dist/index.html` 约 19 MB（gzip 8.4 MB），来自内联 pyodide 与解码器，属预期。

## 8. 后续步骤

1. 复核 `git log --oneline origin/main..HEAD` 的 5 条提交标题与分组。
2. `npm run dev` 走一遍：无触发采集、单通道 rising 触发、多通道 AND 触发、no-trigger 超时、
   触发后再采一次。
3. 确认无误后 `git push --force-with-lease origin main`。

## 9. 常用命令

```bash
git log --oneline origin/main..HEAD            # 5 个关键提交
git show --stat <sha>                          # 单个提交的范围
git diff origin/main...HEAD                    # 本次全部改动
npm run check && npm run build                 # 类型检查 + 构建
```

## 10. 接手修复轮（2026-09-14）

按用户报告修复三类问题，全部有确定性回归（`offline-test.ts` 新增 6 项 check）。

### 10.1 定时采集卡在 ~99%（如 1 s 卡在 990 ms）

两个叠加的原因，都在传输层的"采集自然结束"路径上：

1. 高线速率下 `SINK_CHUNK_BYTES = 8 MiB` 的合并缓冲：设备按 `R32_SAMPLE_LEN`
   自停后，最后不足一个块的尾部一直留在 `sinkBuffer` 里，只有 stop() 才 flush。
   8 MiB 在 32ch/200M 下恰好是 ~10 ms —— 正是"1 s 卡在 990 ms"。
2. 设备自停没有任何通知，UI 只能靠 `store.length >= captureLimitSamples` 判停，
   差着缓冲里的尾部永远到不了。

修复：`slogic16u3.ts` 新增 `maybeEndCapture()` —— 每次投递后检查
`deviceReachedItsLimit()` 或触发预算打满（`trigger.stats.complete`），命中则先
`flushSink()` 再触发一次新的 `CaptureStartOptions.onEnd` 回调；worker 协议新增
`{kind:'ended'}` 转发；UI 在 onEnd 里自动 stop。另外 UI 的 sink 在 `stopping`
期间不再丢弃排空的尾部数据（此前手动 stop 的采集同样被截掉最多一个块）。

### 10.2 软件触发在 worker 传输下损坏数据

worker 的 sink 把每个 chunk 的 ArrayBuffer **transfer** 给页面（types.ts 约定
sink 拥有该缓冲）。触发状态机命中后 emit 的是传输缓冲的 subarray 视图，emit 返回
后 `feed()` 继续从**同一个已 detach 的缓冲**读 post-trigger 数据 → 实测直接抛
`Cannot perform Construct on a detached ArrayBuffer`，读循环中止。页面内回退
传输（同步 sink）不受影响，所以离线套件此前没抓到。

修复：触发模式的 emit 包装器对"非完整缓冲的视图"先 `slice()` 拷贝再交给 sink；
预触发环形缓冲的输出本来就是独立 `slice()`，不重复拷贝。拷贝量以捕获预算为上界。
回归测试用"transfer 每个 chunk 的 sink"复现（`structuredClone(…, {transfer})`）。

时间轴语义同时对齐：状态栏 A/B 游标改为以触发点为原点（触发前为负数时间），与
时间轴/触发游标一致；capture 面板显示已武装的条件摘要、waiting/triggered/
not-found 状态，以及"启用了 Enable Mask 但没设任何通道条件"的显式警告。

### 10.3 布局自适应与触屏

- `index.html`：labels 列 + 波形列包进 `#scroll-area`（纵向滚动），时间轴与左列
  角块 sticky —— 通道行超出视口（手机、多通道）时可以滚到下面的通道。
- 行高改按滚动视口高度自适应（`relayout` 用 `scroll-area` 高度，ResizeObserver
  也观察它，避免"高度是输出又是输入"的循环）。
- 左列收窄为 128 px（≤760 px 时 104 px）：默认通道名改为空，身份就是彩色 D 标签，
  不再重复 "Channel 15"；加载文件时自动丢弃 "D3"/"Channel 3"/"3" 这类自动名。
- 窄屏（≤760 px）侧栏改为浮层，不再把波形挤成零宽。
- 触屏：`#plot` 设 `touch-action: pan-y`（竖滑交给浏览器滚动，横滑由指针事件平移），
  双指捏合缩放（以两指中点为锚），捏合后剩一指无缝转平移；`#axis` 拖动平移。
- 工具栏/状态栏允许换行；`100dvh` 适配移动端地址栏伸缩。

### 10.4 验证

- `tsc --noEmit`、`npm run build`、`npm run dist && npm run check:portable` 通过。
- 数据自测 47/47；设备离线 167 项（新回归：detach-sink 触发 + triggerSampleIndex、
  合并缓冲触发尾部 flush + onEnd、设备限长尾部 flush + onEnd、4 通道打包头部计数、
  worker `ended` 消息穿越）；lwcap 5/5、sr 12/12。
- 无头 Chromium 三视口（1280×800 / 400×780 / 780×380）布局冒烟：应用构造成功、
  无横向溢出、状态栏可见、16 行可滚动。
- 按 AGENTS.md 要求，触发相关改动经三路独立并发评审（协议/设备、数据/内存、UI/测试），
  无 blocker/major 遗留；评审采纳项：4 通道头部字节按线上打包换算（否则 onEnd 永不
  触发且 stop 走不了快路径）、`softwareTrigger` 与 `deviceSampleLimit` 互斥校验、
  `coalesceBytes` 对齐校验、手动 stop 排空期间不误报 onEnd、pointercancel（触屏竖
  滑）不再误放游标、三指捏合基线重置、时间轴拖动 pointercancel 复位、pre-trigger
  文案改为显示受 64 MiB 上限截断后的实际时长、not-found 文案纠正、waiting 状态按钮
  动画、面板 armed 摘要。
- 真机复测清单同第 8 节，另加：高速率定时采集应自动停在设定时长，
  软件触发命中后波形在 T=0 右侧应连续无缺口。

### 10.5 真机验证、局域网服务与离线交付（2026-09-14）

真机（SLogic32 U3，S/N 202608052052）经 CDP + WebUSB 预授权 Chromium 实测：

- **990 ms 卡死已修复。** 根因不是合并缓冲尾部，而是固件在设定长度处结束上传且**无 ZLP**，
  固定大小的最后一次 `transferIn` 越过末尾后永远 NAK。修复为 readLoop 的“最后一读”按
  `deviceWireBytes` 收敛（借鉴 libsigrok protocol.c:79-82）。实测 32ch@10M/1s 恰好停在
  10,000,000 采样。假 USB 设备已改为不发 ZLP 的模型，否则掩盖此 bug。
- **软件触发命中，`triggerSampleIndex` 落在保留窗口内**，跨线程/传输层数据不再 detach。
- **布局自适应**三视口冒烟通过（HTTPS 下复测）。

**200M 采集是已知天花板，不是 re-arm bug。** 32ch@200M = 800 MB/s，高于 Chromium WebUSB
上限（~458 MB/s，见 `src/device/NOTES.md` 8.7）。该采集即使完成也会冲垮设备 FIFO 并使
**采样通路**卡死（NOTES 8.8 的 W1：每次 bulk 读超时、无数据、无错误），导致**下一次**采集读到
0 字节，只能物理重新插拔恢复。因此自动化测试中任何 200M 压力用例必须放在**最后**，否则会污染
其后所有可达速率用例——这正是先前测试顺序踩的坑（`/tmp/hw-test.mjs` 已重排，200M 置末且其
卡死记为 INFO 而非 FAIL）。

**`USBDevice.reset()` 不能恢复卡死的板子**（NOTES 8.8 实测：`libusb_reset_device` 返回
“Entity not found”，设备直接掉出总线且不重枚举），故**不应**在传输层加 reset 恢复逻辑——
现有 no-data 看门狗给出的“拔插重连”干净报错已是最优。

**局域网服务（供手机测试）**：`npm run dev:lan` 在 `0.0.0.0:5173` 上以 HTTPS 提供实时应用，
`npm run preview:lan` 在 5174 上提供构建产物。默认 `npm run dev`/`preview` 仍为 localhost+HTTP。
`LOGICWEB_LAN=1` 触发 `vite.config.ts` 的 `lanServer()` 切到 `0.0.0.0`+自签证书（`certs/`，
已 gitignore，`npm run cert` 生成、自动把本机 LAN IP 写入 SAN）。**HTTPS 是必需的**：WebUSB
只在安全上下文存在，localhost 算，裸 LAN IP 走 HTTP 不算，手机上 `navigator.usb` 会缺失；
接受一次自签证书后手机即为安全上下文（响应式 UI，以及经 OTG 插到安卓手机上的分析仪均可用）。

**离线交付：便携单文件正是“Save Page As”能离线用的前提，而非其替代。** 普通多文件页面无法经
浏览器“网页另存为”离线使用——模块 worker 无法在 `file://` 不透明源启动（故用 iife/blob worker），
Pyodide WASM/解码器按计算出的 URL 抓取，Chrome 的“完整保存”会破坏它。`npm run dist`
（`LOGICWEB_PORTABLE=1`）把 JS/CSS/worker/Pyodide/解码器全部以 data URI 内联进一个约 21 MB、
无任何外部引用的 `dist/index.html`；在该页上“网页另存为→仅 HTML”即得到一个可离线运行的单文件
（`npm run check:portable` 从 `file://` 加载并解码 UART 验证通过）。故交付方式为：保留
`npm run dist`，但把它的产物**作为用户访问的页面**（`preview:lan`），Ctrl+S 即可整体保存。
