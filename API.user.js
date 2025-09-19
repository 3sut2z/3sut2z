// ==UserScript==
// @name         Network Logger + AntiDebug + Protect LocalStorage
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Ghi lại network + chống debug + chống xóa localStorage do trang gọi
// @author       Bạn
// @match        *://*/*
// @grant        GM_download
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =============== ANTI DEBUG ===================
    function antiDebug() {
        // Vòng lặp phát hiện console mở
        function detectDevTools() {
            const threshold = 160; // ms, nếu console làm chậm vòng lặp
            const start = performance.now();
            debugger; // gài bẫy
            if (performance.now() - start > threshold) {
                console.clear();
                alert("⚠️ Debug mode bị chặn!");
                throw new Error("Debugger detected!");
            }
        }
        setInterval(detectDevTools, 1000);

        // Ngăn người khác gọi debugger từ code
        Object.defineProperty(window, "debugger", {
            set: function () { throw new Error("Debugger blocked!"); },
            get: function () { return undefined; }
        });
    }
    antiDebug();

    // =============== PROTECT LOCALSTORAGE ===================
    (function protectLocalStorage() {
        const _setItem = localStorage.setItem;
        const _removeItem = localStorage.removeItem;
        const _clear = localStorage.clear;

        localStorage.setItem = function (k, v) {
            try { return _setItem.apply(this, arguments); }
            catch (e) { console.warn("setItem blocked:", e); }
        };

        localStorage.removeItem = function (k) {
            console.warn("removeItem bị chặn:", k);
            // Bỏ qua => giữ nguyên dữ liệu
            return;
        };

        localStorage.clear = function () {
            console.warn("clear() bị chặn!");
            // Không xóa
            return;
        };
    })();

    // =============== NETWORK LOGGER (rút gọn lại từ bản trước) ===================
    const store = { records: [] };
    const MAX_BODY_CHARS = 20000;
    const filenamePrefix = "network-log-";

    function safeTruncate(s) {
        if (!s) return null;
        if (s.length > MAX_BODY_CHARS) return s.slice(0, MAX_BODY_CHARS) + "... [TRUNCATED]";
        return s;
    }

    function nowISO() { return new Date().toISOString(); }
    function pushRecord(rec) { store.records.push(rec); }

    // --- Patch fetch ---
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        const req = new Request(args[0], args[1]);
        const info = { url: req.url, method: req.method, startedAt: nowISO() };

        let response = await origFetch.apply(this, args);
        try {
            const c = response.clone();
            info.status = response.status;
            info.response = safeTruncate(await c.text());
        } catch { }
        info.endedAt = nowISO();
        pushRecord(info);

        return response;
    };

    // --- Patch XHR ---
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
        this._info = { method: m, url: u, startedAt: nowISO() };
        return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const self = this;
        this.addEventListener("loadend", function () {
            try {
                self._info.status = self.status;
                self._info.response = safeTruncate(self.responseText);
                self._info.endedAt = nowISO();
                pushRecord(self._info);
            } catch { }
        });
        return origSend.apply(this, arguments);
    };

    // --- UI download button ---
    function downloadLogs() {
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filenamePrefix + Date.now() + ".json";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
    window.addEventListener("keydown", e => {
        if (e.ctrlKey && e.key === "d") { // Ctrl+D để tải log
            downloadLogs();
        }
    });
})();    try{
      const res = await fetch(SERVER_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ client: CLIENT_ID, items: batch }) });
      if(!res.ok){ console.warn('upload non-ok', res.status); pendingUploads.unshift(...batch); }
      else console.info('uploaded', batch.length);
    }catch(e){ console.warn('upload failed', e); pendingUploads.unshift(...batch); }
  }
  setInterval(flushUploads, UPLOAD_INTERVAL_MS);

  /********** saveLogObject: plaintext->encrypt->DB->enqueue **********/
  async function saveLogObject(obj){
    try{
      sessionLogs.push(obj);
      const plain = JSON.stringify(obj);
      const enc = await encryptString(plain, SECRET_PASSPHRASE);
      await addEncryptedToDB(enc, {url:location.href});
      enqueueUpload({ client: CLIENT_ID, ts: Date.now(), enc });
    }catch(e){ console.error('saveLogObject', e); }
  }

  /********** Patch fetch & XHR to capture req/res **********/
  try{
    const origFetch = window.fetch;
    window.fetch = async function(input, init){
      const url = typeof input === 'string' ? input : input && input.url;
      const method = (init && init.method) || (input && input.method) || 'GET';
      const headers = (init && init.headers) || {};
      const body = (init && init.body) || null;
      const meta = { type:'fetch', url, method };
      let res;
      try{ res = await origFetch.apply(this, arguments); } catch(err){ await saveLogObject({...meta, stage:'network-error', error:String(err)}); throw err; }
      try{
        const cloned = res.clone();
        const ct = cloned.headers.get('content-type') || '';
        let text = '<no-text>';
        try{ text = await cloned.text(); }catch(e){ text = '<non-text or too large>'; }
        const parsed = ct.includes('application/json') ? tryParseJSON(text) : text;
        await saveLogObject({...meta, stage:'response', status:res.status, statusText:res.statusText, headers:Array.from(res.headers.entries()), body:parsed});
      }catch(e){ console.error('fetch read error', e); }
      return res;
    };
  }catch(e){ console.error('fetch patch fail', e); }

  try{
    const RealXHR = window.XMLHttpRequest;
    function XHRProxy(){ const xhr = new RealXHR(); let meta={type:'xhr',url:null,method:null,body:null,ts:null}; const oopen=xhr.open; xhr.open=function(m,u){ meta.method=m; meta.url=u; meta.ts=Date.now(); return oopen.apply(xhr, arguments); }; const osend=xhr.send; xhr.send=function(b){ meta.body=b; xhr.addEventListener('readystatechange', function(){ if(xhr.readyState===4){ let resp='<no-resp>'; try{ resp=xhr.responseText; }catch(e){} saveLogObject({...meta, stage:'xhr-response', status:xhr.status, responseType:xhr.responseType, body:tryParseJSON(resp)}); } }); return osend.apply(xhr, arguments); }; return xhr; }
    XHRProxy.prototype = RealXHR.prototype; window.XMLHttpRequest = XHRProxy;
  }catch(e){ console.error('XHR patch fail', e); }

  function tryParseJSON(s){ try{return JSON.parse(s);}catch(e){return s;} }

  /********** Reliable local save: File System Access API **********/
  let fileHandle = null;
  let fileWritable = null;
  let autoSaveEnabled = false;

  async function requestFileHandleAndWriteInitial(){
    if(!('showSaveFilePicker' in window)) { alert('Trình duyệt không hỗ trợ File System Access API. Hãy dùng nút "Download Logs".'); return false; }
    try{
      fileHandle = await window.showSaveFilePicker({ suggestedName: `tm_logs_${location.hostname}.json`, types: [{ description:'JSON', accept: {'application/json':['.json']} }] });
      fileWritable = await fileHandle.createWritable();
      // write initial snapshot
      const data = JSON.stringify({ client: CLIENT_ID, ts: Date.now(), logs: sessionLogs }, null, 2);
      await fileWritable.write(data);
      // keep fileWritable closed for now (we'll reopen each write to ensure data persisted)
      await fileWritable.close();
      fileWritable = null;
      return true;
    }catch(e){ console.error('requestFileHandle error', e); return false; }
  }

  async function writeWholeSessionToFile(){
    if(!fileHandle) return false;
    try{
      const w = await fileHandle.createWritable(); // truncate by default
      const data = JSON.stringify({ client: CLIENT_ID, ts: Date.now(), logs: sessionLogs }, null, 2);
      await w.write(data);
      await w.close();
      return true;
    }catch(e){ console.error('writeWholeSessionToFile', e); return false; }
  }

  // periodic autosave if enabled
  let autosaveIntervalId = null;
  function startAutoSave(){
    if(autosaveIntervalId) clearInterval(autosaveIntervalId);
    autosaveIntervalId = setInterval(() => { if(fileHandle) writeWholeSessionToFile(); }, AUTO_SAVE_INTERVAL_MS);
  }
  function stopAutoSave(){ if(autosaveIntervalId) clearInterval(autosaveIntervalId); autosaveIntervalId = null; }

  /********** Manual export fallback (download blob) **********/
  async function downloadSessionPlaintext(){
    try{
      const blob = new Blob([JSON.stringify({ client: CLIENT_ID, ts: Date.now(), logs: sessionLogs }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tm_session_logs_${location.hostname}_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return true;
    }catch(e){ console.error('downloadSessionPlaintext', e); return false; }
  }
  async function downloadEncryptedDB(){
    try{
      const arr = await getAllEncryptedFromDB();
      const blob = new Blob([JSON.stringify({ client: CLIENT_ID, ts: Date.now(), items: arr }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tm_session_logs_enc_${location.hostname}_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return true;
    }catch(e){ console.error('downloadEncryptedDB', e); return false; }
  }

  /********** beforeunload: try to persist last changes **********/
  window.addEventListener('beforeunload', (ev) => {
    try{
      // try beacon upload
      if(pendingUploads.length) {
        try {
          const payload = JSON.stringify({ client: CLIENT_ID, items: pendingUploads.splice(0, pendingUploads.length) });
          const blob = new Blob([payload], { type:'application/json' });
          if(navigator.sendBeacon) navigator.sendBeacon(SERVER_URL, blob);
        } catch(e){}
      }
      // if FS API fileHandle exists, try a final synchronous-ish write by awaiting (some browsers may cancel)
      if(fileHandle){
        // attempt to write but do not block unload (best-effort)
        writeWholeSessionToFile().catch(()=>{});
      } else {
        // fallback: trigger download (may be blocked in many browsers)
        downloadSessionPlaintext().catch(()=>{});
      }
    }catch(e){}
  });

  /********** UI **********/
  function createUI(){
    try{
      const container = document.createElement('div');
      container.style.position = 'fixed'; container.style.right='8px'; container.style.bottom='8px';
      container.style.zIndex=999999; container.style.display='flex'; container.style.flexDirection='column'; container.style.gap='6px'; container.style.opacity='0.95';

      const btnDownload = document.createElement('button'); btnDownload.innerText='Download Logs'; btnDownload.title='Tải file logs plaintext'; btnDownload.onclick = () => downloadSessionPlaintext();
      const btnDownloadEnc = document.createElement('button'); btnDownloadEnc.innerText='Download Encrypted DB'; btnDownloadEnc.title='Tải file logs đã mã hóa (IndexedDB)'; btnDownloadEnc.onclick = () => downloadEncryptedDB();
      const btnEnableFS = document.createElement('button'); btnEnableFS.innerText='Enable Auto Save (FS API)'; btnEnableFS.title='Cho phép lưu tự động vào 1 file trên máy (mở popup chọn file 1 lần)'; btnEnableFS.onclick = async () => {
        const ok = await requestFileHandleAndWriteInitial();
        if(ok){ autoSaveEnabled = true; startAutoSave(); alert('Auto Save enabled. File will be updated periodically.'); btnEnableFS.innerText='Auto Save: ON'; }
        else alert('Không bật Auto Save (FS API) — trình duyệt có thể không hỗ trợ hoặc bạn hủy.');
      };
      const btnForceUpload = document.createElement('button'); btnForceUpload.innerText='Force Upload'; btnForceUpload.onclick = () => flushUploads();
      [btnDownload, btnDownloadEnc, btnEnableFS, btnForceUpload].forEach(b=>{ b.style.padding='6px 8px'; b.style.fontSize='12px'; b.style.borderRadius='6px'; b.style.boxShadow='0 2px 6px rgba(0,0,0,0.12)'; container.appendChild(b); });

      document.documentElement.appendChild(container);
    }catch(e){}
  }
  if(document.readyState==='complete' || document.readyState==='interactive') createUI(); else window.addEventListener('DOMContentLoaded', createUI);

  /********** small debug console msg **********/
  console.info('[tm-api-logger] initialized. CLIENT_ID=', CLIENT_ID, ' - Use "Enable Auto Save (FS API)" to reliably save to disk, or click "Download Logs".');

})();  }

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



