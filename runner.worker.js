/* ==========================================================================
   runner.worker.js — Pyodide 运行时（在 Web Worker 中执行，主线程不阻塞）
   职责：加载 CPython(WASM)、执行用户代码、接管 stdout/stderr/stdin、
        按需加载预编译包、安装 PyPI 包、回传 matplotlib 图形。
   ========================================================================== */
'use strict';

/* ------------------------------------------------------------ 加载候选源 --
   优先带预编译包的完整发行版（CPython 3.11），再退到其他版本 / 仅核心运行时。
   启动时先并行探测可达性，再按优先级逐个加载，单项超时自动换源。
   注：importScripts 受 CORS 约束，因此只使用带 Access-Control-Allow-Origin 的源。 */
var CANDIDATES = [
  { base: 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/', label: 'jsDelivr · CPython 3.11 完整发行版', full: true },
  { base: 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/', label: 'jsDelivr · CPython 3.13 完整发行版', full: true },
  { base: 'https://fastly.jsdelivr.net/pyodide/v0.25.1/full/', label: 'Fastly 镜像 · CPython 3.11 完整发行版', full: true },
  { base: 'https://cdn.jsdelivr.net/npm/pyodide@0.25.1/', label: 'jsDelivr npm · 核心运行时', full: false }
];

var PROBE_MS = 12000;      // 单源探测超时
var LOAD_MS = 300000;      // 单源加载超时（慢速网络下完整发行版可能需数分钟）
var CORE_FILES = ['pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide.asm.js', 'pyodide-lock.json'];

var pyodide = null;
var ready = false;
var current = null;

var stdinLines = [];
var stdinCursor = 0;

function post(type, payload) {
  self.postMessage({ type: type, payload: payload });
}

function send(text) {
  post('log', text);
}

/* ------------------------------------------------------------- 标准输出 --
   Pyodide 的 raw 回调给出的是 UTF-8 字节（字符码 0–255），
   必须按 UTF-8 增量解码，否则中文等多字节字符会变成乱码。 */

var outBytes = [];
var errBytes = [];
var outDecoder = new TextDecoder('utf-8');
var errDecoder = new TextDecoder('utf-8');
var encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function toBytes(ch) {
  if (typeof ch === 'number') return [ch & 0xff];
  if (encoder) return encoder.encode(String(ch));
  var arr = [];
  for (var i = 0; i < String(ch).length; i++) arr.push(String(ch).charCodeAt(i) & 0xff);
  return arr;
}

function pushOut(ch) {
  var bytes = toBytes(ch);
  for (var i = 0; i < bytes.length; i++) outBytes.push(bytes[i]);
  if (outBytes.length >= 4096 || outBytes[outBytes.length - 1] === 10) flushOut();
}

function pushErr(ch) {
  var bytes = toBytes(ch);
  for (var i = 0; i < bytes.length; i++) errBytes.push(bytes[i]);
  if (errBytes.length >= 4096 || errBytes[errBytes.length - 1] === 10) flushErr();
}

function flushOut() {
  if (!outBytes.length) return;
  var text = outDecoder.decode(new Uint8Array(outBytes), { stream: true });
  outBytes.length = 0;
  if (text) post('stdout', text);
}

function flushErr() {
  if (!errBytes.length) return;
  var text = errDecoder.decode(new Uint8Array(errBytes), { stream: true });
  errBytes.length = 0;
  if (text) post('stderr', text);
}

/* 一次运行结束时调用：冲掉残留在解码器中的多字节片段 */
function endOfStreams() {
  flushOut();
  flushErr();
  var tailOut = outDecoder.decode();
  var tailErr = errDecoder.decode();
  if (tailOut) post('stdout', tailOut);
  if (tailErr) post('stderr', tailErr);
  outDecoder = new TextDecoder('utf-8');
  errDecoder = new TextDecoder('utf-8');
}

/* ------------------------------------------------------------- 初始化 -- */

var BOOTSTRAP = [
  'import sys, builtins, json',
  '_pyide_lines = json.loads(_PYIDE_LINES_JSON)',
  '',
  'class _PyIDEStdin:',
  '    """由页面「标准输入」面板供数的 stdin 替身。"""',
  '    def __init__(self, lines):',
  '        self._lines = list(lines)',
  '        self._i = 0',
  '    def readline(self, *args):',
  '        if self._i < len(self._lines):',
  '            line = self._lines[self._i]',
  '            self._i += 1',
  '            _pyide_echo_js(str(line))',
  '            return line + "\\n"',
  '        return ""',
  '    def read(self, size=-1):',
  '        rest = self._lines[self._i:]',
  '        self._i = len(self._lines)',
  '        for line in rest:',
  '            _pyide_echo_js(str(line))',
  '        return "".join(l + "\\n" for l in rest)',
  '    def readlines(self, hint=-1):',
  '        return self.read().splitlines(True)',
  '    def __iter__(self):',
  '        return self',
  '    def __next__(self):',
  '        line = self.readline()',
  '        if not line:',
  '            raise StopIteration',
  '        return line',
  '    def isatty(self):',
  '        return False',
  '',
  'sys.stdin = _PyIDEStdin(_pyide_lines)',
  '',
  'def _pyide_input(prompt=""):',
  '    if prompt:',
  '        print(prompt, end="", flush=True)',
  '    line = sys.stdin.readline()',
  '    if line == "":',
  '        raise EOFError("标准输入已读完：请在左下「标准输入」面板补充内容后重试")',
  '    return line.rstrip("\\n")',
  '',
  'builtins.input = _pyide_input',
  'del _pyide_lines, json'
].join('\n');

async function boot() {
  post('hint', '首次打开需下载约 13 MB 运行时（WASM 版 CPython 3.11），下载过程见下方进度；'
    + '下载完成后会缓存在浏览器中，再次访问即时可用。');

  // 1) 并行探测：小范围请求确认来源可达，避免逐个长等待
  var probes = await Promise.all(CANDIDATES.map(function (c) { return probe(c.base); }));
  var usable = CANDIDATES.filter(function (c, i) { return probes[i].ok; });
  probes.forEach(function (p) {
    if (!p.ok) post('warn', p.label + ' 探测失败（' + p.info + '），已跳过。');
  });
  if (usable.length) {
    post('log', '可用运行时来源：' + usable.map(function (c) {
      return c.label.replace(/^[^·]+·\s*/, '') + '（' + probes[CANDIDATES.indexOf(c)].ms + ' ms）';
    }).join('；'));
  } else {
    post('warn', '未探测到可用来源，仍将按默认顺序尝试加载。');
  }

  var order = usable.concat(CANDIDATES.filter(function (c) { return usable.indexOf(c) === -1; }));

  // 2) 按优先级逐个加载，单项超时后自动换源
  for (var i = 0; i < order.length; i++) {
    var cand = order[i];
    try {
      post('log', '正在加载运行时 … ' + cand.label);
      await prefetch(cand);
      var instance = await loadWithTimeout(cand, LOAD_MS);
      pyodide = instance;
      current = cand;
      configure();
      ready = true;

      post('ready', {
        label: cand.label,
        full: cand.full,
        pyodide: pyodide.version,
        python: pyodide.runPython('import sys; sys.version.split()[0]')
      });
      return;
    } catch (err) {
      pyodide = null;
      post('warn', cand.label + ' 加载失败：' + ((err && err.message) || err));
    }
  }
  post('fatal', '所有运行时来源均不可用。请检查网络/代理后刷新页面重试。');
}

function probe(base) {
  var cand = null;
  for (var i = 0; i < CANDIDATES.length; i++) {
    if (CANDIDATES[i].base === base) cand = CANDIDATES[i];
  }
  var label = cand ? cand.label : base;
  var started = Date.now();

  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve({ ok: false, label: label, info: '探测超时 ' + PROBE_MS + ' ms', ms: PROBE_MS });
    }, PROBE_MS);

    fetch(base + 'pyodide.asm.wasm', { headers: { Range: 'bytes=0-1023' } })
      .then(function (res) {
        if (res.body && res.body.cancel) res.body.cancel().catch(function () {});
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: res.ok || res.status === 206,
          label: label,
          info: 'HTTP ' + res.status,
          ms: Date.now() - started
        });
      })
      .catch(function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, label: label, info: (err && err.message) || String(err), ms: Date.now() - started });
      });
  });
}

