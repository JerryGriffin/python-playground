/* ==========================================================================
   complete.js — Tab 补全（零依赖，叠加在自研编辑器之上）
   能力：
     · 词补全：Python 关键字、内置函数、文档内出现过的标识符
     · 点号补全：已导入模块（math/random/os/sys/json/string/time）、
                 由字面量推断出的对象类型（str/list/dict/tuple/set）
     · 交互：Tab 触发与确认、Ctrl+Space 强制触发、↑↓ 选择、Enter 确认、Esc 关闭
   与编辑器的契约：由 editor.js 在 mount() 时调用 attach(ctx)，
   并通过 handleKey(ev) 让它优先于编辑器快捷键处理按键。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ 知识库 -- */

  /* 内置对象的一句话说明（缺失则不显示说明，不影响补全） */
  var BUILTIN_DOC = {
    abs: 'abs(x) → x 的绝对值',
    aiter: 'aiter(async_iterable) → 异步迭代器',
    all: 'all(iterable) → 全部为真才为 True',
    any: 'any(iterable) → 有一个为真就是 True',
    ascii: 'ascii(obj) → 转成可打印的 ASCII 表示',
    bin: 'bin(x) → 二进制字符串，如 0b1010',
    bool: 'bool(x) → 转成 True / False',
    breakpoint: 'breakpoint() → 进入调试器',
    bytearray: 'bytearray(...) → 可变的字节串',
    bytes: 'bytes(...) → 不可变的字节串',
    callable: 'callable(obj) → 能不能像函数那样调用',
    chr: 'chr(i) → 码位换成字符，如 chr(65) 是 "A"',
    classmethod: 'classmethod(fn) → 类方法装饰器',
    compile: 'compile(src, ...) → 编译成代码对象',
    complex: 'complex(real, imag) → 复数',
    delattr: 'delattr(obj, name) → 删除属性',
    dict: 'dict(...) → 字典',
    dir: 'dir(obj) → 列出所有属性名',
    divmod: 'divmod(a, b) → (商, 余数)',
    enumerate: 'enumerate(seq, start=0) → 带序号的迭代',
    eval: 'eval(expr) → 计算一个表达式',
    exec: 'exec(code) → 执行一段代码',
    filter: 'filter(fn, seq) → 过滤出符合条件的元素',
    float: 'float(x) → 浮点数',
    format: 'format(value, spec) → 按格式转成字符串',
    frozenset: 'frozenset(...) → 不可变的集合',
    getattr: 'getattr(obj, name[, default]) → 取属性',
    globals: 'globals() → 全局变量的字典',
    hasattr: 'hasattr(obj, name) → 有没有这个属性',
    hash: 'hash(obj) → 哈希值',
    help: 'help(obj) → 查看帮助',
    hex: 'hex(x) → 十六进制字符串',
    id: 'id(obj) → 对象的唯一编号',
    input: 'input(prompt="") → 读取一行输入',
    int: 'int(x, base=10) → 整数',
    isinstance: 'isinstance(obj, cls) → 是不是这个类型的实例',
    issubclass: 'issubclass(cls, base) → 是不是它的子类',
    iter: 'iter(obj) → 取迭代器',
    len: 'len(obj) → 元素个数',
    list: 'list(iterable) → 列表',
    locals: 'locals() → 局部变量的字典',
    map: 'map(fn, *seqs) → 逐项处理后返回',
    max: 'max(...) → 最大值',
    memoryview: 'memoryview(obj) → 内存视图',
    min: 'min(...) → 最小值',
    next: 'next(it[, default]) → 下一个元素',
    object: 'object() → 所有类的祖先',
    oct: 'oct(x) → 八进制字符串',
    open: 'open(file, mode="r") → 打开文件',
    ord: 'ord(ch) → 字符换成码位，如 ord("A") 是 65',
    pow: 'pow(a, b[, mod]) → a 的 b 次方',
    print: 'print(*objects, sep=" ", end="\\n") → 打印到屏幕',
    property: 'property(fget, fset) → 属性装饰器',
    range: 'range(start, stop[, step]) → 整数序列',
    repr: 'repr(obj) → 给解释器看的表示',
    reversed: 'reversed(seq) → 倒序迭代',
    round: 'round(x[, n]) → 四舍五入保留 n 位',
    set: 'set(iterable) → 集合',
    setattr: 'setattr(obj, name, value) → 设置属性',
    slice: 'slice(start, stop[, step]) → 切片对象',
    sorted: 'sorted(seq, key=None, reverse=False) → 排序后的新列表',
    staticmethod: 'staticmethod(fn) → 静态方法装饰器',
    str: 'str(obj) → 字符串',
    sum: 'sum(seq[, start]) → 求和',
    super: 'super() → 父类代理，用于调用父类方法',
    tuple: 'tuple(iterable) → 元组',
    type: 'type(obj) → 类型',
    vars: 'vars(obj) → 属性字典',
    zip: 'zip(*seqs) → 多个序列并行迭代',

    Exception: 'Exception → 所有常规异常的基类',
    BaseException: 'BaseException → 所有异常的基类',
    ValueError: 'ValueError → 值不合适，如 int("abc")',
    TypeError: 'TypeError → 类型不对',
    KeyError: 'KeyError → 字典里没有这个键',
    IndexError: 'IndexError → 下标越界',
    NameError: 'NameError → 用了没定义的名字',
    AttributeError: 'AttributeError → 对象没有这个属性',
    ZeroDivisionError: 'ZeroDivisionError → 除以 0',
    StopIteration: 'StopIteration → 迭代结束',
    OSError: 'OSError → 操作系统层面的错误',
    FileNotFoundError: 'FileNotFoundError → 找不到文件',
    ArithmeticError: 'ArithmeticError → 算术错误',
    AssertionError: 'AssertionError → assert 断言失败',
    ImportError: 'ImportError → 导入失败',
    ModuleNotFoundError: 'ModuleNotFoundError → 找不到模块',
    RuntimeError: 'RuntimeError → 运行期错误',
    RecursionError: 'RecursionError → 递归太深',
    SyntaxError: 'SyntaxError → 语法错误',
    IndentationError: 'IndentationError → 缩进错误',
    UnboundLocalError: 'UnboundLocalError → 变量在用之前没赋值',
    EOFError: 'EOFError → 读输入时遇到了结束',
    Warning: 'Warning → 警告的基类'
  };

  /* 模块成员表：点号前是这些名字时，给出该模块的常用成员 */
  var MODULE_MEMBERS = {
    math: {
      pi: '圆周率 π ≈ 3.14159', e: '自然常数 e ≈ 2.71828', tau: '2π ≈ 6.28318',
      inf: '正无穷大', nan: '非数字（Not a Number）',
      sqrt: 'sqrt(x) → 平方根', pow: 'pow(x, y) → x 的 y 次方',
      exp: 'exp(x) → e 的 x 次方', log: 'log(x[, base]) → 对数',
      log2: 'log2(x) → 以 2 为底的对数', log10: 'log10(x) → 以 10 为底的对数',
      sin: 'sin(x) → 正弦（弧度）', cos: 'cos(x) → 余弦（弧度）', tan: 'tan(x) → 正切（弧度）',
      asin: 'asin(x) → 反正弦', acos: 'acos(x) → 反余弦', atan: 'atan(x) → 反正切',
      atan2: 'atan2(y, x) → 两参数反正切', hypot: 'hypot(x, y) → 直角三角形斜边',
      floor: 'floor(x) → 向下取整', ceil: 'ceil(x) → 向上取整', trunc: 'trunc(x) → 去掉小数部分',
      fabs: 'fabs(x) → 绝对值（浮点）', factorial: 'factorial(n) → n 的阶乘',
      gcd: 'gcd(a, b) → 最大公约数', lcm: 'lcm(a, b) → 最小公倍数',
      degrees: 'degrees(x) → 弧度转角度', radians: 'radians(x) → 角度转弧度',
      isclose: 'isclose(a, b) → 两个浮点数是否足够接近',
      isfinite: 'isfinite(x) → 是不是有限数', isnan: 'isnan(x) → 是不是 NaN',
      fsum: 'fsum(seq) → 更精确的求和', prod: 'prod(seq) → 连乘',
      comb: 'comb(n, k) → 组合数 C(n, k)', perm: 'perm(n, k) → 排列数 A(n, k)'
    },
    random: {
      random: 'random() → 0 到 1 之间的随机小数',
      randint: 'randint(a, b) → 含两端的随机整数',
      randrange: 'randrange(start, stop[, step]) → 随机整数',
      uniform: 'uniform(a, b) → 区间内的随机小数',
      choice: 'choice(seq) → 随机取一个元素',
      choices: 'choices(seq, k=1) → 随机取 k 个（可重复）',
      sample: 'sample(seq, k) → 随机取 k 个（不重复）',
      shuffle: 'shuffle(list) → 就地打乱顺序',
      gauss: 'gauss(mu, sigma) → 正态分布随机数',
      seed: 'seed(a=None) → 设定随机种子'
    },
    os: {
      getcwd: 'getcwd() → 当前目录', chdir: 'chdir(path) → 切换目录',
      listdir: 'listdir(path=".") → 目录下的文件名列表',
      mkdir: 'mkdir(path) → 新建目录', makedirs: 'makedirs(path) → 递归建目录',
      rmdir: 'rmdir(path) → 删除空目录', remove: 'remove(path) → 删除文件',
      rename: 'rename(src, dst) → 重命名', walk: 'walk(path) → 递归遍历目录',
      environ: 'environ → 环境变量字典', sep: 'sep → 路径分隔符',
      linesep: 'linesep → 换行符', name: 'name → 操作系统名',
      path: 'path → os.path 子模块（拼接/判断路径）', system: 'system(cmd) → 执行系统命令'
    },
    path: {
      join: 'join(a, b, ...) → 拼接路径',
      exists: 'exists(path) → 路径是否存在',
      isfile: 'isfile(path) → 是不是文件', isdir: 'isdir(path) → 是不是目录',
      basename: 'basename(path) → 文件名部分', dirname: 'dirname(path) → 目录部分',
      abspath: 'abspath(path) → 绝对路径', splitext: 'splitext(path) → (主干, 扩展名)',
      split: 'split(path) → (目录, 文件名)', getsize: 'getsize(path) → 文件大小（字节）'
    },
    sys: {
      argv: 'argv → 命令行参数列表', version: 'version → Python 版本字符串',
      platform: 'platform → 运行平台', exit: 'exit([code]) → 退出程序',
      maxsize: 'maxsize → 整数最大值', path: 'path → 模块搜索路径列表',
      modules: 'modules → 已导入模块的字典', stdin: 'stdin → 标准输入',
      stdout: 'stdout → 标准输出', stderr: 'stderr → 标准错误',
      getsizeof: 'getsizeof(obj) → 占用的字节数'
    },
    json: {
      dumps: 'dumps(obj) → 转成 JSON 字符串',
      loads: 'loads(s) → 把 JSON 字符串转成 Python 对象',
      dump: 'dump(obj, file) → 写到文件', load: 'load(file) → 从文件读'
    },
    string: {
      ascii_lowercase: 'ascii_lowercase → 小写字母', ascii_uppercase: 'ascii_uppercase → 大写字母',
      ascii_letters: 'ascii_letters → 大小写字母', digits: 'digits → 数字字符 0-9',
      punctuation: 'punctuation → 标点符号', whitespace: 'whitespace → 空白字符',
      printable: 'printable → 可打印字符', capwords: 'capwords(s) → 每个单词首字母大写'
    },
    time: {
      time: 'time() → 当前时间戳（秒）', sleep: 'sleep(sec) → 暂停若干秒',
      perf_counter: 'perf_counter() → 高精度计时器',
      strftime: 'strftime(fmt, t) → 格式化时间',
      localtime: 'localtime([t]) → 本地时间结构', gmtime: 'gmtime([t]) → UTC 时间结构',
      monotonic: 'monotonic() → 单调递增的计时器',
      time_ns: 'time_ns() → 当前时间戳（纳秒）'
    }
  };

  /* 已导入模块：用于判断「名字.」里的名字是不是模块 */
  var KNOWN_MODULES = ['math', 'random', 'os', 'sys', 'json', 'string', 'time', 're',
    'collections', 'itertools', 'functools', 'pathlib', 'datetime', 'tkinter'];

  /* 内建类型的常用成员 */
  var TYPE_MEMBERS = {
    str: {
      upper: 'upper() → 全大写', lower: 'lower() → 全小写',
      strip: 'strip() → 去掉两端空白', lstrip: 'lstrip() → 去掉左侧空白',
      rstrip: 'rstrip() → 去掉右侧空白', split: 'split(sep=None) → 切成列表',
      rsplit: 'rsplit(sep=None) → 从右往左切', splitlines: 'splitlines() → 按行切成列表',
      join: 'join(seq) → 用自己把 seq 连起来', replace: 'replace(old, new) → 替换',
      find: 'find(sub) → 找子串，找不到返回 -1', rfind: 'rfind(sub) → 从右往左找',
      index: 'index(sub) → 找子串，找不到报错', count: 'count(sub) → 出现次数',
      startswith: 'startswith(prefix) → 是不是以它开头', endswith: 'endswith(suffix) → 是不是以它结尾',
      format: 'format(*args) → 格式化', capitalize: 'capitalize() → 首字母大写',
      title: 'title() → 每个单词首字母大写', swapcase: 'swapcase() → 大小写互换',
      casefold: 'casefold() → 更彻底的小写（比较用）',
      center: 'center(width) → 居中补空格', ljust: 'ljust(width) → 左对齐补空格',
      rjust: 'rjust(width) → 右对齐补空格', zfill: 'zfill(width) → 左侧补 0',
      isdigit: 'isdigit() → 是不是全是数字', isalpha: 'isalpha() → 是不是全是字母',
      isalnum: 'isalnum() → 是不是字母或数字', isspace: 'isspace() → 是不是全是空白',
      isupper: 'isupper() → 是不是全大写', islower: 'islower() → 是不是全小写',
      encode: 'encode(encoding="utf-8") → 转成 bytes',
      partition: 'partition(sep) → 切成三段的元组',
      removeprefix: 'removeprefix(p) → 去掉开头的前缀',
      removesuffix: 'removesuffix(s) → 去掉结尾的后缀'
    },
    list: {
      append: 'append(x) → 末尾追加一个元素', extend: 'extend(seq) → 末尾追加一串',
      insert: 'insert(i, x) → 在下标 i 处插入', remove: 'remove(x) → 删掉第一个 x',
      pop: 'pop([i]) → 取出并删除（默认最后一个）', clear: 'clear() → 清空',
      index: 'index(x) → 找下标', count: 'count(x) → 出现次数',
      sort: 'sort(key=None, reverse=False) → 就地排序',
      reverse: 'reverse() → 就地倒序', copy: 'copy() → 浅拷贝一份'
    },
    dict: {
      keys: 'keys() → 所有键', values: 'values() → 所有值',
      items: 'items() → 所有 (键, 值) 对', get: 'get(k[, default]) → 取键，没有就用默认值',
      pop: 'pop(k[, default]) → 取出并删除', popitem: 'popitem() → 取出最后一对',
      update: 'update(other) → 用另一份字典更新自己',
      setdefault: 'setdefault(k[, default]) → 没有就设上再返回',
      clear: 'clear() → 清空', copy: 'copy() → 浅拷贝一份'
    },
    tuple: { count: 'count(x) → 出现次数', index: 'index(x) → 找下标' },
    set: {
      add: 'add(x) → 添加元素', discard: 'discard(x) → 删除（没有也不报错）',
      remove: 'remove(x) → 删除（没有会报错）', pop: 'pop() → 随机取出一个',
      clear: 'clear() → 清空', copy: 'copy() → 拷贝一份',
      union: 'union(other) → 并集', intersection: 'intersection(other) → 交集',
      difference: 'difference(other) → 差集',
      symmetric_difference: 'symmetric_difference(other) → 对称差集',
      issubset: 'issubset(other) → 是不是子集', issuperset: 'issuperset(other) → 是不是超集',
      isdisjoint: 'isdisjoint(other) → 有没有交集（没有为 True）'
    }
  };

  /* 任何对象都可能有的一批特殊方法，排在候选末尾 */
  var DUNDERS = ['__init__', '__str__', '__repr__', '__len__', '__iter__', '__next__',
    '__getitem__', '__setitem__', '__enter__', '__exit__', '__eq__', '__lt__', '__name__', '__main__'];

  var DUNDER_DOC = {
    __init__: '构造对象时自动调用', __str__: 'str(obj) 时调用，给人看的文本',
    __repr__: 'repr(obj) 时调用，给解释器看的文本', __len__: 'len(obj) 时调用',
    __iter__: 'for 循环时调用，返回迭代器', __next__: '取下一个元素',
    __getitem__: 'obj[key] 时调用', __setitem__: 'obj[key] = v 时调用',
    __enter__: 'with 语句进入时调用', __exit__: 'with 语句离开时调用',
    __eq__: '判断 == 时调用', __lt__: '判断 < 时调用',
    __name__: '模块名，直接运行时是 "__main__"', __main__: '模块被直接运行时的名字'
  };

  var KIND_TAG = { kw: '关键字', bi: '内置', mod: '模块', attr: '方法', var: '变量', fn: '函数', cls: '类', obj: '常量' };

  /* 关键字说明（只给初学者最常用的那批） */
  var KEYWORD_DOC = {
    if: 'if 条件: → 条件为真时执行', elif: 'elif 条件: → 否则如果', else: 'else: → 否则',
    for: 'for x in seq: → 依次取出每个元素', while: 'while 条件: → 条件为真就一直做',
    break: 'break → 立刻跳出循环', continue: 'continue → 跳过本轮，进入下一轮',
    def: 'def 名字(参数): → 定义函数', return: 'return 值 → 返回结果并结束函数',
    class: 'class 名字: → 定义类', import: 'import 模块 → 导入模块',
    from: 'from 模块 import 名字 → 从模块导入指定名字',
    as: 'as → 起个别名', in: 'in → 判断是否在其中 / 用于 for 循环',
    not: 'not → 取反', and: 'and → 并且（两边都为真）', or: 'or → 或者（有一边为真）',
    is: 'is → 是不是同一个对象', pass: 'pass → 什么都不做（占位）',
    try: 'try: → 尝试执行', except: 'except 异常类型: → 出错时执行',
    finally: 'finally: → 无论如何都会执行', raise: 'raise 异常 → 主动抛出异常',
    with: 'with 对象 as 名字: → 用完自动清理', lambda: 'lambda 参数: 表达式 → 匿名函数',
    global: 'global 名字 → 在函数里改全局变量', nonlocal: 'nonlocal 名字 → 改外层函数的变量',
    assert: 'assert 条件 → 断言，不成立就报错', yield: 'yield 值 → 产出（生成器）',
    del: 'del 名字 → 删除变量', None: 'None → 空值', True: 'True → 真', False: 'False → 假',
    await: 'await 协程 → 等待异步结果', async: 'async def → 定义协程函数',
    match: 'match 值: → 结构化匹配', case: 'case 模式: → 匹配的分支'
  };

  function words(s) {
    var set = Object.create(null);
    s.split(/\s+/).forEach(function (w) { if (w) set[w] = true; });
    return set;
  }

  /* ------------------------------------------------------- 代码解析工具 -- */

  /* 从文档里收集所有标识符，并顺带判断它们更像变量、函数还是类。
     skip 里是 Python 关键字——它们在正文里到处都是，作为补全候选是噪音。 */
  function collectSymbols(code, skip) {
    var map = Object.create(null);   // name -> kind
    skip = skip || {};

    // def / class 声明
    var reDef = /(^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g;
    var m;
    while ((m = reDef.exec(code)) !== null) map[m[2]] = 'fn';
    var reCls = /(^|\n)\s*class\s+([A-Za-z_]\w*)/g;
    while ((m = reCls.exec(code)) !== null) map[m[2]] = 'cls';

    // import 语句里的模块名
    var reImp = /(^|\n)\s*import\s+([^\n#]+)/g;
    while ((m = reImp.exec(code)) !== null) {
      m[2].split(',').forEach(function (part) {
        var name = part.trim().split(/\s+as\s+/).pop().trim().split('.')[0];
        if (/^[A-Za-z_]\w*$/.test(name)) map[name] = 'mod';
      });
    }

    // 赋值：优先保留 fn / cls，不被覆盖成 var
    var reAsg = /(^|\n)\s*([A-Za-z_]\w*)\s*(?:[-+*/%|&^]|>>|<<)?=(?!=)/g;
    while ((m = reAsg.exec(code)) !== null) {
      if (!map[m[2]]) map[m[2]] = 'var';
    }

    // 兜底：文档里出现过的其它标识符
    var reWord = /[A-Za-z_]\w*/g;
    while ((m = reWord.exec(code)) !== null) {
      if (!skip[m[0]] && !map[m[0]]) map[m[0]] = 'var';
    }
    return map;
  }

  /* 由 `name = 字面量` 粗略推断类型，用于点号补全 */
  function inferTypes(code) {
    var types = Object.create(null);
    var re = /(^|\n)\s*([A-Za-z_]\w*)\s*=\s*([^\n]*)/g;
    var m;
    while ((m = re.exec(code)) !== null) {
      var name = m[2];
      var rhs = m[3].trim();
      if (types[name]) continue;
      var t = literalType(rhs);
      if (t) types[name] = t;
    }
    return types;
  }

  function literalType(rhs) {
    if (!rhs) return null;
    if (/^[fFrRbBuU]{0,2}("""|''')/.test(rhs) || /^[fFrRbBuU]{0,2}["']/.test(rhs)) return 'str';
    if (/^\[/.test(rhs)) return 'list';
    if (/^\{/.test(rhs)) return rhs.indexOf(':') >= 0 ? 'dict' : 'set';
    if (/^\(/.test(rhs)) return 'tuple';
    if (/^(True|False)\s*$/.test(rhs)) return 'bool';
    if (/^\d+\.\d|^\d+[eE]/.test(rhs)) return 'float';
    if (/^\d/.test(rhs)) return 'int';
    return null;
  }

  function isImported(code, name) {
    if (KNOWN_MODULES.indexOf(name) === -1) return false;
    return new RegExp('(^|\\n)\\s*(import\\s+[^\\n]*\\b' + name + '\\b|from\\s+' + name + '\\b)').test(code);
  }

  /* 光标前的上下文：区分「词补全」与「点号补全」 */
  function contextAt(value, caret) {
    var before = value.slice(0, caret);
    var mem = /([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)?$/.exec(before);
    if (mem) {
      return {
        member: true,
        receiver: mem[1],
        start: caret - (mem[2] ? mem[2].length : 0),
        prefix: mem[2] || ''
      };
    }
    var w = /[A-Za-z_]\w*$/.exec(before);
    if (w) return { member: false, start: caret - w[0].length, prefix: w[0] };
    return { member: false, start: caret, prefix: '' };
  }

  /* ------------------------------------------------------------ 候选项 -- */

  function buildCandidates(ctx, code) {
    var out = [];
    var seen = Object.create(null);
    var wordsApi = (global.PyEditor && global.PyEditor.words) || {};
    var kws = wordsApi.kw || {};

    function add(name, kind, doc, prio) {
      if (!name || seen[name]) return;
      if (ctx.prefix) {
        if (name === ctx.prefix) return;                       // 与已输入内容完全相同，补它等于没补
        if (name.lastIndexOf(ctx.prefix, 0) !== 0) return;     // 不是以它开头
      }
      seen[name] = true;
      out.push({
        name: name, kind: kind, doc: doc || '',
        callable: isCallable(name, kind, doc),
        prio: prio
      });
    }

    if (ctx.member) {
      // ① 已导入模块 → 模块成员
      var modTable = null;
      if (MODULE_MEMBERS[ctx.receiver] && isImported(code, ctx.receiver)) modTable = MODULE_MEMBERS[ctx.receiver];
      else if (ctx.receiver === 'path' && /os\.path\./.test(code)) modTable = MODULE_MEMBERS.path;

      if (modTable) {
        for (var k in modTable) add(k, 'attr', modTable[k], 0);
      }

      // ② 由字面量推断出的类型 → 该类型的方法
      var types = inferTypes(code);
      var t = types[ctx.receiver];
      if (t && TYPE_MEMBERS[t]) {
        for (var kk in TYPE_MEMBERS[t]) add(kk, 'attr', TYPE_MEMBERS[t][kk], 1);
      }

      // ③ 文档里出现过的标识符（含 self 的属性名、自定义类成员）
      var syms = collectSymbols(code, kws);
      for (var name in syms) add(name, syms[name], '', 3);

      // ④ 通用特殊方法
      for (var i = 0; i < DUNDERS.length; i++) add(DUNDERS[i], 'attr', DUNDER_DOC[DUNDERS[i]], 5);
    } else {
      // 变量 / 函数 / 类 / 模块
      var syms2 = collectSymbols(code, kws);
      for (var n2 in syms2) add(n2, syms2[n2], '', 1);
      // 关键字
      for (var k2 in kws) add(k2, 'kw', KEYWORD_DOC[k2] || '', 2);
      // 内置
      var bis = wordsApi.bi || {};
      for (var b in bis) add(b, 'bi', BUILTIN_DOC[b], 2);
      // 特殊名字
      var sps = wordsApi.sp || {};
      for (var s in sps) add(s, 'obj', DUNDER_DOC[s] || '', 4);
    }

    out.sort(function (a, b) {
      if (a.prio !== b.prio) return a.prio - b.prio;
      var au = a.name.charAt(0) === '_' ? 1 : 0;
      var bu = b.name.charAt(0) === '_' ? 1 : 0;
      if (au !== bu) return au - bu;                     // 下划线开头的排在后面
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return out;
  }

  /* 是否顺手补一对括号：函数/类一定补；其余按说明文字里是否出现「名字(」来判断，
     这样 math.pi、os.sep 这类常量不会被误补成 pi()。 */
  function isCallable(name, kind, doc) {
    if (kind === 'fn' || kind === 'cls') return true;
    if (kind !== 'bi' && kind !== 'attr') return false;
    return (doc || '').indexOf(name + '(') === 0;
  }

  /* ------------------------------------------------------------ 交互层 -- */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  function attach(ctx) {
    var ta = ctx.el;
    var host = ctx.host || ta.parentNode;

    /* 量宽用：与编辑器字体/行高/tab-size 完全一致的隐藏测量块 */
    var probe = document.createElement('div');
    probe.className = 'ed-probe';
    probe.setAttribute('aria-hidden', 'true');
    host.appendChild(probe);

    var pop = document.createElement('div');
    pop.className = 'cmp-pop';
    pop.hidden = true;
    pop.setAttribute('role', 'listbox');
    host.appendChild(pop);

    var state = { open: false, items: [], index: 0, ctx: null };

    function metrics() {
      var cs = getComputedStyle(ta);
      return {
        padTop: parseFloat(cs.paddingTop) || 0,
        padLeft: parseFloat(cs.paddingLeft) || 0,
        lh: parseFloat(cs.lineHeight) || 20
      };
    }

    function caretXY() {
      var value = ta.value;
      var caret = ta.selectionStart;
      var before = value.slice(0, caret);
      var nl = before.lastIndexOf('\n');
      var lineIdx = before.split('\n').length - 1;
      var lineText = before.slice(nl + 1);

      var m = metrics();
      probe.textContent = lineText;
      var w = probe.getBoundingClientRect().width;

      return {
        x: m.padLeft + w - ta.scrollLeft,
        y: m.padTop + lineIdx * m.lh + m.lh - ta.scrollTop,
        lh: m.lh
      };
    }

    function reposition() {
      if (!state.open) return;
      var pos = caretXY();
      var pw = pop.offsetWidth || 260;
      var ph = pop.offsetHeight || 200;

      var x = pos.x;
      if (x + pw > host.clientWidth - 6) x = Math.max(4, host.clientWidth - pw - 6);
      var y = pos.y;
      if (y + ph > host.clientHeight - 6) y = Math.max(4, pos.y - pos.lh - ph);   // 下方放不下就翻到上方
      pop.style.left = Math.round(x) + 'px';
      pop.style.top = Math.round(y) + 'px';
    }

    function render() {
      if (!state.items.length) { close(); return; }

      var ctxNow = state.ctx;
      var html = '<div class="cmp-head">' + (ctxNow && ctxNow.member
        ? esc(ctxNow.receiver) + ' 的成员' : '补全') + ' · ' + state.items.length + ' 项</div>';
      html += '<ul class="cmp-list">';
      for (var i = 0; i < state.items.length; i++) {
        var it = state.items[i];
        var nameHtml = ctxNow && ctxNow.prefix
          ? '<b>' + esc(it.name.slice(0, ctxNow.prefix.length)) + '</b>' + esc(it.name.slice(ctxNow.prefix.length))
          : esc(it.name);
        html += '<li class="cmp-item' + (i === state.index ? ' on' : '') + '" data-i="' + i + '">'
          + '<span class="cmp-name">' + nameHtml + '</span>'
          + '<span class="cmp-tag k-' + it.kind + '">' + (KIND_TAG[it.kind] || '') + '</span>'
          + (it.doc ? '<span class="cmp-doc">' + esc(it.doc) + '</span>' : '')
          + '</li>';
      }
      html += '</ul><div class="cmp-foot"><kbd>Tab</kbd>/<kbd>Enter</kbd> 采用 · <kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Esc</kbd> 关闭</div>';
      pop.innerHTML = html;
      pop.hidden = false;
      state.open = true;
      scrollSelectedIntoView();
      reposition();
    }

    function scrollSelectedIntoView() {
      var el = pop.querySelector('.cmp-item.on');
      if (!el) return;
      var list = pop.querySelector('.cmp-list');
      if (!list) return;
      if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
      else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
      }
    }

    function close() {
      if (!state.open) return;
      state.open = false;
      state.items = [];
      state.index = 0;
      pop.hidden = true;
      pop.innerHTML = '';
    }

    function compute() {
      var value = ta.value;
      if (ta.selectionStart !== ta.selectionEnd) return null;
      var c = contextAt(value, ta.selectionStart);
      var items = buildCandidates(c, value);
      if (!items.length) return null;
      return { c: c, items: items };
    }

    function openWith(c, items, keepIndex) {
      state.ctx = c;
      state.items = items;
      if (!keepIndex || state.index >= items.length) state.index = 0;
      render();
    }

    function refresh(keepIndex) {
      var got = compute();
      if (!got) { close(); return; }
      openWith(got.c, got.items, keepIndex);
    }

    /* 采用候选项 */
    function insertItem(it, c) {
      var value = ta.value;
      var start = c.start;
      var end = ta.selectionStart;

      var text = it.name;
      var caretOffset = text.length;

      // 函数/类顺手补一对括号，并把光标放进括号里
      if (it.callable && value.charAt(end) !== '(') {
        text += '()';
        caretOffset = text.length - 1;
      }

      ctx.setRangeText(text, start, end);
      ta.setSelectionRange(start + caretOffset, start + caretOffset);
      ctx.onAfterInsert();
      close();
    }

    function accept() {
      if (!state.open || !state.items.length) return false;
      var c = state.ctx;
      // 文本若在弹窗打开之后被动过（例如外部程序化赋值），候选就不可信了
      if (ta.value.slice(c.start, ta.selectionStart) !== c.prefix) { close(); return false; }
      insertItem(state.items[state.index], c);
      return true;
    }

    /* 只改动选项高亮，不重建列表 */
    function paint() {
      var nodes = pop.querySelectorAll('.cmp-item');
      for (var i = 0; i < nodes.length; i++) nodes[i].className = 'cmp-item' + (i === state.index ? ' on' : '');
    }

    function move(delta) {
      if (!state.open || !state.items.length) return;
      state.index = (state.index + delta + state.items.length) % state.items.length;
      paint();
      scrollSelectedIntoView();
    }

    /* 返回 true 表示按键已被补全层消费 */
    function handleKey(e) {
      if (e.isComposing || e.keyCode === 229) return false;   // 中文输入法组字中，不插手

      if ((e.ctrlKey || e.metaKey) && (e.key === ' ' || e.code === 'Space')) {
        e.preventDefault();
        refresh(false);
        return true;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return false;

      if (state.open) {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return true; }
        if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return true; }
        if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
        if (e.key === 'Enter' || e.key === 'Tab') {
          // 采用成功才吞掉这个键；若候选已过期（accept 内部会关掉列表），交回编辑器按常规处理
          if (!accept()) return false;
          e.preventDefault();
          return true;
        }
      }

      /* Tab：唯一候选直接落笔，多个候选才摊开列表；
         行首等「前缀为空且不是点号成员」的场合让位给缩进，缩进功能不受影响。 */
      if (e.key === 'Tab' && !e.shiftKey) {
        var got = compute();
        if (!got || (!got.c.prefix && !got.c.member)) return false;
        e.preventDefault();
        if (got.items.length === 1) insertItem(got.items[0], got.c);
        else openWith(got.c, got.items, false);
        return true;
      }
      return false;
    }

    function onInput() {
      if (state.open) { refresh(true); return; }
      // 刚敲下点号 → 顺手把成员列表摊开（IDE 的常见行为）
      var value = ta.value;
      if (ta.selectionStart !== ta.selectionEnd) return;
      var c = contextAt(value, ta.selectionStart);
      if (c.member && c.prefix === '') refresh(false);
    }

    /* 鼠标操作：mousedown 阻止默认行为，避免 textarea 失焦 */
    pop.addEventListener('mousedown', function (e) {
      var li = e.target.closest ? e.target.closest('.cmp-item') : null;
      e.preventDefault();
      if (!li) return;
      state.index = Number(li.getAttribute('data-i')) || 0;
      accept();
      ta.focus();
    });
    pop.addEventListener('mousemove', function (e) {
      var li = e.target.closest ? e.target.closest('.cmp-item') : null;
      if (!li) return;
      var i = Number(li.getAttribute('data-i')) || 0;
      if (i === state.index) return;
      state.index = i;
      paint();
    });
    ta.addEventListener('blur', function () { setTimeout(close, 120); });

    return {
      handleKey: handleKey,
      onInput: onInput,
      reposition: reposition,
      close: close
    };
  }

  global.PyComplete = {
    attach: attach,
    /* 便于回归测试直接检查候选构造结果，不参与界面逻辑 */
    _internals: { contextAt: contextAt, buildCandidates: buildCandidates }
  };
})(window);
