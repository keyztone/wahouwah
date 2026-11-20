'use strict';
/* WahouWah web controller — Web Bluetooth port of the Keyztone Xamarin app.
   Protocol taken from Firmware/ble_wah.h and Keyztone.MyWahFactory (WahPedalCommunicationService, *DataHandshake). */

const APP_VERSION = 'web 1.0.0';
const MIN_FW = '1.1.1';

// ───────────────────────── Protocol ─────────────────────────
const uuid = s => `214d${s}-df5f-73a4-2345-4c190000e9a9`;
const SVC = uuid('1400');
const CH = { pos: uuid('1401'), pedal: uuid('1406'), calib: uuid('1407'), stroke: uuid('1408'), first: uuid('1416'), mac: uuid('1417') };
const presetCh = i => uuid('141' + i);
const MAX_PRESETS = 6;

const STATUS = { EDIT: 0, SAVE: 1 };
const MODE = { WAH: 0, LEVEL: 1 };
const SRC = { EXP: 2, WAH: 3 };
const BYPASS = { INTERNAL: 0, EXTERNAL: 1, AUTO: 2 };
const CURVE = { RAW: 0, LOG: 1, EXP: 2 };
const CAL = { NONE: 0, GO_DOWN: 1, GO_UP: 2, DONE: 3, VERIFY: 4 };

const LABELS = {
  mode: [[MODE.WAH, 'Wahwah'], [MODE.LEVEL, 'Level']],
  filter: [[0, 'Normal Wah'], [1, 'Soft Wah'], [2, 'Hard Wah'], [3, 'NoWah']],
  source: [[SRC.EXP, 'Exp Pedal'], [SRC.WAH, 'Wah Pedal']],
  bypass: [[BYPASS.AUTO, 'Auto Heel'], [BYPASS.EXTERNAL, 'External Wah'], [BYPASS.INTERNAL, 'WahouWah']],
  curve: [[CURVE.RAW, 'Natural'], [CURVE.LOG, 'Heel Boost'], [CURVE.EXP, 'Toe Boost']],
};
const label = (k, v) => (LABELS[k].find(x => x[0] === v) || [0, '?'])[1];
const COLORS = ['red', 'green', 'blue', 'yellow', 'aqua', 'purple'];
const kSvg = i => `assets/K-${COLORS[i] || 'red'}.svg`;

const PRESET_LEN = 45;
const cleanName = s => String(s || '').replace(/[^\x20-\x7e]/g, '').slice(0, 20);

function presetDecode(dv) {
  if (dv.byteLength < PRESET_LEN) throw new Error(`Preset data too short (${dv.byteLength} bytes)`);
  const b = i => dv.getUint8(i);
  let name = '';
  for (let i = 25; i < 45; i++) { const c = b(i); if (!c) break; name += String.fromCharCode(c); }
  return {
    FC1_1: b(0), FC2_1: b(1), Q1_1: b(2), Q2_1: b(3), LV1_1: b(4), LV2_1: b(5),
    STATUS: b(6), MODE: b(7), AUTO: b(8) !== 0,
    TIME_AUTO_WAH: dv.getUint32(9, true), TIME_AUTO_LEVEL: dv.getUint32(13, true),
    COLOR: b(17), MIX_DRY1: b(18), MIX_DRY2: b(19), FILTER_TYPE: b(20), SOURCE: b(21),
    BYPASS_SOURCE: b(22), GAIN: b(23), CURVE_RESPONSE: b(24), NAME: name,
  };
}
function presetEncode(d) {
  const out = new Uint8Array(PRESET_LEN), dv = new DataView(out.buffer);
  [d.FC1_1, d.FC2_1, d.Q1_1, d.Q2_1, d.LV1_1, d.LV2_1, d.STATUS, d.MODE, d.AUTO ? 1 : 0].forEach((v, i) => out[i] = v);
  dv.setUint32(9, d.TIME_AUTO_WAH >>> 0, true); dv.setUint32(13, d.TIME_AUTO_LEVEL >>> 0, true);
  [d.COLOR, d.MIX_DRY1, d.MIX_DRY2, d.FILTER_TYPE, d.SOURCE, d.BYPASS_SOURCE, d.GAIN, d.CURVE_RESPONSE].forEach((v, i) => out[17 + i] = v);
  const n = cleanName(d.NAME);
  for (let i = 0; i < n.length; i++) out[25 + i] = n.charCodeAt(i);
  return out;
}
function calibDecode(dv) {
  return { SOURCE: dv.getUint8(0), EXP_STATUS: dv.getUint8(1), WAH_STATUS: dv.getUint8(2), DATA: dv.getUint16(3, true), WAH_GAIN: dv.getUint8(5),
    EXP_HEEL: dv.getUint16(6, true), EXP_TOE: dv.getUint16(8, true), WAH_HEEL: dv.getUint16(10, true), WAH_TOE: dv.getUint16(12, true) };
}
function calibEncode(c) {
  const out = new Uint8Array(14), dv = new DataView(out.buffer);
  out[0] = c.SOURCE; out[1] = c.EXP_STATUS; out[2] = c.WAH_STATUS; dv.setUint16(3, c.DATA, true); out[5] = c.WAH_GAIN;
  dv.setUint16(6, c.EXP_HEEL || 0, true); dv.setUint16(8, c.EXP_TOE || 0, true); dv.setUint16(10, c.WAH_HEEL || 0, true); dv.setUint16(12, c.WAH_TOE || 0, true);
  return out;
}
function strokeDecode(dv) {
  return { STATUS: dv.getUint8(0), SOURCE: dv.getUint8(1), EXP_CURVE: dv.getUint8(2), WAH_CURVE: dv.getUint8(3),
    EXP_HEEL: dv.getUint16(4, true), EXP_TOE: dv.getUint16(6, true), WAH_HEEL: dv.getUint16(8, true), WAH_TOE: dv.getUint16(10, true) };
}