/* 预取核心文件并上报进度：CDN 已声明 max-age=31536000，
   预取结果会进入浏览器缓存，随后 loadPyodide 直接命中缓存、不会重复下载。 */
async function prefetch(cand) {
  var plan = [];
  var total = 0;
  var i;

  // 取体积：HEAD 拿不到 content-length（代理/服务器不支持）时按“体积未知”处理，
  // 但仍要预取——否则最大的 wasm 会被跳过，进度条就失去意义。
  for (i = 0; i < CORE_FILES.length; i++) {
    var size = 0;
    var include = true;
    try {
      var head = await fetch(cand.base + CORE_FILES[i], { method: 'HEAD' });
      if (head.ok) size = Number(head.headers.get('content-length') || 0);
      else include = false;
    } catch (e) { /* 保留：体积未知也要下载 */ }
    if (include) {
      plan.push({ name: CORE_FILES[i], size: size });
      total += size;
    }
  }
  if (!plan.length) return;

  plan.sort(function (a, b) { return b.size - a.size; });
  post('progress', { got: 0, total: total, label: cand.label, stage: '开始下载' });

  var got = 0;
  for (i = 0; i < plan.length; i++) {
    var res;
    try {
      res = await fetch(cand.base + plan[i].name);
    } catch (e) {
      got += plan[i].size;
      continue;
    }
    if (!res.ok || !res.body) { got += plan[i].size; continue; }

    // 体积未知的文件：从 GET 响应补出真实大小，避免分母偏小导致进度虚高
    var declared = Number(res.headers.get('content-length') || 0);
    if (!plan[i].size && declared) total += declared;

    var reader = res.body.getReader();
    var last = 0;
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      got += chunk.value.length;
      var now = Date.now();
      if (now - last > 350) {
        last = now;
        post('progress', {
          got: got,
          total: Math.max(total, got),
          label: cand.label,
          stage: plan[i].name
        });
      }
    }
    post('progress', {
      got: got,
      total: Math.max(total, got),
      label: cand.label,
      stage: plan[i].name
    });
  }
}

