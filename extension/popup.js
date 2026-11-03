const DEFAULTS = {
  port: 47831, showDone: true, showQuestion: true, showPermission: true, showIdle: false, autoDismissSec: 20, position: 'bottom-right', sound: false,
  escalation: 'full', escalationSound: true, escalateAt1: 15, escalateAt2: 30, escalateAt3: 60, snoozeMin: 5,
  relayUrl: '', // hosted relay for phone pairing; empty = the relay's default
};
const fields = Object.keys(DEFAULTS);
let settings = { ...DEFAULTS };
let relaySecret = ''; // the relay's connection code (chrome.storage.local, set by Connect below)
// Phone pairing stays hidden until the hosted relay and the app are live; the store build is local only.
const PHONE = false;

async function load() {
  settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  ({ relaySecret = '' } = await chrome.storage.local.get('relaySecret'));
  for (const f of fields) {
    const el = document.getElementById(f);
    if (el.type === 'checkbox') el.checked = !!settings[f];
    else el.value = settings[f];
  }
  refresh();
  refreshPhone();
  refreshStats();
}

for (const f of fields) {
  document.getElementById(f).addEventListener('change', async (e) => {
    const el = e.target;
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    settings[f] = value;
    await chrome.storage.sync.set({ [f]: value });
  });
}

async function refresh() {
  const { relayStatus, recentEvents = [] } = await chrome.runtime.sendMessage({ type: 'getStatus' });
  const status = document.getElementById('status');
  const connected = relayStatus === 'connected';
  const locked = relayStatus === 'locked';
  status.classList.toggle('connected', connected);
  status.querySelector('span').textContent = connected ? 'relay connected' : locked ? 'needs the code' : 'relay offline';
  document.getElementById('help').hidden = connected || locked;
  if (locked) showConnect();
  const list = document.getElementById('recent');
  const shown = recentEvents.filter((ev) => ev.kind !== 'resolved');
  list.innerHTML = shown.length ? '' : '<div class="ev"><small>No nudges yet.</small></div>';
  for (const ev of [...shown].reverse()) {
    const d = document.createElement('div');
    d.className = 'ev';
    d.title = ev.message;
    const time = new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    d.innerHTML = `<b></b> <small></small> <span></span>`;
    d.querySelector('b').textContent = ev.title;
    d.querySelector('small').textContent = `${ev.project || ''} ${time}`;
    d.querySelector('span').textContent = ev.message;
    list.appendChild(d);
  }
}

document.getElementById('preview').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'previewNudge' });
  window.close();
});
document.getElementById('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(refresh, 800);
});

// Calls the local relay with the connection code. A 401 means the code is missing or wrong: show Connect.
const relayApi = (path, init = {}) => fetch(`http://127.0.0.1:${settings.port}/${path}`, { ...init, headers: { ...(init.headers || {}), 'X-Nudge-Secret': relaySecret } }).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) { showConnect(); throw new Error('needs the connection code'); }
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
});

const $ = (id) => document.getElementById(id);
if (PHONE) $('phoneSection').hidden = $('lockTest').hidden = false;

// ---------- Connect: paste the relay's code (printed by `npx nudge-mascot setup` and `status`) ----------
function showConnect() {
  if (!$('connectBox').hidden) return;
  $('connectBox').hidden = false;
  $('secretInput').focus();
}
$('connectBtn').addEventListener('click', async () => {
  const hint = $('connectHint');
  $('connectBtn').disabled = true;
  hint.textContent = 'Checking…';
  const r = await chrome.runtime.sendMessage({ type: 'connect', secret: $('secretInput').value });
  $('connectBtn').disabled = false;
  if (!r || !r.ok) { hint.textContent = (r && r.error) || 'Could not connect.'; return; }
  ({ relaySecret = '' } = await chrome.storage.local.get('relaySecret'));
  $('secretInput').value = '';
  $('connectBox').hidden = true;
  hint.textContent = '';
  setTimeout(refresh, 800);
  refreshPhone();
  refreshStats();
});
$('secretInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('connectBtn').click(); });

// ---------- Phone pairing: the local relay mints the code, the popup shows it as a QR ----------
let pollTimer = null;
let pairExpiresAt = 0;

function showPairBox(r) {
  $('pairBox').hidden = false;
  $('pairCode').textContent = r.pairCode;
  $('pairRelay').textContent = r.relay;
  pairExpiresAt = Date.now() + (r.expiresInSeconds || 600) * 1000;
  // The QR carries nudge://pair?code=…&relay=…, which the app's scanner (and later its deep link) understands.
  const qr = qrcode(0, 'M');
  qr.addData(r.link);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  tickHint();
  // The hosted relay knows when the phone claims the code; switch to "paired" without a click.
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshPhone, 3000);
}

