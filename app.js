/* ==========================================================================
   app.js — Python 练习场（极简版）
   只做三件事：把代码交给 worker 运行、把结果打印到右侧、把运行环境的准备
   进度显示在顶栏。运行环境（Pyodide / CPython 3.11）由 runner.worker.js
   在后台加载，两者通过 postMessage 通信（消息格式 { type, payload }）。

   输入是「动态」的：程序执行到 input() 时会就地停住，结果区出现一行输入框，
   敲完回车程序才继续——像真实程序那样一问一答，而不是预先在下面填一串行。
   这条通道由 Service Worker（stdin-sw.js）配合 Worker 内的同步 XHR 实现。
   ========================================================================== */
(function () {
  'use strict';

  var DEFAULT_CODE = [
    '# 在这里写你的代码，然后点右上角的「运行」',
    '',
    'print("Hello, World!")',
    ''
  ].join('\n');

  var EXAMPLE_INPUT = [
    '# 程序跑到 input() 会停下来等你输入，敲完回车它就继续',
    '',
    'name = input("你叫什么名字？")',
    'age = int(input("你几岁了？"))',
    '',
    'print("你好，" + name + "！")',
    'print("明年你就 " + str(age + 1) + " 岁了。")',
    ''
  ].join('\n');

  var STORE_KEY = 'pyide.simple.code';
  var SW_RELOAD_KEY = 'pyide.simple.swReload';
  var PING_MS = 15000;    // 等待输入期间给 Service Worker 保活

  var el = {
    console: document.getElementById('console'),
    editorBox: document.getElementById('editor'),
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
  var awaiting = null;                        // 当前正在等待输入的请求 { id, row }
  var pingTimer = null;

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
    closeInputRow();
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

  /* 输入回显：让初学者看清程序到底拿到了什么。
     同时把尚未结束的输出行收尾——否则程序继续打印时会接在提示语那一行的
     后面，而回显行会留在下面，看起来就错位了。 */
  function echoInput(text) {
    out.stdout = out.stderr = null;
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

  /* -------------------------------------------------------- 输入通道 -- */

  /* 结果区里的一行输入框：程序停在这里等，敲完回车它才继续。 */
  function closeInputRow() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (!awaiting) return;
    if (awaiting.row && awaiting.row.parentNode) awaiting.row.parentNode.removeChild(awaiting.row);
    awaiting = null;
  }

  function openInputRow(id) {
    if (awaiting && awaiting.id === id) return;   // Worker 与 Service Worker 都通知了，只开一次
    closeInputRow();

    var row = document.createElement('div');
    row.className = 'row ask';

    var mark = document.createElement('span');
    mark.className = 'ask-mark';
    mark.textContent = '>';
    mark.setAttribute('aria-hidden', 'true');

    var input = document.createElement('input');
    input.className = 'ask-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', '程序正在等待输入，请输入一行后回车');

    var eofBtn = document.createElement('button');
    eofBtn.className = 'ask-eof';
    eofBtn.type = 'button';
    eofBtn.textContent = '结束输入';

    row.appendChild(mark);
    row.appendChild(input);
    row.appendChild(eofBtn);
    el.console.appendChild(row);
    scrollDown();

    awaiting = { id: id, row: row, input: input };

    function submit(text) {
      if (!awaiting || awaiting.id !== id) return;
      echoInput(text);
      closeInputRow();
      sendToStdin({ type: 'line', id: id, line: text });
      setStatus('busy', '正在运行…');
    }

    function sendEof() {
      if (!awaiting || awaiting.id !== id) return;
      out.stdout = out.stderr = null;
      note('已结束输入（程序读到的就是「输入结束」）。');
      closeInputRow();
      sendToStdin({ type: 'eof', id: id });
      setStatus('busy', '正在运行…');
    }

    input.addEventListener('keydown', function (ev) {
      if (ev.isComposing || ev.keyCode === 229) return;      // 输入法组字中，交给输入法
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit(input.value);
      } else if (ev.ctrlKey && (ev.key === 'd' || ev.key === 'D')) {
        ev.preventDefault();
        sendEof();
      }
    });
    eofBtn.addEventListener('click', function () { eofBtn.blur(); sendEof(); });
    row.addEventListener('mousedown', function (ev) {
      if (ev.target !== eofBtn && ev.target !== input) setTimeout(function () { input.focus(); }, 0);
    });

    input.focus();

    // Service Worker 在等待期间可能被回收，定期发一条消息给它保活
    pingTimer = setInterval(function () { sendToStdin({ type: 'ping' }); }, PING_MS);
  }

  function sendToStdin(msg) {
    var c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (c) c.postMessage(msg);
  }

  /* 注册输入通道并等它真正接管本页：只有被接管的页面（及其 Worker）发出的
     同步 XHR 才会落到 Service Worker 手里，否则会打到网络拿到 404。 */
  function ensureInputChannel() {
    if (!('serviceWorker' in navigator) || !self.isSecureContext) return Promise.resolve(false);
    if (navigator.serviceWorker.controller) return Promise.resolve(true);

    return navigator.serviceWorker.register('stdin-sw.js', { scope: './' })
      .then(function () { return navigator.serviceWorker.ready; })
      .then(function () {
        if (navigator.serviceWorker.controller) return true;
        return new Promise(function (resolve) {
          var settled = false;
          var finish = function (v) { if (!settled) { settled = true; resolve(v); } };
          navigator.serviceWorker.addEventListener('controllerchange', function () { finish(true); });
          setTimeout(function () { finish(!!navigator.serviceWorker.controller); }, 4000);
        });
      })
      .then(function (ok) {
        if (ok || navigator.serviceWorker.controller) return true;
        // 首次访问时页面可能还没被接管：刷新一次即可（用会话标记防止反复刷新）
        var tried = false;
        try { tried = sessionStorage.getItem(SW_RELOAD_KEY) === '1'; } catch (e) { /* 忽略 */ }
        if (!tried) {
          try { sessionStorage.setItem(SW_RELOAD_KEY, '1'); } catch (e) { /* 忽略 */ }
          location.reload();
          return new Promise(function () { /* 页面即将刷新，不再继续 */ });
        }
        return false;
      })
      .catch(function () { return false; });
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

      /* 程序停在这里等输入：开出一行输入框 */
      case 'stdin-request':
        openInputRow(payload && payload.id);
        setStatus('busy', '程序在等你输入，敲完按回车');
        break;

      /* 输入通道没接上（例如 Service Worker 不可用）：说清原因，别静默 */
      case 'stdin-fail':
        closeInputRow();
        note(String(payload));
        break;

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
    closeInputRow();
    updateButtons();

    if (result.images && result.images.length) {
      for (var i = 0; i < result.images.length; i++) addImage(result.images[i]);
    }

    if (!result.ok) {
      write('stderr', (result.error || '运行出错') + '\n');
      if (/EOFError/.test(result.error || '')) {
        note('程序在读输入时遇到了「输入结束」。想再输入一次，直接点「运行」重新开始即可。');
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

    worker.postMessage({ type: 'run', code: code });
  }

  /* 死循环等卡住的程序：终止 worker 并重建运行环境（资源已缓存，重建很快） */
  function stop() {
    if (!runtime.running) return;
    var waiting = awaiting && awaiting.id;
    runtime.running = false;
    runtime.ready = false;
    closeInputRow();
    // 只放走本次运行挂着的那一个输入请求。不带 id 的全清会把别的标签页
    // 正在等待的输入也放走，那边就会莫名读到「输入结束」。
    if (waiting) sendToStdin({ type: 'cancel', id: waiting });
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

  /* 关页面 / 刷新时把挂着的那一个输入请求释放掉，
     别让它一直悬在 Service Worker 上（悬着的请求会让 SW 迟迟无法被回收） */
  window.addEventListener('pagehide', function () {
    if (awaiting) sendToStdin({ type: 'cancel', id: awaiting.id });
  });

  /* 结果区标题栏上的示例按钮：放一段会用到 input() 的代码，方便立刻体验动态输入 */
  var btnExample = document.getElementById('btnExample');
  if (btnExample) {
    btnExample.addEventListener('click', function () {
      editor.setValue(EXAMPLE_INPUT);
      btnExample.blur();
      note('已放入示例代码。点右上角「运行」试试——程序会停下来等你输入。');
    });
  }

  /* ------------------------------------------------------------ 启动 -- */

  clearConsole();
  note('正在准备 Python 运行环境，第一次打开需要等一会儿…');
  updateButtons();
  setStatus('loading', '正在准备输入通道…');

  ensureInputChannel().then(function (ok) {
    if (!ok) {
      note('提示：当前环境无法启用交互式输入（Service Worker 不可用），'
        + '程序里的 input() 会直接读到「输入结束」。');
    }
    spawn();
  });
})();
