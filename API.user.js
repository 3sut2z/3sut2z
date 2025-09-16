// ==UserScript==
// @name         TM API Logger + Encrypted Storage + Remote Upload + DownloadOnReload
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Log fetch/XHR, encrypt logs, store to IndexedDB, upload to server, download session JSON on reload. Run at document-start.
// @author       Bạn
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(async () => {
  'use strict';

  /*************************************************************************
   * CONFIG
   * - SERVER_URL: nơi POST logs (mã hóa)
   * - SECRET_PASSPHRASE: passphrase dùng để derive key AES-GCM (bạn nên đổi)
   * - UPLOAD_INTERVAL_MS: gửi định kỳ
   * - DOWNLOAD_ENCRYPTED: nếu true thì file download on reload là file mã hóa; nếu false (mặc định) thì file plaintext JSON
   *************************************************************************/
  const SERVER_URL = 'https://example.com/receive-logs'; // <= Thay bằng server của bạn
  const SECRET_PASSPHRASE = 'replace-this-with-a-strong-passphrase'; // <= Thay passphrase an toàn
  const UPLOAD_INTERVAL_MS = 30_000; // gửi mỗi 30s
  const DOWNLOAD_ENCRYPTED = false; // nếu true thì tải file mã hóa; false = tải plaintext
  const CLIENT_ID = `${location.hostname}_${Math.random().toString(36).slice(2,10)}`;

  /*************************************************************************
   * Utilities: base64, text enc/dec, subtle wrappers
   *************************************************************************/
  const te = new TextEncoder();
  const td = new TextDecoder();

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function b64ToBuf(b64) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function deriveKeyFromPassphrase(passphrase, salt, iterations = 200000) {
    const baseKey = await crypto.subtle.importKey(
      'raw', te.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptString(plain, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKeyFromPassphrase(passphrase, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plain));
    return {
      salt: bufToB64(salt.buffer),
      iv: bufToB64(iv.buffer),
      ciphertext: bufToB64(ct)
    };
  }

  async function decryptToString({ salt, iv, ciphertext }, passphrase) {
    try {
      const saltBuf = b64ToBuf(salt);
      const ivBuf = b64ToBuf(iv);
      const ctBuf = b64ToBuf(ciphertext);
      const key = await deriveKeyFromPassphrase(passphrase, saltBuf);
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ctBuf);
      return td.decode(plainBuf);
    } catch (e) {
      console.error('decrypt failed', e);
      throw e;
    }
  }

  /*************************************************************************
   * IndexedDB: store encrypted entries
   *************************************************************************/
  const DB_NAME = 'tm_api_logger_enc_db_v1';
  const STORE_NAME = 'enc_logs';
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = (ev) => resolve(ev.target.result);
      req.onerror = (ev) => reject(ev.target.error);
    });
    return dbPromise;
  }

  async function addEncryptedToDB(encObj, meta = {}) {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).add({ ts: Date.now(), meta, enc: encObj });
      return true;
    } catch (e) {
      console.error('addEncryptedToDB error', e);
      return false;
    }
  }

  async function getAllEncryptedFromDB() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = (e) => resolve(e.target.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /*************************************************************************
   * In-memory session logs (plaintext) - used for download-on-reload only.
   * We still encrypt before saving/uploading.
   *************************************************************************/
  const sessionLogs = [];

  /*************************************************************************
   * Network uploading: batch encrypted payloads.
   *************************************************************************/
  const pendingUploads = []; // queue of encrypted objects to send

  async function enqueueAndTryUpload(encObj) {
    pendingUploads.push(encObj);
  }

  async function flushUploads() {
    if (!pendingUploads.length) return;
    // build batch payload
    const batch = pendingUploads.splice(0, pendingUploads.length);
    try {
      // POST JSON: include client id and array of encrypted items
      const res = await fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: CLIENT_ID, items: batch })
      });
      if (!res.ok) {
        console.warn('Server returned non-ok for logs upload', res.status);
        // on failure, requeue
        pendingUploads.unshift(...batch);
      } else {
        // success
        console.info('tm-logger: uploaded', batch.length, 'items');
      }
    } catch (e) {
      console.warn('tm-logger upload failed, will retry later', e);
      pendingUploads.unshift(...batch);
    }
  }

  // periodic flush
  setInterval(() => {
    flushUploads();
  }, UPLOAD_INTERVAL_MS);

  /*************************************************************************
   * Helpers: saveLog (encrypt + store + queue upload)
   *************************************************************************/
  async function saveLogObject(obj) {
    try {
      // keep plaintext in session array
      sessionLogs.push(obj);

      // encrypt whole log JSON for storage/upload
      const plain = JSON.stringify(obj);
      const enc = await encryptString(plain, SECRET_PASSPHRASE);
      // store encrypted to IndexedDB
      await addEncryptedToDB(enc, { source: 'tm-script', url: location.href });

      // enqueue for upload
      const payload = { client: CLIENT_ID, ts: Date.now(), enc };
      await enqueueAndTryUpload(payload);
    } catch (e) {
      console.error('saveLogObject error', e);
    }
  }

  /*************************************************************************
   * Patch fetch and XHR similar to previous script, but call saveLogObject
   *************************************************************************/
  // --- fetch patch
  try {
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
      const reqUrl = (typeof input === 'string') ? input : (input && input.url);
      const method = (init && init.method) || (input && input.method) || 'GET';
      const reqHeaders = (init && init.headers) || {};
      const reqBody = (init && init.body) || null;
      const reqMeta = { type: 'fetch', url: reqUrl, method, headers: reqHeaders };

      let resp;
      try {
        resp = await originalFetch.apply(this, arguments);
      } catch (err) {
        // network error
        await saveLogObject({ ...reqMeta, stage: 'network-error', error: String(err) });
        throw err;
      }

      // clone and read
      try {
        const cloned = resp.clone();
        const ct = cloned.headers.get('content-type') || '';
        let text = null;
        try { text = await cloned.text(); } catch (e) { text = '<non-text or too large>';}
        const parsedBody = ct.includes('application/json') ? tryParseJSON(text) : text;
        await saveLogObject({
          ...reqMeta,
          stage: 'response',
          status: resp.status,
          statusText: resp.statusText,
          headers: Array.from(resp.headers.entries()),
          body: parsedBody
        });
      } catch (e) {
        console.error('fetch clone/read failed', e);
      }

      return resp;
    };
  } catch (e) {
    console.error('fetch patch failed', e);
  }

  // --- XHR patch
  try {
    const RealXHR = window.XMLHttpRequest;
    function XHRProxy() {
      const xhr = new RealXHR();
      let meta = { type: 'xhr', url: null, method: null, body: null, ts: null };

      const origOpen = xhr.open;
      xhr.open = function(method, url) {
        meta.method = method;
        meta.url = url;
        meta.ts = Date.now();
        return origOpen.apply(xhr, arguments);
      };

      const origSend = xhr.send;
      xhr.send = function(body) {
        meta.body = body;
        xhr.addEventListener('readystatechange', function() {
          if (xhr.readyState === 4) {
            let respText = null;
            try { respText = xhr.responseText; } catch (e) { respText = '<no responseText>'; }
            saveLogObject({
              ...meta,
              stage: 'xhr-response',
              status: xhr.status,
              responseType: xhr.responseType,
              body: guessParse(respText)
            });
          }
        });
        return origSend.apply(xhr, arguments);
      };
      return xhr;
    }
    XHRProxy.prototype = RealXHR.prototype;
    window.XMLHttpRequest = XHRProxy;
  } catch (e) {
    console.error('XHR patch failed', e);
  }

  function tryParseJSON(s) {
    try { return JSON.parse(s); } catch (e) { return s; }
  }
  function guessParse(s) { return tryParseJSON(s); }

  /*************************************************************************
   * Download on reload/unload
   * - If DOWNLOAD_ENCRYPTED === false, we build plaintext JSON from sessionLogs and download it.
   * - If DOWNLOAD_ENCRYPTED === true, we download the encrypted DB entries as-is.
   *************************************************************************/
  async function downloadSessionFile() {
    try {
      if (!DOWNLOAD_ENCRYPTED) {
        const blob = new Blob([JSON.stringify({ client: CLIENT_ID, ts: Date.now(), logs: sessionLogs }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tm_session_logs_${location.hostname}_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        return true;
      } else {
        // download encrypted DB content
        const arr = await getAllEncryptedFromDB();
        const blob = new Blob([JSON.stringify({ client: CLIENT_ID, ts: Date.now(), items: arr }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tm_session_logs_enc_${location.hostname}_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        return true;
      }
    } catch (e) {
      console.error('downloadSessionFile failed', e);
      return false;
    }
  }

  // Try to upload pending items using sendBeacon on unload (synchronous-safe)
  function sendPendingViaBeacon() {
    try {
      if (!pendingUploads.length) return false;
      // build small payload - convert to ArrayBuffer
      const payload = JSON.stringify({ client: CLIENT_ID, items: pendingUploads.splice(0, pendingUploads.length) });
      const blob = new Blob([payload], { type: 'application/json' });
      const ok = navigator.sendBeacon && navigator.sendBeacon(SERVER_URL, blob);
      if (!ok) {
        // requeue if failed
        console.warn('sendBeacon returned false');
        // put back into pendingUploads? can't easily; we will re-add by pushing parsed items
        const parsed = JSON.parse(payload);
        pendingUploads.unshift(...parsed.items);
      }
      return ok;
    } catch (e) {
      console.warn('sendBeacon error', e);
      return false;
    }
  }

  // on beforeunload: attempt beacon upload, then trigger file download
  window.addEventListener('beforeunload', (ev) => {
    try {
      // attempt sendBeacon of pending uploads
      sendPendingViaBeacon();
      // trigger download quickly (may or may not run in some browsers)
      downloadSessionFile();
      // no need to block unload
    } catch (e) {}
  });

  /*************************************************************************
   * Small floating UI: Export / Force Upload / Clear session
   *************************************************************************/
  function createUI() {
    try {
      const container = document.createElement('div');
      container.style.position = 'fixed';
      container.style.right = '8px';
      container.style.bottom = '8px';
      container.style.zIndex = 999999;
      container.style.display = 'flex';
      container.style.gap = '6px';
      container.style.flexDirection = 'column';
      container.style.opacity = '0.8';

      const btnDownload = document.createElement('button');
      btnDownload.innerText = 'Download Logs';
      btnDownload.title = 'Tải file logs của session hiện tại';
      btnDownload.onclick = () => downloadSessionFile();

      const btnUpload = document.createElement('button');
      btnUpload.innerText = 'Force Upload';
      btnUpload.title = 'Gửi ngay các logs đang đợi';
      btnUpload.onclick = () => flushUploads();

      const btnClearSession = document.createElement('button');
      btnClearSession.innerText = 'Clear Session';
      btnClearSession.title = 'Xóa bộ nhớ session (plaintext)';
      btnClearSession.onclick = () => { sessionLogs.length = 0; alert('Session logs cleared'); };

      [btnDownload, btnUpload, btnClearSession].forEach(b => {
        b.style.padding = '6px 8px';
        b.style.fontSize = '12px';
        b.style.borderRadius = '6px';
        b.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
        container.appendChild(b);
      });

      document.documentElement.appendChild(container);
    } catch (e) {
      // ignore UI errors in headless pages
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') createUI();
  else window.addEventListener('DOMContentLoaded', createUI);

  console.info('[tm-api-logger-encrypted] initialized. CLIENT_ID=', CLIENT_ID);
})();  }

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