function loadWithTimeout(cand, ms) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var hints = [5000, 20000, 45000, 80000];
    var hintTimers = hints.map(function (at) {
      return setTimeout(function () {
        if (!settled) {
          send('仍在下载运行时（已等待 ' + Math.round(at / 1000) + ' s，来源：'
            + cand.label + '）…');
        }
      }, at);
    });
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      hintTimers.forEach(clearTimeout);
      reject(new Error('加载超时（' + Math.round(ms / 1000) + ' s 未完成）'));
    }, ms);

    (async function () {
      try {
        importScripts(cand.base + 'pyodide.js');
        if (typeof loadPyodide !== 'function') throw new Error('pyodide.js 未导出 loadPyodide');
        var instance = await loadPyodide({ indexURL: cand.base });
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        hintTimers.forEach(clearTimeout);
        resolve(instance);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        hintTimers.forEach(clearTimeout);
        reject(err);
      }
    })();
  });
}

function configure() {
  pyodide.setStdout({ raw: pushOut });
  pyodide.setStderr({ raw: pushErr });

  // 兜底：底层读取（如 sys.stdin.buffer）直接视为 EOF，避免阻塞
  try {
    pyodide.setStdin({ stdin: function () { return null; } });
  } catch (e) { /* 旧版本 API 无此形态，忽略 */ }

  // 非交互绘图后端 + 关闭字节码缓存噪音
  pyodide.runPython([
    'import os',
    "os.environ['MPLBACKEND'] = 'AGG'",
    "os.environ['PYTHONDONTWRITEBYTECODE'] = '1'"
  ].join('\n'));

  pyodide.globals.set('_pyide_echo_js', function (text) { post('stdin', text); });
}

/* --------------------------------------------------------------- 执行 -- */