const DATA_KEYS = ['FC1_1', 'FC2_1', 'Q1_1', 'Q2_1', 'LV1_1', 'LV2_1', 'STATUS', 'MODE', 'AUTO', 'TIME_AUTO_WAH', 'TIME_AUTO_LEVEL', 'COLOR',
  'MIX_DRY1', 'MIX_DRY2', 'FILTER_TYPE', 'SOURCE', 'BYPASS_SOURCE', 'GAIN', 'CURVE_RESPONSE'];
const sameName = (a, b) => (a.NAME || '').toLowerCase() === (b.NAME || '').toLowerCase();
const eqBy = (a, b, skip) => !!a && !!b && DATA_KEYS.every(k => skip.includes(k) || a[k] === b[k]);
const eqAll = (a, b) => eqBy(a, b, []) && a.NAME === b.NAME;
const eqExceptStatus = (a, b) => eqBy(a, b, ['STATUS']) && sameName(a, b);
const eqExceptSource = (a, b) => eqBy(a, b, ['STATUS', 'COLOR', 'SOURCE']) && sameName(a, b);
const clone = o => JSON.parse(JSON.stringify(o));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────── Transport: Web Bluetooth ─────────────────────────
const ble = {
  dev: null, ch: {}, queue: Promise.resolve(), opening: false, closing: false, patient: false, onNotify: null, onDrop: null,

  async request() {
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [SVC] }, { namePrefix: 'Wahou' }],
      optionalServices: [SVC, 'device_information'],
    });
  },
  async open() {
    this.opening = true;
    try {
      const g = await this.dev.gatt.connect();
      const svc = await g.getPrimaryService(SVC);
      this.ch = {};
      for (const c of await svc.getCharacteristics()) {
        this.ch[c.uuid] = c;
        c.addEventListener('characteristicvaluechanged', e => this.onNotify && this.onNotify(c.uuid, e.target.value));
      }
    } finally { this.opening = false; }
  },
  async connect(dev) {
    this.dev = dev; this.closing = false; this.queue = Promise.resolve();
    dev.addEventListener('gattserverdisconnected', () => { if (!this.opening && !this.patient && !this.closing && this.onDrop) this.onDrop(); });
    await this.open();
  },
  disconnect() { this.closing = true; try { this.dev && this.dev.gatt.disconnect(); } catch (e) { /* already gone */ } },

  // All GATT operations are serialised. While `patient` (first exchanges after connecting) failures are retried:
  // the characteristics need an encrypted link, and Android may still be bonding or may drop the link once.
  op(fn) {
    const run = async () => {
      const tries = this.patient ? 7 : 2;
      let err;
      for (let i = 0; i < tries; i++) {
        if (this.closing) throw new Error('Disconnected');
        try {
          if (!this.dev.gatt.connected) await this.open();
          return await Promise.race([fn(), sleep(8000).then(() => { throw new Error('No answer from pedal (timeout)'); })]);
        } catch (e) { err = e; await sleep(i === 0 ? 500 : 1800); }
      }
      throw err;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  },
  char(u) { const c = this.ch[u]; if (!c) throw new Error('Characteristic not found: ' + u.slice(4, 8)); return c; },
  read(u) { return this.op(() => this.char(u).readValue()); },
  write(u, bytes) { return this.op(() => this.char(u).writeValueWithResponse(bytes)); },
  notify(u, on) { return this.op(() => on ? this.char(u).startNotifications() : this.char(u).stopNotifications()); },
  async firmware() {
    try {
      const svc = await this.dev.gatt.getPrimaryService('device_information');
      const v = await (await svc.getCharacteristic('firmware_revision_string')).readValue();
      return new TextDecoder().decode(v).replace(/\0/g, '').trim();
    } catch (e) { return null; }
  },
};

// ───────────────────────── Transport: demo (no pedal) ─────────────────────────
const mock = {
  mem: {}, subs: new Set(), timer: null, t: 0, onNotify: null, onDrop: null, patient: false,
  async connect() {
    const f = lib.factory;
    for (let i = 0; i < MAX_PRESETS; i++) this.mem[presetCh(i)] = presetEncode({ ...f[i % f.length].data, COLOR: i });
    this.mem[CH.pos] = new Uint8Array([0]);
    this.mem[CH.calib] = calibEncode({ SOURCE: SRC.WAH, EXP_STATUS: CAL.DONE, WAH_STATUS: CAL.DONE, DATA: 0, WAH_GAIN: 63, EXP_HEEL: 60, EXP_TOE: 950, WAH_HEEL: 80, WAH_TOE: 900 });
    this.mem[CH.stroke] = new Uint8Array(12);
    this.mem[CH.first] = new Uint8Array([0]);
    this.timer = setInterval(() => {
      if (!this.subs.has(CH.pedal)) return;
      this.t += 0.08;
      const v = Math.round(512 + 440 * Math.sin(this.t));
      this.emit(CH.pedal, new Uint8Array([v & 255, v >> 8]));
    }, 100);
  },
  disconnect() { clearInterval(this.timer); this.subs.clear(); },
  emit(u, bytes) { if (this.onNotify) this.onNotify(u, new DataView(bytes.buffer.slice(0))); },
  async read(u) { await sleep(15); const b = this.mem[u] || new Uint8Array(1); return new DataView(b.buffer.slice(0)); },
  async write(u, bytes) {
    await sleep(15); this.mem[u] = new Uint8Array(bytes);
    if (u === CH.calib && this.subs.has(u)) {
      const c = calibDecode(new DataView(this.mem[u].buffer));
      Object.assign(c, { EXP_HEEL: 60, EXP_TOE: 950, WAH_HEEL: 80, WAH_TOE: 900 });
      this.mem[u] = calibEncode(c); this.emit(u, this.mem[u]);
    }
  },
  async notify(u, on) { on ? this.subs.add(u) : this.subs.delete(u); },
  async firmware() { return '1.1.1'; },
};
let io = ble;

