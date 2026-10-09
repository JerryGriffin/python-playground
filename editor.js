/* ==========================================================================
   editor.js — 零依赖的 Python 代码编辑器
   实现：语法高亮层（pre）+ 透明输入层（textarea）叠加对齐，
        行号、Tab 缩进、自动续行、注释切换、快捷键。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ 词法定义 -- */

  var KEYWORDS = words('False None True and as assert async await break class continue def del '
    + 'elif else except finally for from global if import in is lambda nonlocal not or pass raise '
    + 'return try while with yield match case');

  var BUILTINS = words('abs aiter all any anext ascii bin bool breakpoint bytearray bytes callable '
    + 'chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format '
    + 'frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list '
    + 'locals map max memoryview min next object oct open ord pow print property range repr reversed '
    + 'round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ '
    + 'Exception BaseException ValueError TypeError KeyError IndexError NameError AttributeError '
    + 'ZeroDivisionError StopIteration GeneratorExit OSError FileNotFoundError FileExistsError '
    + 'ArithmeticError AssertionError NotImplementedError OverflowError ImportError ModuleNotFoundError '
    + 'UnboundLocalError RuntimeError RecursionError SyntaxError IndentationError TabError EOFError '
    + 'LookupError InterruptedError ConnectionError TimeoutError Warning DeprecationWarning');

  var SPECIAL = words('self cls __name__ __main__ __doc__ __file__');

  var TOKEN_RE = new RegExp([
    '(#[^\\n]*)',                                                            // 1 注释
    "('''[\\s\\S]*?'''|\"\"\"[\\s\\S]*?\"\"\")",                               // 2 三引号字符串
    "('(?:\\\\.|[^'\\\\\\n])*'|\"(?:\\\\.|[^\"\\\\\\n])*\")",                  // 3 普通字符串
    '(\\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?[jJ]?)\\b)', // 4 数字
    '(@[A-Za-z_][\\w.]*)',                                                   // 5 装饰器
    '([A-Za-z_]\\w*)'                                                        // 6 标识符
  ].join('|'), 'g');

  function words(s) {
    var set = Object.create(null);
    s.split(/\s+/).forEach(function (w) { if (w) set[w] = true; });
    return set;
  }

  function esc(s) {
    return s.replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }

  function wrap(cls, text) {
    return '<span class="' + cls + '">' + esc(text) + '</span>';
  }

  function highlight(code) {
    var out = '';
    var last = 0;
    var m;
    TOKEN_RE.lastIndex = 0;

    while ((m = TOKEN_RE.exec(code)) !== null) {
      if (m[0].length === 0) { TOKEN_RE.lastIndex++; continue; }
      if (m.index > last) out += esc(code.slice(last, m.index));
      last = TOKEN_RE.lastIndex;

      if (m[1] !== undefined) {
        out += wrap('tok-com', m[1]);
      } else if (m[2] !== undefined) {
        out += wrap('tok-str', m[2]);
      } else if (m[3] !== undefined) {
        out += wrap('tok-str', m[3]);
      } else if (m[4] !== undefined) {
        out += wrap('tok-num', m[4]);
      } else if (m[5] !== undefined) {
        out += wrap('tok-dec', m[5]);
      } else {
        var w = m[6];
        var cls;
        if (KEYWORDS[w]) cls = 'tok-kw';
        else if (SPECIAL[w]) cls = 'tok-self';
        else if (BUILTINS[w]) cls = 'tok-bi';
        else if (/^\s*\(/.test(code.slice(TOKEN_RE.lastIndex))) cls = 'tok-fn';
        else if (/^[A-Z]/.test(w)) cls = 'tok-cls';
        else cls = '';
        out += cls ? wrap(cls, w) : esc(w);
      }
    }
    out += esc(code.slice(last));
    return out;
  }

  /* ---------------------------------------------------------------- 主体 -- */

  var INDENT = '    ';

  function mount(container, options) {
    options = options || {};

    container.innerHTML =
      '<div class="ed-gutter"><div class="ed-gutter-inner"></div></div>'
      + '<div class="ed-scroll">'
      + '  <pre class="ed-hl" aria-hidden="true"><code></code></pre>'
      + '  <textarea id="edTa" spellcheck="false" autocapitalize="off" autocomplete="off" '
      + 'wrap="off" aria-label="Python 代码编辑器"></textarea>'
      + '</div>';

    var ta = container.querySelector('#edTa');
    var hl = container.querySelector('.ed-hl code');
    var pre = container.querySelector('.ed-hl');
    var gutterInner = container.querySelector('.ed-gutter-inner');
    var scrollHost = container.querySelector('.ed-scroll');

    var state = { value: '' };
    var completion = null;   // 补全层（complete.js 提供），未加载时为 null

    function renderHighlight() {
      var text = ta.value;
      state.value = text;

      var lines = text.split('\n');
      var nums = new Array(lines.length);
      for (var i = 0; i < lines.length; i++) nums[i] = i + 1;

      hl.innerHTML = highlight(text) + '\n';
      gutterInner.textContent = nums.join('\n');

      if (options.onChange) options.onChange(text, lines.length, text.length);
    }

    var pending = false;
    function schedule() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; renderHighlight(); });
    }

    function syncScroll() {
      pre.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
      gutterInner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
      if (completion) completion.reposition();
    }

    ta.addEventListener('input', function () {
      renderHighlight();
      syncScroll();
      if (completion) completion.onInput();
    });
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keydown', onKeyDown);

    /* Tab 补全层：由 complete.js 提供。它不修改编辑器内部状态，
       只通过下面这组回调改写文本，因此两边职责清晰、可独立演进。 */
    if (global.PyComplete) {
      completion = global.PyComplete.attach({
        el: ta,
        host: scrollHost,
        setRangeText: function (text, start, end) {
          ta.setRangeText(text, start, end, 'end');
        },
        onAfterInsert: function () {
          renderHighlight();
          syncScroll();
        }
      });
    }

    /* ----------------------------------------------------------- 快捷键 -- */

    function onKeyDown(e) {
      var ctrl = e.ctrlKey || e.metaKey;

      // 补全层优先处理：Tab 补全、候选导航、确认与关闭
      if (completion && completion.handleKey(e)) return;

      if (ctrl && e.key === 'Enter') {
        e.preventDefault();
        if (options.onRun) options.onRun();
        return;
      }

      if (ctrl && (e.key === '/' || e.key === '?')) {
        e.preventDefault();
        toggleComment();
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) dedentLines(); else indentLines();
        return;
      }

      if (e.key === 'Enter') {
        if (e.shiftKey) return;
        var before = ta.value.slice(0, ta.selectionStart);
        var line = before.slice(before.lastIndexOf('\n') + 1);
        var indent = (line.match(/^[ \t]*/) || [''])[0];
        var extra = /:\s*$/.test(line) ? INDENT : '';
        if (!indent && !extra) return;
        e.preventDefault();
        insert('\n' + indent + extra, 'end');
      }
    }

    function insert(text, mode) {
      var start = ta.selectionStart;
      var end = ta.selectionEnd;
      if (mode === 'block') {
        ta.setRangeText(text, start, end, 'select');
      } else {
        ta.setRangeText(text, start, end, 'end');
      }
      renderHighlight();
      syncScroll();
    }

    function selectedLineRange() {
      var value = ta.value;
      var start = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      var end = value.indexOf('\n', ta.selectionEnd);
      if (end === -1) end = value.length;
      return [start, end];
    }

    function indentLines() {
      var value = ta.value;
      var range = selectedLineRange();
      if (range[0] === range[1]) { insert(INDENT, 'end'); return; }
      var block = value.slice(range[0], range[1]);
      var next = block.split('\n').map(function (l) { return l.length ? INDENT + l : l; }).join('\n');
      ta.setSelectionRange(range[0], range[1]);
      insert(next, 'block');
      ta.setSelectionRange(range[0], range[0] + next.length);
    }

    function dedentLines() {
      var value = ta.value;
      var range = selectedLineRange();
      var block = value.slice(range[0], range[1]);
      var changed = false;
      var next = block.split('\n').map(function (l) {
        var m = l.match(/^ {1,4}|\t/);
        if (!m) return l;
        changed = true;
        return l.slice(m[0].length);
      }).join('\n');
      if (!changed) return;
      ta.setSelectionRange(range[0], range[1]);
      insert(next, 'block');
      ta.setSelectionRange(range[0], range[0] + next.length);
    }

    function toggleComment() {
      var value = ta.value;
      var range = selectedLineRange();
      var lines = value.slice(range[0], range[1]).split('\n');
      var allCommented = lines.every(function (l) { return !l.trim() || /^\s*#/.test(l); });
      var next = lines.map(function (l) {
        if (!l.trim()) return l;
        if (allCommented) return l.replace(/^(\s*)#\s?/, '$1');
        return l.replace(/^(\s*)/, '$1# ');
      }).join('\n');
      ta.setSelectionRange(range[0], range[1]);
      insert(next, 'block');
      ta.setSelectionRange(range[0], range[0] + next.length);
    }

    /* ------------------------------------------------------------- API -- */

    function setValue(text) {
      if (completion) completion.close();
      ta.value = text;
      renderHighlight();
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
      syncScroll();
    }

    ta.addEventListener('dragover', function (e) { e.preventDefault(); });

    renderHighlight();
    syncScroll();

    var api = {
      el: ta,
      getValue: function () { return ta.value; },
      setValue: setValue,
      focus: function () { ta.focus(); },
      scrollToTop: function () { ta.scrollTop = 0; syncScroll(); },
      insertSnippet: function (text) {
        var start = ta.selectionStart;
        ta.setRangeText(text, start, ta.selectionEnd, 'end');
        ta.focus();
        renderHighlight();
      },
      getSelection: function () {
        return ta.value.slice(ta.selectionStart, ta.selectionEnd);
      }
    };

    global.addEventListener('resize', syncScroll);
    return api;
  }

  /* words 暴露给 complete.js：补全需要与高亮共用同一份关键字/内置名单，
     避免两处维护出现漂移。 */
  global.PyEditor = {
    mount: mount,
    highlight: highlight,
    words: { kw: KEYWORDS, bi: BUILTINS, sp: SPECIAL }
  };
})(window);
