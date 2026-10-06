/* ==========================================================================
   app.js — Python 练习场（极简版）
   只做三件事：把代码交给 worker 运行、把结果打印到右侧、把运行环境的准备
   进度显示在顶栏。运行环境（Pyodide / CPython 3.11）由 runner.worker.js
   在后台加载，两者通过 postMessage 通信（消息格式 { type, payload }）。
   ========================================================================== */
(function () {
  'use strict';

  var DEFAULT_CODE = [
    '# 在这里写你的代码，然后点右上角的「运行」',
    '',
    'print("Hello, World!")',
    ''
  ].join('\n');

  var STORE_KEY = 'pyide.simple.code';

  var el = {
    console: document.getElementById('console'),
    editorBox: document.getElementById('editor'),
    stdinBox: document.getElementById('stdinBox'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    btnRun: document.getElementById('btnRun'),
    btnStop: document.getElementById('btnStop'),
    btnClear: document.getElementById('btnClear')
  };

  /* ready 运行环境是否可用 / running 是否有代码正在跑 */
  var runtime = { ready: false, running: false, python: '' };
  var worker = null;
  var out = { stdout: null, stderr: null };   // 尚未结束的输出行，用于流式续写
  var sawOutput = false;                      // 本次运行是否产生过输出

  /* ------------------------------------------------------------ 编辑器 -- */

  var saved = null;
  try { saved = localStorage.getItem(STORE_KEY); } catch (e) { /* 隐私模式 */ }

  var editor = window.PyEditor.mount(el.editorBox, {
    onChange: function (text) {
      try { localStorage.setItem(STORE_KEY, text); } catch (e) { /* 忽略 */ }
    },
    onRun: function () { run(); }
  });

  editor.setValue(saved === null ? DEFAULT_CODE : saved);

  /* ------------------------------------------------------------ 输出区 -- */

  function scrollDown() {
    el.console.scrollTop = el.console.scrollHeight;
  }

  function clearConsole() {
    el.console.innerHTML = '';
    out.stdout = out.stderr = null;
  }

  /* 灰色说明行：系统的提示，不是程序输出 */
  function note(text) {
    var row = document.createElement('div');
    row.className = 'row sys';
    row.textContent = text;
    el.console.appendChild(row);
    scrollDown();
    return row;
  }

  /* 程序输出：按流着色，跨消息分片时续写同一个 div */
  function write(stream, text) {
    if (!text) return;
    sawOutput = true;

    var other = stream === 'stdout' ? 'stderr' : 'stdout';
    if (out[other]) out[other] = null;   // stdout / stderr 交错时结束上一段

    var row = out[stream];
    if (!row) {
      row = document.createElement('div');
      row.className = 'row' + (stream === 'stderr' ? ' err' : '');
      el.console.appendChild(row);
      out[stream] = row;
    }
    row.textContent += text;

    if (text.charAt(text.length - 1) === '\n') out[stream] = null;
    scrollDown();
  }

  /* input() 读走的一行回显出来，让初学者看清程序拿到了什么 */
  function echoLine(text) {
    var row = document.createElement('div');
    row.className = 'row stdin';
    row.textContent = '▸ ' + text;
    el.console.appendChild(row);
    scrollDown();
  }

  function addImage(src) {
    var fig = document.createElement('figure');
    var img = document.createElement('img');
    img.alt = '绘图结果';
    img.src = String(src).indexOf('data:') === 0 ? src : 'data:image/png;base64,' + src;
    fig.appendChild(img);
    el.console.appendChild(fig);
    scrollDown();
  }

  /* -------------------------------------------------------- 状态与按钮 -- */

  function setStatus(kind, text) {
    el.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
    el.statusText.textContent = text;
  }

  function updateButtons() {
    el.btnRun.disabled = !runtime.ready || runtime.running;
    el.btnStop.disabled = !runtime.running;
  }

  function mb(bytes) {
    return (bytes / 1048576).toFixed(1);
  }

  /* -------------------------------------------------------- 运行环境 -- */

  function spawn() {
    if (worker) worker.terminate();
    worker = new Worker('runner.worker.js');
    worker.onmessage = onMessage;
    worker.onerror = function (event) {
      runtime.ready = false;
      runtime.running = false;
      setStatus('bad', '运行环境启动失败，请刷新页面重试');
      note('运行环境出错：' + ((event && event.message) || '未知错误'));
      updateButtons();
    };
    worker.postMessage({ type: 'init' });
    setStatus('loading', '正在准备 Python 运行环境…');
    updateButtons();
  }

  function onMessage(event) {
    var msg = event.data || {};
    var payload = msg.payload;

    switch (msg.type) {
      case 'progress':
        setStatus('loading', '第一次打开要下载运行环境 ' + Math.round((payload.got / payload.total) * 100)
          + '%（' + mb(payload.got) + ' / ' + mb(payload.total) + ' MB），请稍等…');
        break;

      case 'ready':
        runtime.ready = true;
        runtime.python = payload.python || '';
        setStatus('ready', 'Python ' + runtime.python + ' 已就绪');
        clearConsole();
        note('环境准备好了，点右上角「运行」开始。');
        updateButtons();
        break;

      case 'stdout': write('stdout', payload); break;
      case 'stderr': write('stderr', payload); break;
      case 'stdin': echoLine(payload); break;
      case 'done': onDone(payload); break;

      case 'fatal':
        runtime.ready = false;
        runtime.running = false;
        setStatus('bad', '运行环境不可用');
        note(String(payload));
        updateButtons();
        break;

      /* log / hint / warn 是给开发者看的技术信息，界面不显示，避免干扰初学者 */
      default:
        break;
    }
  }

  function onDone(result) {
    result = result || {};
    runtime.running = false;
    out.stdout = out.stderr = null;
    updateButtons();

    if (result.images && result.images.length) {
      for (var i = 0; i < result.images.length; i++) addImage(result.images[i]);
    }

    if (!result.ok) {
      write('stderr', (result.error || '运行出错') + '\n');
      if (/EOFError/.test(result.error || '')) {
        note('程序在等输入（input）。请在左边最下面的输入框里，每行填一个值，然后重新运行。');
      }
      setStatus('ready', '运行出错，请看右边的红色提示');
      return;
    }

    if (sawOutput) {
      note('— 运行结束 —');
    } else {
      note('代码运行完了，但没有任何输出。想看结果需要用 print() 打印出来。');
    }
    setStatus('ready', '运行完成');
  }

  /* ------------------------------------------------------------ 动作 -- */

  function stdinLines() {
    var raw = el.stdinBox.value.replace(/\r\n?/g, '\n');
    if (!raw) return [];
    var lines = raw.split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  function run() {
    if (!runtime.ready || runtime.running) return;

    var code = editor.getValue();
    if (!code.trim()) {
      clearConsole();
      note('编辑器里还没有代码，先写一点再运行吧。');
      return;
    }

    try { localStorage.setItem(STORE_KEY, code); } catch (e) { /* 忽略 */ }

    clearConsole();
    sawOutput = false;
    runtime.running = true;
    setStatus('busy', '正在运行…');
    updateButtons();

    worker.postMessage({ type: 'run', code: code, stdin: stdinLines() });
  }

  /* 死循环等卡住的程序：终止 worker 并重建运行环境（资源已缓存，重建很快） */
  function stop() {
    if (!runtime.running) return;
    runtime.running = false;
    runtime.ready = false;
    note('已停止。');
    spawn();
  }

  el.btnRun.addEventListener('click', run);
  el.btnStop.addEventListener('click', stop);
  el.btnClear.addEventListener('click', function () {
    clearConsole();
    note('结果已清空。');
    el.btnClear.blur();
  });

  /* ------------------------------------------------------------ 启动 -- */

  clearConsole();
  note('正在准备 Python 运行环境，第一次打开需要等一会儿…');
  updateButtons();
  spawn();
})();