// ───────────────────────── Store & library ─────────────────────────
const S = {
  connected: false, presets: [], sel: 0, pedal: 0, mode: 'none', fw: null, calibratedOnce: true,
  calib: { EXP_STATUS: 0, WAH_STATUS: 0, WAH_GAIN: 0, EXP_HEEL: 0, EXP_TOE: 0, WAH_HEEL: 0, WAH_TOE: 0 },
  stroke: null,
  defaultPedal: +(localStorage.getItem('wah.defaultPedal') ?? 1),   // 0 = expression, 1 = wah (same default as the app)
};
const defaultSource = () => S.defaultPedal === 0 ? SRC.EXP : SRC.WAH;

const lib = {
  factory: [], user: [],
  async load() {
    const raw = await (await fetch('factoryPresets.json')).json();
    this.factory = raw.map(p => ({ category: p.category, factory: true, data: { ...p.data, SOURCE: defaultSource() } }));
    try { this.user = JSON.parse(localStorage.getItem('wah.userPresets') || '[]'); } catch (e) { this.user = []; }
  },
  saveUser() { localStorage.setItem('wah.userPresets', JSON.stringify(this.user)); },
  isFactory(d) { return this.factory.some(f => eqExceptSource(f.data, d)); },
  findUser(d) { return this.user.findIndex(u => sameName(u, d)); },
  categories() { return [...new Set(this.factory.map(f => f.category))].sort().reverse().concat('User'); },
  retarget() { this.factory.forEach(f => f.data.SOURCE = defaultSource()); },
};

// ───────────────────────── Pedal manager ─────────────────────────
const NOTIF = { play: [CH.pos, CH.pedal], edit: [], calib: [CH.calib, CH.pedal], none: [] };
async function enterMode(m) {
  if (S.mode === m) return;
  for (const u of NOTIF[S.mode]) await io.notify(u, false).catch(() => {});
  S.mode = m;
  for (const u of NOTIF[m]) await io.notify(u, true);
}
function onNotify(u, dv) {
  if (u === CH.pedal) { S.pedal = dv.getUint16(0, true); ui.pedalMoved(); }
  else if (u === CH.pos) { setActive(dv.getUint8(0)); }
  else if (u === CH.calib) { Object.assign(S.calib, calibDecode(dv)); ui.pedalMoved(); }
  else if (u === CH.stroke) { S.stroke = strokeDecode(dv); }
}
function setActive(p) { if (p === S.sel || p >= MAX_PRESETS) return; S.sel = p; if (ui.page === 'home') ui.renderHome(); }

async function syncFromPedal() {
  const presets = [];
  for (let i = 0; i < MAX_PRESETS; i++) {
    let data;
    try { data = presetDecode(await io.read(presetCh(i))); }
    catch (e) { if (i === 0) throw e; data = { ...lib.factory[0].data, NAME: '?' }; }
    presets.push({ pos: i, data });
  }
  S.presets = presets;
  S.sel = Math.min((await io.read(CH.pos)).getUint8(0), MAX_PRESETS - 1);
  try { Object.assign(S.calib, calibDecode(await io.read(CH.calib))); } catch (e) { /* keep defaults */ }
  try { S.stroke = strokeDecode(await io.read(CH.stroke)); } catch (e) { /* unused by the UI */ }
}
const storeTemp = (data, pos) => io.write(presetCh(pos), presetEncode({ ...data, STATUS: STATUS.EDIT }));
const saveFlash = (data, pos) => io.write(presetCh(pos), presetEncode({ ...data, STATUS: STATUS.SAVE }));
async function selectPreset(pos) { await io.write(CH.pos, new Uint8Array([pos])); setActive(pos); }