function tickHint() {
  const left = Math.max(0, Math.round((pairExpiresAt - Date.now()) / 1000));
  $('pairHint').textContent = left ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` : 'Expired: tap Pair a phone again.';
}
setInterval(() => { if (!$('pairBox').hidden) tickHint(); }, 1000);

async function refreshPhone() {
  if (!PHONE) return;
  let s;
  try { s = await relayApi('pair/status'); } catch (e) {
    $('phoneState').textContent = /connection code/.test(e.message) ? 'Connect Nudge first (above)' : 'Relay offline';
    $('pairStart').hidden = true; $('unpair').hidden = true;
    return;
  }
  const paired = s.paired && typeof s.phones === 'number' && s.phones > 0;
  // Prefill the relay the laptop last used, so Unpair -> Pair a phone goes back to the same place.
  const relayInput = $('relayUrl');
  if (!relayInput.value && s.relay) relayInput.placeholder = s.relay;
  $('pairStart').hidden = paired;
  $('unpair').hidden = !s.paired;
  $('relayRow').hidden = s.paired;
  if (paired) {
    $('phoneState').textContent = `Paired · ${s.phones} phone${s.phones === 1 ? '' : 's'}${s.devices ? `, push on ${s.devices}` : ''}`;
    $('pairBox').hidden = true;
    clearInterval(pollTimer); pollTimer = null;
  } else if (s.paired) {
    $('phoneState').textContent = s.error ? `Waiting for the phone (${s.error})` : s.pairCodeOpen ? 'Waiting for the phone to scan…' : 'Code expired';
    $('pairStart').hidden = false;
  } else {
    $('phoneState').textContent = 'Not paired';
  }
}

$('pairStart').addEventListener('click', async () => {
  $('pairStart').disabled = true;
  $('phoneState').textContent = 'Asking the relay…';
  try {
    const relay = (settings.relayUrl || '').trim() || $('relayUrl').placeholder || undefined;
    const r = await relayApi('pair/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relay }) });
    showPairBox(r);
    await refreshPhone();
  } catch (e) {
    $('phoneState').textContent = `Could not start pairing: ${e.message}`;
  } finally { $('pairStart').disabled = false; }
});

// ---------- Test nudges: the relay's /test, same as `npx nudge-mascot test <kind>` ----------
for (const b of document.querySelectorAll('button.test')) {
  b.addEventListener('click', async () => {
    const kind = b.dataset.kind, delay = Number(b.dataset.phoneDelay || 0);
    const hint = $('testHint');
    hint.textContent = delay ? `Sent. Lock the phone now: the notification arrives in ${delay} s.` : 'Sent.';
    try {
      await relayApi(`test?kind=${encodeURIComponent(kind)}${delay ? `&phoneDelay=${delay}` : ''}`, { method: 'POST' });
      setTimeout(refresh, 500);
    } catch (e) { hint.textContent = `Could not send: ${e.message}`; }
  });
}

$('unpair').addEventListener('click', async () => {
  if (!confirm('Forget the phone? The bubble keeps answering Claude; nothing waits for the phone afterwards.')) return;
  try { await relayApi('pair/stop', { method: 'POST' }); } catch (_) { /* relay offline */ }
  $('pairBox').hidden = true;
  clearInterval(pollTimer); pollTimer = null;
  refreshPhone();
});

// ---------- Waiting stats: GET /stats from the local relay; the share image is drawn here, never uploaded ----------

let weekStats = null;

// 47 min, 1 h 5 min, under a minute.
function fmtWait(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return ms > 0 ? 'under a minute' : '0 min';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}
const fmtDay = (ts, year) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
const weekDates = (st) => `${fmtDay(st.from)} – ${fmtDay(st.to, true)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function refreshStats() {
  let st;
  try { st = await relayApi('stats?range=week'); } catch (e) {
    $('weekHeadline').textContent = /not found|404/.test(e.message) ? 'Update the relay for waiting stats: npx nudge-mascot setup'
      : /connection code/.test(e.message) ? 'Connect Nudge to see your stats.' : 'Relay offline.';
    return;
  }
  weekStats = st;
  const head = $('weekHeadline');
  if (!st.count) {
    head.textContent = 'Claude hasn\'t waited on you this week. Nice.';
    $('weekCompare').textContent = st.previous.count ? `Last week: ${fmtWait(st.previous.waitedMs)} across ${plural(st.previous.count, 'nudge')}.` : '';
    $('weekProjects').innerHTML = '';
    $('shareStats').disabled = true;
    return;
  }
  head.innerHTML = 'Claude waited on you <b></b> across <b></b>';
  const [mins, count] = head.querySelectorAll('b');
  mins.textContent = fmtWait(st.waitedMs);
  count.textContent = plural(st.count, 'nudge');
  const diff = st.change.waitedMs;
  $('weekCompare').textContent = !st.previous.count ? `${weekDates(st)} · first week with stats`
    : Math.abs(diff) < 60000 ? `${weekDates(st)} · about the same as last week`
    : `${weekDates(st)} · ${fmtWait(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} than last week`;
  const list = $('weekProjects');
  list.innerHTML = '';
  for (const p of st.byProject.slice(0, 3)) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><b></b>';
    li.querySelector('span').textContent = p.project === 'unknown' ? 'other' : p.project;
    li.title = `${plural(p.count, 'nudge')}`;
    li.querySelector('b').textContent = fmtWait(p.ms);
    list.appendChild(li);
  }
  $('shareStats').disabled = false;
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`could not load ${src}`));
  img.src = src;
});

