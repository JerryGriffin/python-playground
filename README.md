# Python 练习场

一个极简的在线 Python 编辑器：**左边写代码，右边看结果**。运行的是真实 CPython 3.11（编译为 WebAssembly），代码在你的浏览器里执行，不会上传到任何服务器。

在线体验：https://jerrygriffin.github.io/python-playground/

## 怎么用

- **运行**：右上角「运行」，或按 <kbd>Ctrl</kbd>+<kbd>Enter</kbd>。
- **输入**：程序跑到 `input()` 会**就地停下来等你**——结果区出现一行输入框，敲完按回车它才继续。想提前结束输入，点「结束输入」或按 <kbd>Ctrl</kbd>+<kbd>D</kbd>。
- **补全**：按 <kbd>Tab</kbd> 补全光标处的词（变量名、关键字、内置函数、`math.` 这类模块成员都会给）。唯一候选一次补齐；多个候选会列出列表，再用 <kbd>Tab</kbd>/<kbd>Enter</kbd> 采用、<kbd>↑</kbd><kbd>↓</kbd> 选择、<kbd>Esc</kbd> 关闭。光标处没有候选时，<kbd>Tab</kbd> 仍是缩进。
- **停止**：程序卡住或死循环时点「停止」，运行环境会自动重建，可以直接再运行。