async function setDefaultPedal(seg) {
  S.defaultPedal = seg; localStorage.setItem('wah.defaultPedal', seg);
  lib.retarget();
  for (const p of S.presets) {
    if (lib.isFactory(p.data) && p.data.SOURCE !== defaultSource()) { p.data.SOURCE = defaultSource(); await saveFlash(p.data, p.pos); }
  }
}
function sendCalib(source, status, gain) {
  const c = { SOURCE: source, EXP_STATUS: S.calib.EXP_STATUS, WAH_STATUS: S.calib.WAH_STATUS, DATA: S.pedal, WAH_GAIN: gain ?? S.calib.WAH_GAIN };
  if (status != null) { if (source === SRC.EXP) c.EXP_STATUS = status; else c.WAH_STATUS = status; }
  S.calib.EXP_STATUS = c.EXP_STATUS; S.calib.WAH_STATUS = c.WAH_STATUS; S.calib.WAH_GAIN = c.WAH_GAIN;
  return io.write(CH.calib, calibEncode(c));
}
const fwOk = v => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || ''), n = MIN_FW.split('.').map(Number);
  if (!m) return false;
  const c = m.slice(1).map(Number);
  return c[0] > n[0] || (c[0] === n[0] && (c[1] > n[1] || (c[1] === n[1] && c[2] >= n[2])));
};

// ───────────────────────── Small UI helpers ─────────────────────────
const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const loader = (on, text = '') => { $('#loader').hidden = !on; $('#loader p').textContent = text; };
let toastT;
const toast = t => { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => e.hidden = true, 3000); };

function modal(build) {
  return new Promise(res => {
    const m = $('#modal'), f = m.querySelector('.frame');
    f.innerHTML = '';
    const close = v => { m.hidden = true; m.onclick = null; res(v); };
    build(f, close);
    m.onclick = e => { if (e.target === m) close(undefined); };
    m.hidden = false;
  });
}
const dialog = (title, msg, buttons = ['OK']) => modal((f, close) => {
  f.append(el('h2', '', esc(title)), el('p', '', esc(msg)));
  const a = el('div', 'acts');
  buttons.forEach((b, i) => { const x = el('button', 'btn', esc(b)); x.onclick = () => close(i); a.append(x); });
  f.append(a);
});
const alertBox = (msg, title = 'WahouWah') => dialog(title, msg);
const confirmBox = async (msg, title) => (await dialog(title, msg, ['No', 'Yes'])) === 1;
const pick = (title, items) => modal((f, close) => {
  f.append(el('h2', '', esc(title)));
  for (const it of items) { const b = el('button', 'opt', esc(it.label)); b.disabled = !!it.disabled; b.onclick = () => close(it.value); f.append(b); }
});

// Knob value → displayed text (formulas from KnobControl.xaml.cs)
const FREQ = [20,40,55,65,75,85,100,110,120,130,140,150,160,170,175,185,195,205,210,220,230,235,245,250,260,265,275,280,290,295,305,310,320,325,330,340,345,350,360,365,370,375,385,390,395,400,405,410,415,425,430,435,440,445,450,455,460,465,470,475,480,485,490,495,500,505,510,515,520,525,530,535,540,545,550,555,560,565,570,575,580,585,590,595,595,600,605,610,615,620,625,630,635,640,645,655,660,665,670,675,680,685,690,695,700,705,710,715,725,730,735,740,745,750,760,765,770,775,780,790,795,800,805,815,820,825,835,840,845,855,860,865,875,880,890,895,905,910,915,925,930,940,945,955,960,970,980,985,995,1000,1010,1020,1025,1035,1045,1050,1060,1070,1075,1085,1095,1105,1115,1120,1130,1140,1150,1160,1170,1180,1190,1200,1210,1220,1230,1240,1250,1260,1270,1285,1295,1305,1315,1330,1340,1350,1365,1375,1390,1400,1415,1430,1440,1455,1470,1485,1500,1515,1530,1545,1560,1575,1590,1610,1625,1640,1660,1675,1695,1715,1735,1755,1775,1795,1815,1835,1860,1880,1905,1930,1950,1975,2000,2030,2055,2085,2110,2140,2170,2200,2230,2265,2295,2330,2365,2400,2435,2475,2510,2550,2590,2630,2675,2720,2765,2810,2855,2905,2955,3005,3060,3115,3170,3225,3285,3345];
const levelText = (v, min, max) => v === max ? 'MUTE' : v === min ? 'FULL' : `-${v} dB`;
const KNOB_TEXT = {
  Frequency: x => `${FREQ[x] ?? 0} Hz`,
  QFactor: x => (Math.round((-0.08351 * x + 22.17153) * 10) / 10).toString(),
  Gain: x => `${Math.round(7.64e-6 * x ** 3 - 2.18e-3 * x ** 2 + 0.278 * x + 0.189)} dB`,
  Level: (x, a, b) => levelText(x, a, b),
  Adjust: x => `${x} dB`,
};

