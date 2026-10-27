// Kleine Laufzeit für das Dashboard auf GitHub Pages.
// Stellt dieselbe `dash`-Schnittstelle bereit wie das Claude-Dashboard,
// liest die Daten aber aus den Dateien, die die GitHub Action täglich erzeugt.
(() => {
  const SOURCES = ['varianten', 'bestellungen', 'verkauf', 'lieferungen', 'sendungen'];
  const CSV = new Set(['lieferungen', 'sendungen']);
  const REMEMBER = '7heavens-dashboard-pw';

  const parseCsv = (text) => {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== '');
    return { columns: head, rows: body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) };
  };

  const state = {};
  SOURCES.forEach((id) => { state[id] = { status: 'loading', data: [], columns: [], message: '' }; });
  const calcs = new Map();
  const listeners = [];
  let calcCache = new Map();

  const resolve = (id) => {
    if (state[id]) return state[id];
    const c = calcs.get(id);
    if (!c) return { status: 'missing', data: [], columns: [], message: 'Unbekannte Quelle: ' + id };
    if (calcCache.has(id)) return calcCache.get(id);
    const ins = c.inputs.map(resolve);
    let res;
    const bad = ins.find((x) => x.status !== 'ok');
    if (bad) res = { status: bad.status, data: [], columns: [], message: bad.message };
    else {
      try {
        const data = c.fn(...ins.map((x) => x.data));
        const first = Array.isArray(data) && data[0];
        res = { status: 'ok', data, columns: first && typeof first === 'object' ? Object.keys(first) : [] };
      } catch (e) {
        console.error('Berechnung fehlgeschlagen:', id, e);
        res = { status: 'error', data: [], columns: [], message: String(e && e.message || e) };
      }
    }
    calcCache.set(id, res);
    return res;
  };

  const notify = () => {
    calcCache = new Map();
    listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  };

  window.dash = {
    data: (id) => ({ refreshing: false, meta: [], ...resolve(id) }),
    onData: (fn) => { listeners.push(fn); try { fn(); } catch (e) { console.error(e); } },
    calc: (id, def) => { calcs.set(id, def); },
    // Die Shopify-Antworten werden schon in der GitHub Action in Zeilen umgewandelt.
    loader: () => {},
    setLink: (name) => { try { history.replaceState(null, '', '#' + name); } catch (e) { /* egal */ } },
    refresh: () => {},
    params: () => ({}),
    setParams: () => {},
    resetParams: () => {},
    colors: ['#2a6fdb', '#d9822b', '#2f9e44', '#c92a2a', '#7048e8', '#0c8599', '#e64980', '#868e96'],
  };

  // Excel-Download wie im Claude-Dashboard, hier als normaler Browser-Download.
  window.claude = {
    use: async (name) => name !== 'downloads' ? null : {
      save: async ({ filename, data }) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(data);
        a.download = filename;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
    },
  };

  const b64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  let box = null;

  const decrypt = async (pw) => {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64(box.salt), iterations: box.iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(box.iv) }, key, b64(box.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  };

  const show = (d) => {
    SOURCES.forEach((id) => {
      if (CSV.has(id)) {
        const { columns, rows } = parseCsv(d[id] || '');
        state[id] = { status: 'ok', data: rows, columns };
      } else state[id] = { status: 'ok', data: d[id].rows, columns: d[id].columns };
    });
    document.getElementById('stand').textContent = 'Stand der Shopify-Daten: ' + new Date(d.updated_at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }) + ' Uhr';
    document.getElementById('login').hidden = true;
    document.getElementById('inhalt').hidden = false;
    notify();
  };

  const tryPassword = async (pw, remember) => {
    const d = await decrypt(pw);
    try { if (remember) localStorage.setItem(REMEMBER, pw); } catch (e) { /* egal */ }
    show(d);
  };

  window.addEventListener('DOMContentLoaded', async () => {
    const form = document.getElementById('login');
    const msg = document.getElementById('login-msg');
    const btn = form.querySelector('button');
    try {
      const r = await fetch('data.enc.json?v=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      box = await r.json();
    } catch (e) {
      msg.textContent = 'Die Daten konnten nicht geladen werden (' + (e.message || e) + ').';
      btn.disabled = true;
      return;
    }
    let saved = null;
    try { saved = localStorage.getItem(REMEMBER); } catch (e) { /* egal */ }
    if (saved) {
      try { await tryPassword(saved, false); return; } catch (e) {
        try { localStorage.removeItem(REMEMBER); } catch (e2) { /* egal */ }
      }
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      msg.textContent = 'Wird entschlüsselt …';
      try {
        await tryPassword(form.elements.pw.value, form.elements.merken.checked);
      } catch (err) {
        msg.textContent = 'Passwort falsch.';
        btn.disabled = false;
        form.elements.pw.select();
      }
    });
    form.elements.pw.focus();
  });

  window.dashLogout = () => {
    try { localStorage.removeItem(REMEMBER); } catch (e) { /* egal */ }
    location.reload();
  };
})();
