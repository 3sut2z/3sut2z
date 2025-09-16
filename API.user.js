// ==UserScript==
// @name         Global API Logger + AutoExport (local-only, debug)
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  Wrap fetch/XHR, save logs to IndexedDB and auto-download JSON on unload. LOCAL ONLY. Do not use to exfiltrate data.
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function(){
  'use strict';

  // Safety: default disabled. Enable manually in console:
  // window.__API_LOGGER_ENABLED = true
  if (!window.__API_LOGGER_ENABLED) {
    console.info('Global API Logger disabled. Enable with: window.__API_LOGGER_ENABLED = true and reload.');
    return;
  }

  // Exclude some obvious sensitive origins
  const excludedOrigins = [
    'chrome://', 'about:', 'file://',
    'https://accounts.google.com',
    'https://www.paypal.com',
    'https://checkout.stripe.com',
    'https://secure.'
  ];
  const origin = location.origin || location.href;
  for (const bad of excludedOrigins) {
    if (origin.startsWith(bad)) {
      console.warn('API Logger: origin excluded for safety:', origin);
      return;
    }
  }

  // ---- helpers ----
  function truncate(v, n = 2000) {
    if (v == null) return v;
    if (typeof v === 'string') return v.length > n ? v.slice(0,n) + '...[truncated]' : v;
    try {
      const s = JSON.stringify(v);
      return s.length > n ? s.slice(0,n) + '...[truncated]' : s;
    } catch (e) { return String(v); }
  }

  function openDb(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('global-api-logger-db', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('logs')) {
          db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function storeLog(item){
    try {
      const db = await openDb();
      const tx = db.transaction('logs', 'readwrite');
      const store = tx.objectStore('logs');
      item.ts = new Date().toISOString();
      // keep sizes reasonable
      if (item.res && item.res.body && item.res.body.length>2000) item.res.body = item.res.body.slice(0,2000)+'...[truncated]';
      store.add(item);
      tx.oncomplete = () => db.close();
    } catch(e){ console.warn('storeLog failed', e); }
  }

  async function readAllLogs(){
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('logs','readonly');
      const store = tx.objectStore('logs');
      const req = store.getAll();
      req.onsuccess = e => { db.close(); resolve(e.target.result); };
      req.onerror = e => { db.close(); reject(e.target.error); };
    });
  }

  function downloadJSON(obj, filename = `api-logs-${(new Date()).toISOString().replace(/[:.]/g,'-')}.json`) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a);
    a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  // ---- Fetch wrapper ----
  const _fetch = window.fetch;
  window.fetch = async function(input, init){
    const start = Date.now();
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    const reqBody = init && init.body;
    const reqHeaders = init && init.headers;
    console.groupCollapsed(`fetch → ${method} ${url}`);
    console.log('Request:', { method, url, headers: reqHeaders, body: truncate(reqBody) });

    try {
      const resp = await _fetch.apply(this, arguments);
      const clone = resp.clone();
      let text = '[unreadable]';
      try { text = await clone.text(); } catch(e){}
      const elapsed = Date.now() - start;
      console.log('Response status:', resp.status, 'elapsedMs:', elapsed);
      console.log('Response body (truncated):', truncate(text));
      console.groupEnd();

      try { await storeLog({type:'fetch', req:{method,url,body:truncate(reqBody)}, res:{status:resp.status, body:truncate(text)}, elapsed}); } catch(e){}
      return resp;
    } catch(err) {
      console.error('fetch error', err);
      console.groupEnd();
      throw err;
    }
  };

  // ---- XHR wrapper ----
  const OriginalXHR = window.XMLHttpRequest;
  function WrappedXHR(){
    const xhr = new OriginalXHR();
    let _url = null, _method = null, _reqBody = null;

    const open = xhr.open;
    xhr.open = function(method, url){
      _method = method; _url = url;
      return open.apply(xhr, arguments);
    };

    const send = xhr.send;
    xhr.send = function(body){
      _reqBody = body;
      xhr.addEventListener('loadend', function(){
        try {
          const text = xhr.responseText;
          console.groupCollapsed(`XHR → ${_method} ${_url}`);
          console.log('Request body (truncated):', truncate(_reqBody));
          console.log('Status:', xhr.status);
          console.log('Response (truncated):', truncate(text));
          console.groupEnd();
          try { storeLog({type:'xhr', req:{method:_method,url:_url,body:truncate(_reqBody)}, res:{status:xhr.status,body:truncate(text)} }); } catch(e){}
        } catch(e){}
      });
      return send.apply(xhr, arguments);
    };

    return xhr;
  }
  WrappedXHR.prototype = OriginalXHR.prototype;
  window.XMLHttpRequest = WrappedXHR;

  // ---- Auto export on page unload/reload ----
  // If enabled, on beforeunload we read logs and trigger a download JSON.
  // Keep it short and non-blocking.
  let autoExportOnUnload = true; // change false if you don't want auto download
  window.addEventListener('beforeunload', function(e){
    if (!autoExportOnUnload) return;
    // Try to read logs and download (best-effort)
    readAllLogs().then(logs => {
      if (!logs || logs.length === 0) return;
      downloadJSON({metadata:{origin: location.origin, ts: new Date().toISOString(), count: logs.length}, logs}, `api-logs-${location.hostname}.json`);
    }).catch(err => {/*ignore*/});
    // no prompt to user; non-blocking
  });

  // ---- Console helpers for manual control ----
  window.__apiLogger = {
    downloadNow: async function(){
      const logs = await readAllLogs();
      downloadJSON({metadata:{origin: location.origin, ts: new Date().toISOString(), count: logs.length}, logs}, `api-logs-${location.hostname}.json`);
    },
    clearLocal: async function(){
      const db = await openDb();
      const tx = db.transaction('logs','readwrite');
      tx.objectStore('logs').clear();
      tx.oncomplete = () => db.close();
    },
    count: async function(){ const logs = await readAllLogs(); return logs.length; }
  };

  console.info('Global API Logger ACTIVE on this page. Use window.__apiLogger.downloadNow() to export logs, or logs auto-download on reload (if enabled). Logs stored in IndexedDB: "global-api-logger-db".');

})();