# Python 练习场

一个极简的在线 Python 编辑器：**左边写代码，右边看结果**。运行的是真实 CPython 3.11（编译为 WebAssembly），代码在你的浏览器里执行，不会上传到任何服务器。

在线体验：https://python-online-ide.app.workbuddy.host/

## 特点

- **零安装、零后端**：纯静态站点，一个 HTML + 三个 JS + 一个 CSS，没有构建步骤，扔到任何静态托管上就能用。
- **真实 CPython 3.11.3**：通过 [Pyodide](https://pyodide.org/) 0.25.1 在浏览器内运行解释器本体，不是模拟器，`print`、异常、`input()` 的行为与本地 Python 一致。
- **代码不出本机**：执行发生在你的浏览器标签页里，代码与输入都不会发往服务器。
- **自研代码编辑器**：语法高亮、行号、`Tab` 缩进、回车自动续行，零外部依赖（没有引任何编辑器 CDN）。
- **为初学者设计**：每次运行自动清空结果区；没有输出时提示你 `print()`；`input()` 拿不到数据时告诉你去哪里填。

## 快速开始

直接用浏览器打开 `index.html` 即可。注意 `runner.worker.js` 需要通过 HTTP 访问（浏览器的 Web Worker 不允许 `file://`），所以更推荐起一个本地静态服务：

```bash
# 任选一种
python -m http.server 8000
npx serve .
```

然后访问 http://localhost:8000 。

## 使用说明

| 操作 | 方式 |
|---|---|
| 运行代码 | 点右上角「运行」，或按 `Ctrl`+`Enter` |
| 停止卡住/死循环的程序 | 点「停止」，页面不会卡死，随后可继续运行 |
| 清空结果 | 点「清空结果」 |
| 让 `input()` 有数据可读 | 在左下方输入框里填写，**一行一个值** |
| 缩进 | `Tab`（4 个空格），`Shift`+`Tab` 反缩进 |

第一次打开需要下载约 10 MB 运行时（WebAssembly 版 CPython），顶栏会显示进度。下载完成后浏览器会缓存，之后打开只需数秒。

## 项目结构

```
index.html          页面结构：顶栏 / 编辑器 / 结果区 / 页脚
styles.css          全部样式（含编辑器高亮层与 textarea 的对齐规则）
editor.js           零依赖代码编辑器：高亮层 + 透明输入层叠加
app.js              主线程逻辑：状态机、结果区渲染、与 worker 通信
runner.worker.js    Pyodide 运行时（Web Worker 中执行，主线程不阻塞）
upload.py           一键上传到 GitHub（建仓库 / 推送 / 打标签 / 开 Pages）
test-upload.sh      upload.py 的回归测试（13 项，无需凭据）
CHANGELOG.md        更新日志
UPLOAD-TO-GITHUB.md 上传说明与失败排查
```

职责划分：`app.js` 只管界面，一行 Python 都不碰；`runner.worker.js` 只管执行，一行 DOM 都不碰。两者通过 `postMessage` 通信，消息格式统一为 `{ type, payload }`。

## 上传到 GitHub

```bash
python upload.py --dry-run        # 先看看会做什么
python upload.py                  # 真正执行（会引导你完成认证）
```

脚本零第三方依赖，一条命令做完「环境体检 → 准备仓库 → 认证 → 建仓库 → 推送 → 打标签 → 设置 Topics / 开启 Pages → 输出地址」，详见 [UPLOAD-TO-GITHUB.md](UPLOAD-TO-GITHUB.md)。

## 工作原理

```
用户代码 ──> app.js ──postMessage──> runner.worker.js
                                        │
                                        ├─ loadPyodide()  加载 CPython(WASM)
                                        ├─ 接管 stdout/stderr/stdin
                                        └─ runPythonAsync()
                                        │
结果区 <──postMessage── stdout / stderr / 图片 / 异常
```

几个关键设计：

1. **执行放在 Web Worker 里**。死循环不会卡死页面，「停止」= `worker.terminate()` + 重建运行时。
2. **运行时多源回退**。启动时并行探测各 CDN 可达性，再按优先级加载；`importScripts` 受 CORS 约束，因此候选源只保留带 `Access-Control-Allow-Origin` 的路径。单源超时自动换源。
3. **带进度的预取**。核心文件先预取并上报百分比，再交给 Pyodide 从浏览器缓存装载（CDN 缓存为 `max-age=31536000`），避免慢速网络下看起来"卡死"。
4. **UTF-8 增量解码**。Pyodide 的原始输出回调给出的是 UTF-8 字节，必须用 `TextDecoder` 增量解码，否则中文会变成乱码。

## 已知限制

- 无法执行需要本地网络端口、GPU 或系统调用的代码；不支持 `tkinter`、`multiprocessing`。
- 没有文件系统持久化，进程退出即丢失（可用 `/tmp` 做单次运行的临时文件）。
- matplotlib 已切换为 AGG 非交互后端，图像直接渲染在结果区；运行时未内置中文字体，绘图标题请用英文。
- 变量在多次运行之间保留（类似交互式解释器），需要干净环境请点「停止」重建运行时。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 作者

made by **Jerry_Griffin**

## 许可

MIT