// Rotary knob: 270° sweep, minimum at lower-left, maximum at lower-right (as in the app).
function knob({ desc, type, min = 0, max, get, set }) {
  const root = el('div', 'knob', `<div class="val"></div><div class="dial"><div class="ptr"></div></div><div class="desc">${esc(desc)}</div><div class="fine"><button>−</button><button>+</button></div>`);
  const dial = root.querySelector('.dial'), ptr = root.querySelector('.ptr'), val = root.querySelector('.val');
  const paint = () => { const v = get(); ptr.style.transform = `rotate(${-135 + 270 * (v - min) / (max - min)}deg)`; val.textContent = KNOB_TEXT[type](v, min, max); };
  const put = v => { v = Math.max(min, Math.min(max, Math.round(v))); if (v !== get()) { set(v); paint(); } };
  const move = e => {
    const r = dial.getBoundingClientRect();
    const a = Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI;   // clockwise from 12 o'clock
    if (Math.abs(a) > 150) return;                                   // dead zone at the bottom
    const pct = (Math.max(-135, Math.min(135, a)) + 135) / 270;
    if (Math.abs(pct - (get() - min) / (max - min)) > 0.6) return;   // no jump across the dead zone
    put(min + pct * (max - min));
  };
  dial.addEventListener('pointerdown', e => { dial.setPointerCapture(e.pointerId); move(e); });
  dial.addEventListener('pointermove', e => { if (dial.hasPointerCapture(e.pointerId)) move(e); });
  const [minus, plus] = root.querySelectorAll('.fine button');
  minus.onclick = () => put(get() - 1); plus.onclick = () => put(get() + 1);
  paint();
  return root;
}
function slider({ title, max, step = 1, get, set, text, disabled }) {
  const root = el('div', 'slider', `<div class="t"><span>${esc(title || '')}</span><b></b></div><input type="range" min="0" max="${max}" step="${step}">`);
  const inp = root.querySelector('input'), out = root.querySelector('b');
  inp.value = get(); inp.disabled = !!disabled; out.textContent = text(get());
  inp.oninput = () => { const v = +inp.value; set(v); out.textContent = text(v); };
  return root;
}
function meter({ wah, zone, toeOn = true, heelOn = true }) {
  const root = el('div', 'meter', `<span class="lab ${toeOn ? '' : 'dim'}">TOE</span><div class="track ${wah ? 'wah' : ''}">${zone ? `<div class="zone" style="bottom:${zone[0]}%;height:${zone[1] - zone[0]}%"></div>` : ''}<div class="mark"></div></div><span class="lab ${heelOn ? '' : 'dim'}">HEEL</span>`);
  const mark = root.querySelector('.mark');
  root.set = pct => { mark.style.bottom = Math.max(0, Math.min(100, pct)) + '%'; };
  return root;
}