// The largest font size (down from `size`) at which `text` fits in `maxWidth`.
function fitFont(g, text, weight, size, family, maxWidth) {
  for (; size > 20; size -= 4) {
    g.font = `${weight} ${size}px ${family}`;
    if (g.measureText(text).width <= maxWidth) break;
  }
  return size;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// A card in the landing page's style: paper, ink border, hard offset shadow.
function card(g, x, y, w, h, r, shadow) {
  g.fillStyle = INK;
  roundRect(g, x + shadow, y + shadow, w, h, r); g.fill();
  g.fillStyle = PAPER;
  roundRect(g, x, y, w, h, r); g.fill();
  g.lineWidth = 3; g.strokeStyle = INK; g.stroke();
}

const INK = '#1F1D1A', PAPER = '#FFFDF9', SAND = '#F1E9DF', GOLD = '#FFC53D', MUTED = '#7A6A5A';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// 1200x630 (link-preview size): the headline number, the nudge count, the week's dates and the mascot.
async function renderShareImage(st) {
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 630;
  const g = c.getContext('2d');
  g.fillStyle = SAND; g.fillRect(0, 0, 1200, 630);
  card(g, 40, 40, 1110, 540, 26, 10);

  g.textBaseline = 'alphabetic';
  g.fillStyle = MUTED;
  g.font = `600 22px ${MONO}`;
  g.fillText('NUDGE  ·  THIS WEEK', 100, 122);

  g.fillStyle = INK;
  g.font = `700 52px ${SANS}`;
  g.fillText('Claude waited on you', 100, 205);

  // The number, on a gold highlighter stroke.
  const big = fmtWait(st.waitedMs);
  const size = fitFont(g, big, 800, 148, SANS, 620);
  const w = g.measureText(big).width;
  g.fillStyle = GOLD;
  g.fillRect(92, 360 - size * 0.34, w + 20, size * 0.36);
  g.fillStyle = INK;
  g.fillText(big, 100, 360);

  g.font = `600 44px ${SANS}`;
  g.fillText(`across ${plural(st.count, 'nudge')}`, 100, 440);

  g.fillStyle = MUTED;
  g.font = `500 26px ${MONO}`;
  g.fillText(weekDates(st), 100, 525);

  // Speech bubble + mascot on the right.
  card(g, 770, 104, 320, 128, 20, 6);
  g.fillStyle = INK;
  g.beginPath(); g.moveTo(940, 232); g.lineTo(976, 232); g.lineTo(944, 268); g.closePath(); g.fill();
  g.fillStyle = PAPER;
  g.beginPath(); g.moveTo(945, 229); g.lineTo(970, 229); g.lineTo(948, 254); g.closePath(); g.fill();
  g.fillStyle = INK;
  g.font = `700 30px ${SANS}`;
  g.fillText('Hey. Claude is', 800, 160);
  g.fillText('blocked on you.', 800, 200);

  const icon = await loadImage('icons/icon128.png');
  g.imageSmoothingEnabled = false;
  g.drawImage(icon, 822, 278, 256, 256);

  g.fillStyle = MUTED;
  g.font = `500 20px ${MONO}`;
  g.textAlign = 'right';
  g.fillText('nudge-mascot.vercel.app', 1110, 560);
  g.textAlign = 'left';
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

$('shareStats').addEventListener('click', async () => {
  if (!weekStats || !weekStats.count) return;
  const hint = $('shareHint');
  try {
    const blob = await renderShareImage(weekStats);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nudge-week-${new Date(weekStats.to).toISOString().slice(0, 10)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    hint.textContent = 'Saved to Downloads.';
  } catch (e) {
    hint.textContent = `Could not make the image: ${e.message}`;
  }
});

load();