function cleanTraceback(text) {
  var lines = String(text || '').split('\n');
  var out = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var internal = /File "\/lib\/python[^"]*\/_pyodide\//.test(line)
      || /_pyodide\/_base\.py/.test(line)
      || /pyodide\.js|pyodide\.asm\.mjs/.test(line);

    if (internal) {
      // 连同该 frame 的源码行与脱字符标记行一并丢弃
      while (i + 1 < lines.length
        && (/^\s{4,}\S/.test(lines[i + 1]) || /^\s*[\^~]{2,}\s*$/.test(lines[i + 1]))) {
        i++;
      }
      continue;
    }
    out.push(line);
  }

  var cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned || String(text || '').trim();
}

function errorText(err) {
  if (!err) return '未知错误';
  var raw = err.message || err.toString();
  return cleanTraceback(raw);
}

var FIGURE_SCRIPT = [
  'def _pyide_collect_figures():',
  '    import base64, io, sys',
  '    if "matplotlib" not in sys.modules:',
  '        return []',
  '    images = []',
  '    try:',
  '        import matplotlib.pyplot as plt',
  '        for num in plt.get_fignums():',
  '            buf = io.BytesIO()',
  '            plt.figure(num).savefig(buf, format="png", dpi=110,',
  '                                    bbox_inches="tight", facecolor="white")',
  '            images.append(base64.b64encode(buf.getvalue()).decode("ascii"))',
  '        plt.close("all")',
  '    except Exception:',
  '        pass',
  '    return images',
  '',
  '_pyide_collect_figures()'
].join('\n');

function collectFigures() {
  try {
    var proxy = pyodide.runPython(FIGURE_SCRIPT);
    var list = proxy.toJs ? proxy.toJs() : [];
    if (proxy.destroy) proxy.destroy();
    return Array.prototype.slice.call(list);
  } catch (e) {
    return [];
  }
}

async function run(msg) {
  if (!ready) { post('fatal', '运行时尚未就绪，请稍候。'); return; }

  var code = msg.code || '';
  stdinLines = msg.stdin || [];
  stdinCursor = 0;
  outBytes.length = 0;
  errBytes.length = 0;

  pyodide.globals.set('_PYIDE_LINES_JSON', JSON.stringify(stdinLines));
  pyodide.runPython(BOOTSTRAP);

  var started = (self.performance || Date).now();
  var loadedPackages = [];
  var result = { ok: true, error: '', warnings: [], ms: 0, images: [] };

  // 按 import 自动加载预编译包（numpy / pandas / matplotlib / pillow …）
  try {
    await pyodide.loadPackagesFromImports(code, {
      messageCallback: function (m) {
        var text = String(m);
        if (text.trim()) result.warnings.push(text);
      },
      errorCallback: function (m) { result.warnings.push('依赖加载告警：' + m); }
    });
  } catch (e) {
    result.warnings.push('自动加载依赖失败：' + ((e && e.message) || e));
  }

  try {
    await pyodide.runPythonAsync(code);
  } catch (e) {
    result.ok = false;
    result.error = errorText(e);
  }

  endOfStreams();

  result.images = collectFigures();
  result.ms = Math.round(((self.performance || Date).now() - started));
  post('done', result);
}

/* ------------------------------------------------------------- 安装包 -- */

async function install(msg) {
  var names = msg.packages || [];
  if (!names.length) return;
  var done = [];
  var failed = [];

  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    try {
      send('解析预编译包：' + name);
      await pyodide.loadPackage(name, { messageCallback: send });
      done.push(name);
      continue;
    } catch (e) { /* 不在发行版中，转 PyPI */ }

    try {
      send('从 PyPI 安装：' + name);
      await pyodide.loadPackage('micropip');
      var micropip = pyodide.pyimport('micropip');
      await micropip.install(name, { messageCallback: send });
      done.push(name);
    } catch (e2) {
      failed.push({ name: name, reason: ((e2 && e2.message) || String(e2)).split('\n').slice(-4).join('\n') });
    }
  }

  endOfStreams();
  post('installed', { done: done, failed: failed });
}

/* ------------------------------------------------------------- 消息入口 -- */

self.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.type === 'init') { boot(); }
  else if (msg.type === 'run') { run(msg); }
  else if (msg.type === 'install') { install(msg); }
};