// ───────────────────────── Pages ─────────────────────────
const ui = {
  page: 'discover', E: null, W: null, libFilter: 0, onPedal: null,

  async show(page) {
    if (this.page === 'edit' && page !== 'edit' && !(await this.leaveEdit())) return;
    this.page = page; this.onPedal = null;
    for (const p of ['discover', 'home', 'edit', 'lib', 'calib', 'wiz']) $('#p-' + p).hidden = p !== page;
    $('#tabs').hidden = page === 'discover' || page === 'wiz';
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === page));
    try {
      if (page === 'home') { await enterMode('play'); this.renderHome(); }
      if (page === 'edit') { await enterMode('edit'); this.renderEdit(); }
      if (page === 'lib') { await enterMode('play'); this.renderLib(); }
      if (page === 'calib') { await enterMode('play'); this.renderCalib(); }
    } catch (e) { fail(e); }
  },
  pedalMoved() { if (this.onPedal) this.onPedal(); },

  // Home: six slots
  renderHome() {
    const box = $('#slots'); box.innerHTML = '';
    S.presets.forEach((p, i) => {
      const wah = p.data.SOURCE === SRC.WAH;
      const b = el('button', 'slot', `<div class="circle ${p.pos === S.sel ? 'sel' : ''}"><img src="${kSvg(i)}" alt=""><span class="badge ${wah ? 'wah' : ''}">${wah ? 'WAH' : 'EXP'}</span></div><span>${esc(p.data.NAME)}</span>`);
      b.onclick = async () => {
        try { if (p.pos === S.sel) this.openEdit('pedal', p.data, p.pos); else { await selectPreset(p.pos); this.renderHome(); } }
        catch (e) { fail(e); }
      };
      box.append(b);
    });
  },

  // Live edit
  openEdit(from, data, pos) {
    this.E = { from, data: clone(data), untouched: clone(data), pos: from === 'pedal' ? pos : S.sel, view: 0, timer: null, last: 0 };
    this.show('edit');
  },
  touch() {   // live preview on the pedal, at most every 250 ms (as the app does)
    const E = this.E; if (!E) return;
    const send = () => { E.timer = null; E.last = Date.now(); storeTemp(E.data, E.pos).catch(fail); };
    if (E.timer) return;
    E.timer = setTimeout(send, Math.max(0, 250 - (Date.now() - E.last)));
  },
  renderEdit() {
    if (!this.E) {
      const p = S.presets[S.sel];
      if (!p) return this.show('home');
      this.E = { from: 'pedal', data: clone(p.data), untouched: clone(p.data), pos: p.pos, view: 0, timer: null, last: 0 };
    }
    const E = this.E, d = E.data;
    const name = $('#e-name');
    name.value = d.NAME; name.oninput = () => { name.value = cleanName(name.value); d.NAME = name.value; this.touch(); };
    $('#e-mode span').textContent = label('mode', d.MODE);
    const views = ['heel', 'toe', 'overall'];
    $('#e-dots').innerHTML = views.map((_, i) => `<i class="${i === E.view ? 'on' : ''}"></i>`).join('');
    const v = $('#e-view'); v.innerHTML = '';
    const bind = k => ({ get: () => d[k], set: x => { d[k] = x; this.touch(); } });
    const dry = k => slider({ title: 'Dry Level (BLEND)', max: 63, ...bind(k), text: x => levelText(x, 0, 63) });
    const wahMode = d.MODE === MODE.WAH, view = views[E.view];

    if (view !== 'overall') {
      const n = view === 'heel' ? 1 : 2;
      v.append(el('div', 'head', `<img src="assets/pedal_${view}.png" alt="${view}">`));
      const k = el('div', 'knobs');
      if (wahMode) {
        k.append(knob({ desc: 'Frequency', type: 'Frequency', max: 255, ...bind(`FC${n}_1`) }), knob({ desc: 'Q Factor', type: 'QFactor', max: 255, ...bind(`Q${n}_1`) }));
      }
      const lv = knob({ desc: 'Level', type: 'Level', max: 63, ...bind(`LV${n}_1`) }); lv.classList.add('span'); k.append(lv);
      v.append(k);
      if (wahMode) v.append(dry('MIX_DRY' + n));
    } else {
      v.append(el('div', 'head', 'OVERALL'));
      const o = el('div', 'overall'), fields = el('div', 'fields');
      const field = (title, key, lkey, items) => {
        const f = el('div', 'field', `<label>${title}</label><button class="drop"><span>${esc(label(lkey, d[key]))}</span><img src="assets/shape-arrow-dropbox.svg" alt=""></button>`);
        f.querySelector('button').onclick = async () => {
          const r = await pick(title, items());
          if (r !== undefined && r !== d[key]) { d[key] = r; this.touch(); this.renderEdit(); }
        };
        return f;
      };
      const opts = k => LABELS[k].map(([value, l]) => ({ value, label: l }));
      if (wahMode) fields.append(field('FILTER TYPE', 'FILTER_TYPE', 'filter', () => opts('filter')));
      fields.append(
        field('CONTROLLER', 'SOURCE', 'source', () => opts('source')),
        field('BYPASS', 'BYPASS_SOURCE', 'bypass', () => opts('bypass').map(x => ({ ...x, disabled: x.value === BYPASS.AUTO && d.AUTO }))),
        field('STROKE', 'CURVE_RESPONSE', 'curve', () => opts('curve').map(x => ({ ...x, disabled: x.value === CURVE.LOG && d.AUTO }))));
      o.append(fields, knob({ desc: 'Gain', type: 'Gain', max: 128, ...bind('GAIN') }));
      v.append(o, el('div', 'sep'));
      const auto = el('div', 'auto', `<span>AUTO</span><button class="circle"><img src="assets/autowah_check_${d.AUTO ? 'on' : 'off'}.svg" alt=""></button>`);
      auto.querySelector('button').onclick = () => {
        if (d.BYPASS_SOURCE === BYPASS.AUTO || d.CURVE_RESPONSE === CURVE.LOG) return toast('Auto is not available with Auto Heel bypass or Heel Boost stroke');
        d.AUTO = !d.AUTO; this.touch(); this.renderEdit();
      };
      v.append(auto, el('div', 'fastslow' + (d.AUTO ? '' : ' off'), '<span>FAST</span><span>SLOW</span>'));
      const tk = wahMode ? 'TIME_AUTO_WAH' : 'TIME_AUTO_LEVEL';
      v.append(slider({ max: 131070, step: 1, ...bind(tk), disabled: !d.AUTO, text: x => String(Math.round(x / 1310.7)) }));
    }
  },
  async leaveEdit() {   // called before leaving the edit page; false = stay
    const E = this.E; if (!E) return true;
    clearTimeout(E.timer);
    try {
      if (!eqAll(E.untouched, E.data)) {
        if (!(await confirmBox('Discard all changes ?', 'Preset changes not saved'))) return false;
        await storeTemp(E.untouched, E.pos);
      }
      if (E.from === 'library' && S.presets[E.pos]) await storeTemp(S.presets[E.pos].data, E.pos);
    } catch (e) { console.warn(e); }
    this.E = null; return true;
  },
  async saveEdit() {
    const E = this.E; if (!E) return;
    clearTimeout(E.timer); E.timer = null;
    const d = E.data;
    if (!d.NAME.trim()) return alertBox('Please give the preset a name.');
    if (!lib.isFactory(d)) {
      const i = lib.findUser(d);
      if (i >= 0 && !(await confirmBox(`Would you want to override preset '${d.NAME}' in library ?`, 'Already in library'))) return;
      const entry = { ...clone(d), STATUS: 0 };
      if (i >= 0) lib.user[i] = entry; else lib.user.push(entry);
      lib.saveUser();
    }
    loader(true, 'Saving…');
    try {
      if (E.from === 'pedal') {
        await saveFlash(d, E.pos); await storeTemp(d, E.pos); await selectPreset(E.pos);
        S.presets[E.pos].data = { ...clone(d), STATUS: 0 };
      } else if (S.presets[E.pos]) await storeTemp(S.presets[E.pos].data, E.pos);
    } catch (e) { loader(false); await syncFromPedal().catch(() => {}); this.E = null; fail(e); return this.show('home'); }
    loader(false); this.E = null; toast('Preset saved'); this.show('home');
  },

  // Presets library
  renderLib() {
    const cats = lib.categories(); this.libFilter = Math.min(this.libFilter, cats.length - 1);
    const cat = cats[this.libFilter], isUser = this.libFilter === cats.length - 1;
    $('#l-filter span').textContent = cat;
    $('#l-filter').onclick = async () => { const r = await pick('Filter Type', cats.map((c, i) => ({ label: c, value: i }))); if (r !== undefined) { this.libFilter = r; this.renderLib(); } };
    const items = isUser ? lib.user.map(d => ({ data: d, factory: false })) : lib.factory.filter(f => f.category === cat);
    const list = $('#l-list'); list.innerHTML = '';
    if (!items.length) list.append(el('p', 'cap', 'No preset here yet. Save a preset from the Live Edit page to add it.'));
    for (const it of items) {
      const idx = S.presets.findIndex(p => eqExceptStatus(p.data, it.data));
      const row = el('button', 'row', `<div class="circle ${idx < 0 ? 'empty' : ''}"><img src="${kSvg(Math.max(idx, 0))}" alt=""></div><span>${esc(it.data.NAME)}</span><div class="circle go"><img src="assets/shape-arrow.svg" alt=""></div>`);
      row.onclick = () => this.libActions(it);
      list.append(row);
    }
  },
  async libActions(it) {
    const r = await modal((f, close) => {
      for (let i = 0; i < MAX_PRESETS; i++) {
        const b = el('button', 'opt', `<span>Assign Preset to Slot ${i + 1}</span><img src="${kSvg(i)}" alt="">`); b.onclick = () => close(i); f.append(b);
      }
      const e = el('button', 'opt act', '<img src="assets/edit.svg" alt=""><span>EDIT PRESET</span>'); e.onclick = () => close('edit'); f.append(e);
      if (!it.factory) { const x = el('button', 'opt act', '<img src="assets/delete.svg" alt=""><span>DELETE PRESET</span>'); x.onclick = () => close('delete'); f.append(x); }
    });
    if (r === undefined) return;
    if (r === 'edit') return this.openEdit('library', it.data, S.sel);
    if (r === 'delete') { lib.user = lib.user.filter(u => u !== it.data); lib.saveUser(); return this.renderLib(); }
    loader(true, 'Assigning…');
    try { await saveFlash(it.data, r); await storeTemp(it.data, r); await selectPreset(r); await syncFromPedal(); }
    catch (e) { loader(false); return fail(e); }
    loader(false); this.show('home');
  },

  // Calibration tab
  renderCalib() {
    $('#c-exp').onclick = () => this.startWizard(SRC.EXP);
    $('#c-wah').onclick = () => this.startWizard(SRC.WAH);
    document.querySelectorAll('#c-seg button').forEach(b => {
      b.classList.toggle('on', +b.dataset.v === S.defaultPedal);
      b.onclick = async () => {
        if (+b.dataset.v === S.defaultPedal) return;
        loader(true, 'Saving presets…');
        try { await setDefaultPedal(+b.dataset.v); } catch (e) { fail(e); }
        loader(false); this.renderCalib();
      };
    });
  },

  // Calibration wizard: toe → heel → confirmation
  async startWizard(source) {
    this.W = { source, step: 0, gain: S.calib.WAH_GAIN, gt: null };
    await this.show('wiz');
    loader(true);
    try {
      await enterMode('calib');
      await sendCalib(source, CAL.GO_UP);
      if (source === SRC.WAH) { this.W.gain = 63; await sendCalib(SRC.WAH, null, 63); }
    } catch (e) { loader(false); fail(e); return this.show('calib'); }
    loader(false); this.renderWizard();
  },
  renderWizard() {
    const W = this.W, wah = W.source === SRC.WAH, v = $('#w-view');
    $('#w-title').textContent = `${wah ? 'WahWah' : 'Expression'} Calibration`;
    $('#w-dots').innerHTML = [0, 1, 2].map(i => `<i class="${i === W.step ? 'on' : ''}"></i>`).join('');
    $('#w-next').textContent = W.step === 2 ? 'DONE' : 'NEXT';
    v.innerHTML = '';
    const mc = el('div', 'mc', '<span>Movement Control</span><span class="n">-</span>'), num = mc.querySelector('.n');
    let m;
    if (W.step === 0) {
      v.append(Object.assign(el('img', 'pic'), { src: 'assets/pedal_toe.png' }));
      v.append(el('p', '', wah
        ? 'Put the pedal in the full TOE position, tweak the Adjust button or your wah pedal gain to put the blue marker in the green area, then press NEXT.'
        : 'Put the pedal in the full TOE position, if your expression pedal does not have any button volume, it should reach the desired level by itself.<br>If yes, tweak your expression pedal volume to put the orange line in the black area, then press NEXT.'));
      v.append(mc);
      m = meter({ wah, zone: wah ? [50, 70] : null, heelOn: false });
      if (wah) {
        const row = el('div', 'wrow');
        row.append(m, knob({ desc: 'Adjust', type: 'Adjust', max: 127, get: () => W.gain, set: g => {
          W.gain = g; clearTimeout(W.gt); W.gt = setTimeout(() => sendCalib(SRC.WAH, null, W.gain).catch(fail), 150);
        } }));
        v.append(row);
      } else v.append(m);
    } else if (W.step === 1) {
      v.append(Object.assign(el('img', 'pic'), { src: 'assets/pedal_heel.png' }));
      v.append(el('p', '', 'Put the pedal in the full HEEL position, then press NEXT.'), mc);
      m = meter({ wah, toeOn: false }); v.append(m);
    } else {
      v.append(el('p', '', 'Move the pedal from Heel to Toe and verify that your pedal response is correct within the full range, then press DONE.'), mc);
      m = meter({ wah }); v.append(m);
    }
    this.onPedal = () => {
      if (W.step < 2) { num.textContent = S.pedal; m.set(S.pedal / 10); return; }
      const a = wah ? S.calib.WAH_TOE : S.calib.EXP_TOE, b = wah ? S.calib.WAH_HEEL : S.calib.EXP_HEEL;
      const lo = Math.min(a, b), hi = Math.max(a, b), pct = hi > lo ? (S.pedal - lo) / (hi - lo) * 100 : 0;
      num.textContent = Math.round(Math.max(0, Math.min(100, pct))) + ' %'; m.set(pct);
    };
    this.onPedal();
  },
  async wizardNext() {
    const W = this.W; if (!W) return;
    try {
      if (W.step === 0) { W.step = 1; this.renderWizard(); await sendCalib(W.source, CAL.GO_DOWN); }
      else if (W.step === 1) { W.step = 2; this.renderWizard(); await sendCalib(W.source, CAL.DONE); }
      else {
        await sendCalib(W.source, CAL.VERIFY);
        await io.write(CH.first, new Uint8Array([0])); S.calibratedOnce = true;
        this.W = null; this.show('calib');
      }
    } catch (e) { fail(e); }
  },
};

