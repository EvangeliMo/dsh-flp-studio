# dsh-flp-studio

FL Studio 工程（.flp）浏览与分析插件，for DeepSeek Harness Web。

在 DSH 侧边栏浏览本机 FL Studio 工程文件，解析工程结构（通道 / pattern / 音符 / 混音台 / 效果器链），并做音乐特征分析（BPM、音高分布、总音符数）。写入功能（修改音符）带自动备份，**绝不直接改动原文件**——写操作先备份到 `_dsh-flp-studio_backups/`，再原子替换。

## 功能

- **浏览**：按目录列出 `.flp` / `.fsc` / `.fst` 文件（默认 `Documents\Image-Line\FL Studio\Projects`）
- **分析**：打开任一工程 →
  - 工程元数据：版本、BPM、ppq、通道数、pattern 数、混音台轨道数
  - 通道列表（Sampler / Instrument / Automation 分类，含音量/声像/路由）
  - Pattern 与音符数
  - 音乐特征：总音符数、音高分布（用于推断调性/中心音）
- **编辑音符（实验性）**：修改指定 pattern 内音符的音高/力度/位置/长度，**自动备份后写入**

## 架构

```
DSH 客户端 (React) ──typert──> Node 宿主服务 (TypertRemoteService)
                                    │ spawn
                                    ▼
                          Python 桥 (bridge.py + PyFLP)
```

- **宿主**（`lib/index.js`）：`TypertRemoteService`，三个远程方法 `flp/listdir`、`flp/analyze`、`flp/editNote`。
- **Python 桥**（`python/bridge.py`）：一行 JSON-in/JSON-out，用 [PyFLP](https://github.com/demberto/PyFLP) 解析/改写 `.flp`。
- **契约**（`lib/contracts.js`）：zod v4 共享线缆契约。

## 依赖（用户侧）

- **Python 3.12+** 且已安装 `pyflp`：
  ```powershell
  pip install pyflp
  ```
- **PyFLP 的 Python 3.12 兼容补丁**：本插件依赖已修补的 PyFLP（`_events.py` 的 `_EventEnumMeta.__call__` 处理空枚举）。见 `docs/PYFLP_PATCH.md`。

## 开发

```powershell
# 安装（link 到源码目录）
dsh plugin --profile web add D:\path\to\dsh-flp-studio

# 改客户端后重建 + 硬刷新
node scripts/build-client.mjs

# 宿主冒烟测试（会对副本执行 analyze + editNote）
node scripts/test-host.mjs
```

> 本地开发时若 `remoteMethods` 为空（网关分发失败），检查插件
> `node_modules/@deepseek-ai/*` 是否与 harness 安装同实例——需要时将
> `cordis`、`dsh-typert-protocol` 等替换为指向 npx 缓存安装的 junction。

## 安全

- **只读分析**：`analyze` / `listdir` 不修改任何文件。
- **写入**：`editNote` 先备份原文件到 `<工程目录>/_dsh-flp-studio_backups/`，成功后才原子替换；失败时原文件保持不动。
- Python 桥只访问显式传入的路径。

## License

MIT
