/* ==========================================================================
   stdin-sw.js — 输入通道（Service Worker）
   唯一职责：拦住本站 __stdin__ 的请求并把它挂起，直到页面送来一行文本，
   才把响应放回去。除此之外不碰任何请求，也不做任何缓存。

   为什么需要它：静态托管（GitHub Pages 等）无法下发 COOP/COEP 响应头，
   于是 SharedArrayBuffer 不可用（实测：`SharedArrayBuffer is not defined`，
   跨线程传共享内存直接被拒）。Worker 里因此没有「就地等待」的原生手段。
   同步 XHR + 本拦截器是唯一既不需要改响应头、也不需要服务端的阻断方案：
   同步 XHR 冻住的是 Worker 线程，主线程照常响应界面。

   请求 / 响应约定：
     GET  __stdin__?id=<编号>
       200 + 正文  → 用户在结果区敲的一行（UTF-8）
       204         → 用户点了「结束输入」，Python 侧按 EOF 处理
   编号带每次运行随机前缀，避免与上一次运行的请求混淆。
   ========================================================================== */
'use strict';

var EOF_STATUS = 204;
var STDIN_TAIL = '/__stdin__';

/* id -> 放行函数；以及「用户抢在拦截之前就提交了」的暂存表 */
var pending = new Map();
var early = new Map();

function take(map, id) {
  var fn = map.get(id);
  if (!fn) return null;
  map.delete(id);
  return fn;
}

function respond(id, response) {
  var fn = take(pending, id);
  if (fn) fn(response);
  else early.set(id, response);     // 拦截尚未到达，先替用户存着
}

function lineResponse(text) {
  return new Response(String(text), {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

function eofResponse() {
  // 204 不允许带正文，用 null body
  return new Response(null, { status: EOF_STATUS });
}

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.type === 'line') respond(d.id, lineResponse(d.line));
  else if (d.type === 'eof') respond(d.id, eofResponse());
  else if (d.type === 'cancel') {
    // 「停止」后清场：把还挂着的请求一律按 EOF 放行，释放待处理表
    pending.forEach(function (fn, id) { fn(eofResponse()); });
    pending.clear();
    early.clear();
  }
  // d.type === 'ping'：保活。收到消息这个事实本身就会延长 SW 的生命周期。
});

self.addEventListener('fetch', function (e) {
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (!url.pathname.endsWith(STDIN_TAIL)) return;

  var id = url.searchParams.get('id') || '';
  if (!id) return;

  // 页面侧也监听这条通知：万一 Worker 的 postMessage 没送达，界面仍能开出输入行
  self.clients.matchAll({ type: 'window' }).then(function (list) {
    list.forEach(function (c) { c.postMessage({ type: 'stdin-request', id: id }); });
  });

  var immediate = take(early, id);
  if (immediate) { e.respondWith(immediate); return; }

  e.respondWith(new Promise(function (resolve) {
    pending.set(id, resolve);
  }));
});