// ───────────────────────── Connection flow ─────────────────────────
function discMsg(t, err) { const m = $('#disc-msg'); m.textContent = t || ''; m.classList.toggle('err', !!err); }
function fail(e) {
  console.error(e);
  if (!S.connected) return;
  toast('Pedal error: ' + (e && e.message ? e.message : e));
}
async function dropped(msg) {
  if (!S.connected) return;
  S.connected = false; S.mode = 'none'; ui.E = null; ui.W = null;
  $('#modal').hidden = true; loader(false);
  await ui.show('discover');
  discMsg(msg || 'Pedal disconnected.', true);
  $('#btn-reconnect').hidden = io !== ble || !ble.dev;
}
async function startSession(transport, device) {
  io = transport; io.onNotify = onNotify; io.onDrop = () => dropped();
  loader(true, 'Connecting…'); discMsg('');
  try {
    io.patient = true;
    await io.connect(device);
    loader(true, 'Pairing / reading pedal…');
    S.calibratedOnce = (await io.read(CH.first)).getUint8(0) === 0;   // first protected read: triggers bonding if needed
    S.fw = await io.firmware();
    loader(true, 'Syncing presets…');
    await syncFromPedal();
    io.patient = false;
  } catch (e) {
    io.patient = false; loader(false); console.error(e);
    try { io.disconnect(); } catch (x) { /* ignore */ }
    const win = /Windows/.test(navigator.userAgent) ? '\n\nOn Windows, pair the pedal first in Settings → Bluetooth & devices → Add device, then connect here.' : '';
    discMsg(`Can not connect to device.\n${e && e.message ? e.message : e}\n\nIf the pedal was already paired with another phone, or the bond was cleared on only one side, see "Pairing help" below.${win}`, true);
    $('#btn-reconnect').hidden = io !== ble || !ble.dev;
    return;
  }
  loader(false); S.connected = true; S.mode = 'none'; $('#btn-reconnect').hidden = true;
  $('#disc-ver').textContent = `${APP_VERSION} · firmware ${S.fw || 'unknown'}`;
  if (S.fw && !fwOk(S.fw)) await alertBox(`This pedal runs firmware ${S.fw}. Version ${MIN_FW} or later is expected: please update it with the iOS app. Some functions may not work.`, 'Firmware update needed');
  if (!S.calibratedOnce) {
    await ui.show('calib');
    await alertBox('Welcome ! This WahouWah has never been calibrated. Start by calibrating your wah or your expression pedal.');
  } else await ui.show('home');
}

