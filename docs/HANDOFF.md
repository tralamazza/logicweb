# 交接文档：32U3 采集、软件触发与传输层优化

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