// ───────────────────────── Wiring ─────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  $('#disc-ver').textContent = APP_VERSION;
  await lib.load().catch(e => discMsg('Could not load factory presets: ' + e.message, true));
  const supported = !!navigator.bluetooth;
  if (!supported) {
    discMsg('This browser does not support Web Bluetooth.\nOpen this page in Chrome on Android (or Chrome/Edge on a computer).', true);
    $('#btn-connect').disabled = true; $('#btn-connect').style.opacity = .4;
  }
  $('#btn-connect').onclick = async () => {
    let dev;
    try { dev = await ble.request(); } catch (e) { if (e.name !== 'NotFoundError') discMsg(e.message, true); return; }
    startSession(ble, dev);
  };
  $('#btn-reconnect').onclick = () => startSession(ble, ble.dev);
  $('#btn-demo').onclick = () => startSession(mock, null);
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { if (ui.page !== b.dataset.tab) ui.show(b.dataset.tab); });
  $('#e-back').onclick = () => ui.show(ui.E && ui.E.from === 'library' ? 'lib' : 'home');
  $('#e-save').onclick = () => ui.saveEdit();
  $('#e-mode').onclick = async () => {
    const E = ui.E; if (!E) return;
    const r = await pick('Mode Type', LABELS.mode.map(([value, l]) => ({ value, label: l })));
    if (r !== undefined && r !== E.data.MODE) { E.data.MODE = r; ui.touch(); ui.renderEdit(); }
  };
  const turn = n => { if (ui.E) { ui.E.view = (ui.E.view + n + 3) % 3; ui.renderEdit(); } };
  $('#e-prev').onclick = () => turn(-1); $('#e-next').onclick = () => turn(1);
  $('#w-next').onclick = () => ui.wizardNext();
  $('#w-cancel').onclick = () => { ui.W = null; ui.show('calib'); };
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (new URLSearchParams(location.search).has('demo')) startSession(mock, null);
});
