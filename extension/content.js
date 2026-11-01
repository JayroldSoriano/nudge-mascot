// Nudge content script: renders Nudge, a pixel mascot that waves, with a speech bubble
// carrying Claude Code's question or final message. Lives in a closed shadow root so page CSS can't touch it.
//
// Escalation levels (driven by the service worker, only for questions/permissions):
//   0 corner wave  ·  1 walks to bottom-center  ·  2 grows + annoyed face + foot tapping  ·  3 noise + roams the bottom edge
// When several sessions wait at once, a row of session pills above the message switches between them; the level
// the service worker sends is the most urgent session's.
(() => {
  if (window.__claudeNudge) return;
  window.__claudeNudge = true;

  // Nudge, the mascot: a golden pixel blob with an antenna status light. Original design, not Anthropic's.
  const BODY = '#FFC53D';
  const DARK = '#C98A12';
  const INK = '#2B2118';
  const GLINT = '#FFFFFF';
  const BULB = '#7ED957';

  // Pixel art on a 14x13 grid (x,y).
  const PX = {
    body: [],
    bulb: [[5, 0], [6, 0], [7, 0]],
    stalk: [[6, 1], [6, 2]],
    eyes: [[3, 6], [4, 6], [3, 7], [4, 7], [8, 6], [9, 6], [8, 7], [9, 7]],
    glint: [[3, 6], [8, 6]],
    smile: [[4, 9], [5, 10], [6, 10], [7, 10], [8, 9]],
    frown: [[4, 10], [5, 9], [6, 9], [7, 9], [8, 10]],
    browL: [[3, 4], [4, 5]],
    browR: [[9, 4], [8, 5]],
    footL: [[3, 12], [4, 12]],
    footR: [[8, 12], [9, 12]],
    armLeft: [[0, 7], [0, 8]],
    armUp: [[12, 4], [12, 5], [12, 6], [12, 7]],
    armOut: [[12, 7], [12, 6], [13, 5], [13, 4]],
  };
  for (let y = 3; y <= 11; y++) {
    for (let x = 1; x <= 11; x++) {
      const corner = (y === 3 || y === 11) && (x === 1 || x === 11);
      if (!corner) PX.body.push([x, y]);
    }
  }
  const rects = (pts, fill) => pts.map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`).join('');

  const mascotSvg = `
    <svg class="mascot" viewBox="0 0 14 13" shape-rendering="crispEdges" aria-hidden="true">
      <g class="body-group">
        ${rects(PX.stalk, DARK)}
        <g class="bulb">${rects(PX.bulb, BULB)}</g>
        ${rects(PX.body, BODY)}
        ${rects([[2, 11], [3, 11], [4, 11], [5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [10, 11]], DARK)}
        ${rects(PX.armLeft, BODY)}
        <g class="eyes">${rects(PX.eyes, INK)}${rects(PX.glint, GLINT)}</g>
        <g class="brows">${rects(PX.browL, INK)}${rects(PX.browR, INK)}</g>
        <g class="smile">${rects(PX.smile, INK)}</g>
        <g class="frown">${rects(PX.frown, INK)}</g>
      </g>
      <g class="foot foot-l">${rects(PX.footL, DARK)}</g>
      <g class="foot foot-r">${rects(PX.footR, DARK)}</g>
      <g class="arm arm-up">${rects(PX.armUp, BODY)}</g>
      <g class="arm arm-out">${rects(PX.armOut, BODY)}</g>
    </svg>`;

  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      position: fixed; z-index: 2147483647; bottom: 18px; right: 22px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      font-size: 14px; line-height: 1.45; color: #1f1d1a;
      pointer-events: none;
      transition: transform .9s cubic-bezier(.4, 0, .2, 1);
    }
    .root.left { right: auto; left: 22px; }
    .root.hidden { display: none; }
    .mover { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
    .root.left .mover { align-items: flex-start; }
    .root.lvl-1 .mover, .root.lvl-2 .mover, .root.lvl-3 .mover { align-items: center; }

    .bubble {
      pointer-events: auto; position: relative; max-width: 360px; min-width: 240px;
      background: #fffdf9; color: #1f1d1a; border: 2px solid #1f1d1a; border-radius: 14px;
      box-shadow: 4px 4px 0 #1f1d1a; padding: 12px 14px 10px;
      transform-origin: bottom right; animation: pop .22s cubic-bezier(.2,1.4,.4,1) both;
    }
    .root.left .bubble { transform-origin: bottom left; }
    .bubble.shake { animation: shake .5s ease-in-out both; }
    .root.lvl-3 .bubble { animation: pop .22s both, wiggle 1.2s ease-in-out infinite; }
    .bubble::after, .bubble::before {
      content: ""; position: absolute; bottom: -12px; right: 34px;
      border-width: 12px 10px 0 0; border-style: solid; border-color: #1f1d1a transparent;
    }
    .bubble::after { bottom: -8px; right: 35px; border-width: 9px 8px 0 0; border-color: #fffdf9 transparent; }
    .root.left .bubble::before { right: auto; left: 34px; border-width: 12px 0 0 10px; }
    .root.left .bubble::after  { right: auto; left: 35px; border-width: 9px 0 0 8px; }
    .root.lvl-1 .bubble::before, .root.lvl-2 .bubble::before, .root.lvl-3 .bubble::before { right: auto; left: calc(50% - 10px); border-width: 12px 10px 0 10px; }
    .root.lvl-1 .bubble::after,  .root.lvl-2 .bubble::after,  .root.lvl-3 .bubble::after  { right: auto; left: calc(50% - 8px); border-width: 9px 8px 0 8px; }
    .root.lvl-2 .bubble, .root.lvl-3 .bubble { border-color: #b3261e; box-shadow: 4px 4px 0 #b3261e; min-width: 320px; }

    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: ${BODY}; flex: none; }
    .dot.done { background: #2e8b57; }
    .dot.permission { background: #d9a400; }
    .dot.idle { background: #888; }
    .title { font-weight: 700; font-size: 13px; letter-spacing: .01em; }
    .project { margin-left: auto; font-size: 11px; padding: 2px 7px; border-radius: 999px; background: #f1e9df; color: #5a4a3a; max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .agent { margin-left: auto; font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1.5px solid #1f1d1a; background: #fff; color: #1f1d1a; white-space: nowrap; flex: none; }
    .project + .agent { margin-left: 0; }
    .msg { white-space: pre-wrap; word-break: break-word; max-height: 9.5em; overflow: hidden; position: relative; }
    .msg.expanded { max-height: 60vh; overflow: auto; }
    .msg.clamped::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2em; background: linear-gradient(transparent, #fffdf9); }
    .opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .opt { font-size: 12px; padding: 3px 9px; border: 1.5px solid #1f1d1a; border-radius: 999px; background: #fff3ea; }
    .foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
    .hint { font-size: 11px; color: #7a6a5a; flex: 1; min-width: 0; }
    .root.lvl-2 .hint, .root.lvl-3 .hint { color: #b3261e; font-weight: 600; }
    button { pointer-events: auto; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; flex: none; border: 1.5px solid #1f1d1a; border-radius: 8px; padding: 4px 10px; background: #fff; color: #1f1d1a; }
    button.primary { background: ${BODY}; color: #fff; }
    button.link { border: none; background: none; padding: 0; font-weight: 500; text-decoration: underline; color: #5a4a3a; }
    .spacer { flex: 1; }
    .dot.sent { background: #2e8b57; }
    .note { margin-top: 8px; font-size: 12px; color: #7a6a5a; }
    .err { margin-top: 8px; font-size: 12px; font-weight: 600; color: #b3261e; }

    /* Session switcher: one pill per blocked session (project, kind dot, how long it has waited). */
    /* Capped like .qlist: many sessions scroll inside the row instead of pushing the bubble off the top. */
    .sessions { display: flex; flex-wrap: wrap; gap: 6px; margin: -2px 0 9px; padding: 0 4px 9px 0; border-bottom: 1.5px dashed #e4d9c9; max-height: min(84px, 20vh); overflow-y: auto; }
    button.pill { display: inline-flex; align-items: center; gap: 5px; max-width: 160px; font-size: 11px; font-weight: 600; padding: 2px 8px 2px 7px; border-radius: 999px; background: #fffdf9; }
    button.pill .dot { width: 7px; height: 7px; }
    button.pill .pname { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    button.pill small { font-size: 11px; font-weight: 500; color: #7a6a5a; font-variant-numeric: tabular-nums; }
    button.pill.on { background: ${BODY}; box-shadow: 2px 2px 0 #1f1d1a; }
    button.pill.on small { color: #5a4a3a; }
    button.pill.hot { border-color: #b3261e; }
    button.pill.hot:not(.on) small { color: #b3261e; }
    .root .bubble.nopop { animation: none; }
    .root.lvl-3 .bubble.nopop { animation: wiggle 1.2s ease-in-out infinite; }

    /* Jump back: focuses the terminal app the session runs in. */
    .jumprow { margin-top: 8px; }
    button.jump { font-size: 12px; padding: 3px 10px; }
    button.jump::before { content: "\\21A9\\00a0"; }

    /* Reply from the bubble: the landing page's .btn (2px ink border, 3px hard shadow, presses into it). */
    .reply { margin-top: 10px; display: flex; flex-direction: column; gap: 12px; }
    .qlist { display: flex; flex-direction: column; gap: 12px; max-height: max(150px, calc(100vh - 330px)); overflow: auto; padding: 0 4px 4px 0; }
    .decide { display: flex; gap: 10px; }
    .decide .btn { flex: 1; }
    .q { display: flex; flex-direction: column; gap: 6px; }
    .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #7a6a5a; }
    .qtext { font-weight: 600; white-space: pre-wrap; word-break: break-word; }
    button.btn { border: 2px solid #1f1d1a; border-radius: 10px; padding: 7px 12px; font-size: 13px; background: #fffdf9; color: #1f1d1a; box-shadow: 3px 3px 0 #1f1d1a; }
    button.btn:active:not(:disabled) { transform: translate(2px, 2px); box-shadow: 1px 1px 0 #1f1d1a; }
    button.btn.gold, button.btn.sel { background: ${BODY}; color: #1f1d1a; }
    button.btn.red { background: #b3261e; color: #fff; }
    button.btn.sel::before { content: "\\2713\\00a0"; }
    button.btn:disabled { opacity: .45; cursor: default; }
    button.btn.choice { white-space: normal; text-align: left; width: 100%; padding: 5px 11px; }
    button.btn.send { align-self: flex-start; }
    .timer { position: absolute; left: 10px; right: 10px; bottom: 4px; height: 3px; border-radius: 2px; background: #eadfd2; overflow: hidden; }
    .timer > i { display: block; height: 100%; background: ${BODY}; width: 100%; transform-origin: left; }
    .timer.running > i { animation: shrink var(--t) linear forwards; }

    .scale { transition: transform .6s cubic-bezier(.2,1.2,.4,1); transform-origin: bottom center; }
    .root.lvl-1 .scale { transform: scale(1.25); }
    .root.lvl-1 .scale { margin-top: 16px; }
    .root.lvl-2 .scale { transform: scale(1.8); margin-top: 66px; }
    .root.lvl-3 .scale { transform: scale(1.8); margin-top: 110px; animation: hop 1s cubic-bezier(.3,0,.2,1) infinite; }
    .avatar { pointer-events: auto; cursor: pointer; width: 84px; height: 78px; animation: rise .35s cubic-bezier(.2,1.2,.4,1) both; }
    .mascot { width: 100%; height: 100%; display: block; overflow: visible; }
    .mascot .body-group { animation: bob 1.2s ease-in-out infinite; transform-origin: 6px 12px; }
    .mascot .eyes { animation: blink 4s steps(1) infinite; transform-origin: 6px 7px; }
    .mascot .brows, .mascot .frown { opacity: 0; }
    .mascot .bulb { animation: glow 2s ease-in-out infinite; }
    .root.lvl-1 .mascot .bulb rect { fill: #FFB020; }
    .root.lvl-2 .mascot .bulb rect, .root.lvl-3 .mascot .bulb rect { fill: #FF4D4D; }
    .root.lvl-2 .mascot .bulb { animation: blinkbulb .5s steps(1) infinite; }
    .root.lvl-3 .mascot .bulb { animation: blinkbulb .2s steps(1) infinite; }
    .mascot .arm-out { opacity: 0; }
    .avatar.waving .arm-up  { animation: waveA .5s steps(1) infinite; }
    .avatar.waving .arm-out { animation: waveB .5s steps(1) infinite; }
    .root.lvl-1 .avatar.waving .arm-up  { animation-duration: .3s; }
    .root.lvl-1 .avatar.waving .arm-out { animation-duration: .3s; }
    .root.lvl-2 .mascot .eyes, .root.lvl-3 .mascot .eyes { animation: none; transform: scaleY(.5); }
    .root.lvl-2 .mascot .brows, .root.lvl-3 .mascot .brows, .root.lvl-2 .mascot .frown, .root.lvl-3 .mascot .frown { opacity: 1; }
    .root.lvl-2 .mascot .smile, .root.lvl-3 .mascot .smile { opacity: 0; }
    .root.lvl-2 .mascot .foot-l { animation: tap .4s steps(1) infinite; }
    .root.lvl-3 .mascot .foot-l { animation: tap .25s steps(1) infinite; }
    .root.lvl-3 .mascot .foot-r { animation: tap .25s steps(1) infinite .125s; }
    .root.lvl-3 .mascot .body-group { animation: fume .3s ease-in-out infinite; }
    .root.lvl-3 .mascot .arm-up  { animation: waveA .2s steps(1) infinite; }
    .root.lvl-3 .mascot .arm-out { animation: waveB .2s steps(1) infinite; }
    .root.lvl-3 .mover { animation: roam 9s ease-in-out infinite; }

    @keyframes pop { from { transform: scale(.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @keyframes rise { from { transform: translateY(40px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    @keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-.35px); } }
    @keyframes blink { 0%, 92% { transform: scaleY(1); } 93%, 97% { transform: scaleY(.15); } 98% { transform: scaleY(1); } }
    @keyframes waveA { 0% { opacity: 1; } 50% { opacity: 0; } }
    @keyframes waveB { 0% { opacity: 0; } 50% { opacity: 1; } }
    @keyframes shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }
    @keyframes shake { 0%,100% { transform: translateX(0); } 20%,60% { transform: translateX(-7px); } 40%,80% { transform: translateX(7px); } }
    @keyframes wiggle { 0%,100% { transform: rotate(-1.5deg); } 50% { transform: rotate(1.5deg); } }
    @keyframes tap { 0% { transform: translateY(-1px); } 50% { transform: translateY(0); } }
    @keyframes fume { 0%,100% { transform: translateX(-.3px); } 50% { transform: translateX(.3px); } }
    @keyframes glow { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
    @keyframes blinkbulb { 0% { opacity: 1; } 50% { opacity: .15; } }
    @keyframes hop { 0%,100% { transform: scale(1.8) translateY(0); } 30% { transform: scale(1.8) translateY(-26px); } 45% { transform: scale(1.8) translateY(0); } 60% { transform: scale(1.8) translateY(-10px); } 70% { transform: scale(1.8) translateY(0); } }
    @keyframes roam { 0%,100% { transform: translateX(0); } 45%,55% { transform: translateX(var(--roam)); } }
    @media (prefers-reduced-motion: reduce) {
      .root, .bubble, .avatar, .scale, .mover, .mascot * { animation: none !important; transition: none !important; }
    }
  `;

  // Used by scripts/make-assets.js to draw the mascot on promo images. Invisible to pages (isolated world).
  window.__claudeNudgeMascotSvg = mascotSvg;

  const host = document.createElement('div');
  host.id = 'claude-nudge-host';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${css}</style><div class="root hidden"><div class="mover"><div class="bubble-slot"></div><div class="scale"><div class="avatar">${mascotSvg}</div></div></div></div>`;
  (document.body || document.documentElement).appendChild(host);

  const root = shadow.querySelector('.root');
  const mover = shadow.querySelector('.mover');
  const slot = shadow.querySelector('.bubble-slot');
  const avatar = shadow.querySelector('.avatar');
  let dismissTimer = null;
  let waveTimer = null;
  let settleTimer = null;
  let current = null;
  let level = 0;
  let settled = false; // showing "Sent to Claude" / "Answered on your phone" for a moment before dismissing
  let sessions = []; // the session switcher's pills; empty when only one session has a nudge
  let pillTimer = null;

  // Events from other agents carry `agent`; Claude Code's may not (older relays), so absent means Claude.
  const AGENT_NAMES = { codex: 'Codex', gemini: 'Gemini', grok: 'Grok', cursor: 'Cursor', opencode: 'OpenCode' };
  const who = () => (current && AGENT_NAMES[current.agent]) || 'Claude';
  const HINTS = {
    done: () => 'Esc to dismiss',
    idle: () => 'Esc to dismiss',
    0: (_s, here) => (here ? 'Answer here or in the terminal' : 'Waiting for you in the terminal'),
    1: (s) => `Still here. ${who()} has been waiting ${s}s.`,
    2: () => `Hey. ${who()} is blocked on you.`,
    3: () => `${who().toUpperCase()}. HAS. BEEN. WAITING.`,
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // `sessions`: pills for the switcher (empty with one session). `quiet`: a switch or refresh, not a new nudge,
  // so no sound, and no pop or shake when the bubble is already on screen.
  function render(event, settings, expiresAt, startLevel = 0, waitingMs = 0, { sessions: pills = [], quiet = false } = {}) {
    if (current && current.id === event.id) {
      if (!settled) { updatePills(pills); setLevel(startLevel, waitingMs, false); }
      return; // already showing here
    }
    const remainingMs = expiresAt ? expiresAt - Date.now() : 0;
    if (expiresAt && remainingMs <= 0) return;
    const auto = remainingMs > 0 ? remainingMs / 1000 : 0;
    const switching = quiet && !!current && !settled && !root.classList.contains('hidden');
    clearTimeout(settleTimer);
    settled = false;
    current = event;
    root.classList.toggle('left', settings.position === 'bottom-left');
    const reply = replyKind(event);
    const qs = event.options || [];
    // Several questions are each shown with their own text, so the joined message would only repeat them.
    const showMsg = !(reply === 'question' && qs.length > 1);
    const opts = reply ? '' : qs
      .flatMap((q) => q.choices || [])
      .map((c) => `<span class="opt">${esc(c)}</span>`)
      .join('');
    slot.innerHTML = `
      <div class="bubble${switching ? ' nopop' : ''}" role="status" aria-live="polite">
        <div class="head">
          <span class="dot ${esc(event.kind)}"></span>
          <span class="title">${esc(event.title)}</span>
          ${event.project ? `<span class="project" title="${esc(event.cwd || event.project)}">${esc(event.project)}</span>` : ''}
          ${event.agent && event.agent !== 'claude-code' ? `<span class="agent">${esc(AGENT_NAMES[event.agent] || event.agent)}</span>` : ''}
        </div>
        ${showMsg ? `<div class="msg">${esc(event.message)}</div>` : ''}
        ${opts ? `<div class="opts">${opts}</div>` : ''}
        ${event.kind === 'permission' && !reply ? '<div class="note">Answer in the terminal</div>' : ''}
        ${reply ? replyHtml(event, reply) : ''}
        ${event.session_id ? `<div class="jumprow"><button class="jump" title="Switch to ${esc(event.terminal || 'the terminal')} where this ${esc(AGENT_NAMES[event.agent] || 'Claude Code')} session runs">Jump to terminal</button></div>` : ''}
        <div class="err" role="alert" hidden></div>
        <div class="foot">
          <span class="hint"></span>
          <span class="spacer"></span>
          <button class="link more" hidden>Show more</button>
          <button class="snooze" hidden>Snooze ${Number(settings.snoozeMin) || 5}m</button>
          <button class="primary dismiss">Got it</button>
        </div>
        ${auto > 0 ? `<div class="timer running" style="--t:${auto.toFixed(1)}s"><i></i></div>` : ''}
      </div>`;

    const msg = slot.querySelector('.msg');
    const more = slot.querySelector('.more');
    requestAnimationFrame(() => {
      if (msg && msg.scrollHeight > msg.clientHeight + 2) {
        msg.classList.add('clamped');
        more.hidden = false;
      }
    });
    more.addEventListener('click', () => {
      const expanded = msg.classList.toggle('expanded');
      msg.classList.toggle('clamped', !expanded);
      more.textContent = expanded ? 'Show less' : 'Show more';
      if (expanded) hold();
    });
    if (reply) wireReply(event, reply);
    const jump = slot.querySelector('.jump');
    if (jump) jump.addEventListener('click', () => jumpBack(event, jump));
    updatePills(pills);
    slot.querySelector('.dismiss').addEventListener('click', () => dismiss());
    slot.querySelector('.snooze').addEventListener('click', () => {
      send({ type: 'nudgeSnooze', id: current && current.id });
      dismiss(false);
    });
    slot.querySelector('.bubble').addEventListener('mouseenter', hold);

    root.classList.remove('hidden');
    if (!switching) level = -1; // force setLevel to apply (a switch keeps the level: the mascot follows the most urgent)
    setLevel(startLevel, waitingMs, false);
    wave();

    stopAutoDismiss();
    if (auto > 0) dismissTimer = setTimeout(dismiss, auto * 1000);
    if (settings.sound && !quiet) blip(event.kind);
  }

  // ---------- session switcher ----------
  // How long Claude has been waiting in that session (wall clock, from the event's time).
  function waited(ts) {
    const sec = Math.max(0, Math.round((Date.now() - (Number(ts) || Date.now())) / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
  }

  function updatePills(list) {
    sessions = Array.isArray(list) ? list : [];
    const bubble = slot.querySelector('.bubble');
    let box = slot.querySelector('.sessions');
    if (!sessions.length || !bubble || settled) {
      if (box) box.remove();
      clearInterval(pillTimer); pillTimer = null;
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.className = 'sessions';
      box.setAttribute('role', 'tablist');
      box.setAttribute('aria-label', 'Claude Code sessions waiting on you');
      bubble.insertBefore(box, bubble.firstChild);
    }
    box.innerHTML = sessions.map((p) => {
      const on = current && p.id === current.id;
      return `<button class="pill${on ? ' on' : ''}${p.level >= 2 ? ' hot' : ''}" role="tab" aria-selected="${on}" data-key="${esc(p.key)}" title="${esc(p.cwd || p.project || '')}">`
        + `<i class="dot ${esc(p.kind)}"></i><span class="pname">${esc(p.project || 'session')}</span><small data-ts="${Number(p.ts) || 0}">${waited(p.ts)}</small></button>`;
    }).join('');
    box.querySelectorAll('.pill').forEach((b) => b.addEventListener('click', () => {
      if (b.classList.contains('on')) return;
      hold();
      send({ type: 'selectSession', key: b.dataset.key });
    }));
    if (!pillTimer) pillTimer = setInterval(() => {
      slot.querySelectorAll('.pill small[data-ts]').forEach((el) => { el.textContent = waited(el.dataset.ts); });
    }, 5000);
  }

  // ---------- jump back ----------
  // Asks the relay (through the service worker) to bring this session's terminal app to the front.
  async function jumpBack(event, btn) {
    const err = slot.querySelector('.err');
    err.hidden = true;
    btn.disabled = true;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'jumpBack', session_id: event.session_id, agent: event.agent });
    } catch (_) {
      res = { ok: false, error: 'Nudge was reloaded. Refresh this page, or switch to the terminal yourself.' };
    }
    if (!current || current.id !== event.id) return;
    btn.disabled = false;
    if (res && res.ok) {
      if (event.kind === 'done' || event.kind === 'idle') dismiss(); // nothing left to answer: you're on your way
      return;
    }
    hold();
    err.textContent = (res && res.error) || "Couldn't switch to the terminal.";
    err.hidden = false;
  }

  // ---------- reply from the bubble ----------
  // 'permission' (Allow / Deny) or 'question' (the choices), when the approval hook is waiting on it; else null.
  function replyKind(event) {
    if (!event.approvable || !event.tool_use_id || event.decided) return null;
    if (event.kind === 'permission') return 'permission';
    if (event.kind === 'question' && (event.options || []).some((q) => (q.choices || []).length)) return 'question';
    return null;
  }

  // Same rules as the phone app: one single-select question answers on tap (gold buttons);
  // several questions or a multi-select one take picks, then "Send answers".
  const isImmediate = (qs) => qs.length === 1 && !qs[0].multiSelect;
  const questionKey = (q, i) => q.question || q.header || `Question ${i + 1}`;

  function replyHtml(event, reply) {
    if (reply === 'permission') {
      return '<div class="reply"><div class="decide"><button class="btn gold" data-behavior="allow">Allow</button><button class="btn red" data-behavior="deny">Deny</button></div></div>';
    }
    const qs = event.options;
    const immediate = isImmediate(qs);
    const groups = qs.map((q, i) => {
      const eyebrow = q.header ? `${q.header}${q.multiSelect ? ' \u00b7 pick any' : ''}` : q.multiSelect ? 'Pick any' : '';
      return `<div class="q">
        ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
        ${qs.length > 1 && q.question ? `<div class="qtext">${esc(q.question)}</div>` : ''}
        ${(q.choices || []).map((c, j) => `<button class="btn choice${immediate ? ' gold' : ''}" data-q="${i}" data-c="${j}"${immediate ? '' : ' aria-pressed="false"'}>${esc(c)}</button>`).join('')}
      </div>`;
    }).join('');
    // The list scrolls on short windows; "Send answers" stays outside it, always in view.
    return `<div class="reply"><div class="qlist">${groups}</div>${immediate ? '' : '<button class="btn gold send" disabled>Send answers</button>'}</div>`;
  }

  function wireReply(event, reply) {
    const box = slot.querySelector('.reply');
    if (reply === 'permission') {
      box.querySelectorAll('[data-behavior]').forEach((b) => b.addEventListener('click', () => decide(event, { behavior: b.dataset.behavior })));
      return;
    }
    const qs = event.options;
    const immediate = isImmediate(qs);
    const picked = qs.map(() => []);
    const send = box.querySelector('.send');
    box.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.q);
      const label = qs[i].choices[Number(b.dataset.c)];
      if (immediate) return decide(event, { answer: label, answers: { [questionKey(qs[0], 0)]: label } });
      picked[i] = qs[i].multiSelect ? (picked[i].includes(label) ? picked[i].filter((c) => c !== label) : [...picked[i], label]) : [label];
      box.querySelectorAll(`.choice[data-q="${i}"]`).forEach((o) => {
        const on = picked[i].includes(qs[i].choices[Number(o.dataset.c)]);
        o.classList.toggle('sel', on);
        o.setAttribute('aria-pressed', String(on));
      });
      send.disabled = !picked.every((p) => p.length);
    }));
    if (send) send.addEventListener('click', () => {
      const answers = {};
      qs.forEach((q, i) => { answers[questionKey(q, i)] = q.multiSelect ? picked[i] : picked[i][0]; });
      // Exactly one question: keep the single `answer` field alongside `answers`, as the phone does.
      decide(event, { ...(qs.length === 1 ? { answer: picked[0].join(', ') } : {}), answers });
    });
  }

  // Sends the answer through the service worker to the relay. Success settles the bubble; failure keeps the buttons.
  async function decide(event, payload) {
    const box = slot.querySelector('.reply');
    const err = slot.querySelector('.err');
    const buttons = box ? [...box.querySelectorAll('button')] : [];
    const before = buttons.map((b) => b.disabled);
    buttons.forEach((b) => { b.disabled = true; });
    err.hidden = true;
    hold();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'decide', id: event.id, agent: event.agent, session_id: event.session_id, tool_use_id: event.tool_use_id, ...payload });
    } catch (_) {
      res = { ok: false, error: 'Nudge was reloaded. Refresh this page or answer in the terminal.' };
    }
    if (!current || current.id !== event.id) return; // dismissed meanwhile
    if (res && res.ok) return settle('Sent to Claude');
    if (res && res.settled) return settle(res.settled);
    buttons.forEach((b, i) => { b.disabled = before[i]; });
    err.textContent = (res && res.error) || 'Could not send. Answer in the terminal.';
    err.hidden = false;
  }

  // The answered state: calm mascot, green dot, one line, gone after 1.5 s.
  function settle(text) {
    if (!current || settled) return;
    setLevel(0, 0, false);
    settled = true;
    const dot = slot.querySelector('.dot');
    if (dot) dot.className = 'dot sent';
    const title = slot.querySelector('.title');
    if (title) title.textContent = text;
    slot.querySelectorAll('.sessions, .msg, .opts, .note, .reply, .jumprow, .err, .foot, .timer').forEach((el) => el.remove());
    clearInterval(pillTimer); pillTimer = null;
    stopAutoDismiss();
    wave(1500);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => dismiss(false), 1500);
  }

  function wave(ms = 3500) {
    avatar.classList.remove('waving');
    void avatar.offsetWidth; // restart animation
    avatar.classList.add('waving');
    clearTimeout(waveTimer);
    waveTimer = setTimeout(() => avatar.classList.remove('waving'), ms);
  }

  function setLevel(next, waitingMs, noise) {
    if (!current || settled) return;
    const escalating = current.kind === 'question' || current.kind === 'permission';
    if (!escalating) next = 0;
    const hint = slot.querySelector('.hint');
    if (hint) hint.textContent = escalating ? HINTS[next](Math.round(waitingMs / 1000), !!replyKind(current)) : HINTS[current.kind]();
    const snooze = slot.querySelector('.snooze');
    if (snooze) snooze.hidden = next === 0;
    if (noise) alarm();
    if (next === level) return;
    const prev = level;
    level = next;
    root.classList.remove('lvl-1', 'lvl-2', 'lvl-3');
    if (next > 0) root.classList.add(`lvl-${next}`);
    place();
    if (next >= 1 && prev < next) wave(next === 1 ? 6000 : 3500);
    if (next === 2) {
      const b = slot.querySelector('.bubble');
      if (b) { b.classList.add('shake'); setTimeout(() => b.classList.remove('shake'), 600); }
    }
  }

  // Level 0 sits in the corner; levels 1+ move to bottom-center; level 3 roams from there to the far edge and back.
  function place() {
    if (level === 0) {
      root.style.transform = '';
      mover.style.removeProperty('--roam');
      return;
    }
    const w = root.getBoundingClientRect().width || 360;
    const margin = 22;
    const toCenter = window.innerWidth / 2 - margin - w / 2;
    const sign = root.classList.contains('left') ? 1 : -1;
    root.style.transform = `translateX(${sign * Math.max(0, toCenter)}px)`;
    mover.style.setProperty('--roam', `${sign * Math.max(0, toCenter - 10)}px`);
  }
  window.addEventListener('resize', () => { if (current && level > 0) place(); });

  function stopAutoDismiss() {
    clearTimeout(dismissTimer);
    dismissTimer = null;
    const t = slot.querySelector('.timer');
    if (t) t.classList.remove('running');
  }

  function hold() {
    if (!dismissTimer) return;
    stopAutoDismiss();
    send({ type: 'nudgeHold', id: current && current.id });
  }

  // notify=false when the background asked us to dismiss (dismissed in another tab, resolved, snoozed, or expired).
  function dismiss(notify = true) {
    const id = current && current.id;
    stopAutoDismiss();
    clearTimeout(waveTimer);
    clearTimeout(settleTimer);
    settled = false;
    sessions = [];
    clearInterval(pillTimer); pillTimer = null;
    root.classList.add('hidden');
    root.classList.remove('lvl-1', 'lvl-2', 'lvl-3');
    root.style.transform = '';
    slot.innerHTML = '';
    current = null;
    level = 0;
    if (notify && id != null) send({ type: 'nudgeDismissed', id });
  }

  function send(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { /* extension reloaded */ }
  }

  function tones(notes, gain, step, len) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const t = ctx.currentTime + i * step;
        o.type = 'square';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + len + 0.01);
      });
      setTimeout(() => ctx.close(), (notes.length * step + len) * 1000 + 200);
    } catch (_) { /* autoplay policy may block; the visual tier doesn't depend on it */ }
  }
  const blip = (kind) => tones(kind === 'done' ? [660, 880] : [523, 659, 784], 0.05, 0.09, 0.08);
  const alarm = () => tones([880, 660, 880, 660, 1046, 784, 1046], 0.09, 0.13, 0.11);

  avatar.addEventListener('click', () => { if (current) dismiss(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) dismiss();
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'nudge') { render(msg.event, msg.settings || {}, msg.expiresAt, msg.level || 0, msg.waitingMs || 0, { sessions: msg.sessions || [], quiet: !!msg.quiet }); sendResponse({ ok: true }); }
    else if (msg.type === 'escalate') { if (current && current.id === msg.id) setLevel(msg.level, msg.waitingMs || 0, !!msg.noise); sendResponse({ ok: true }); }
    else if (msg.type === 'dismiss') { dismiss(false); sendResponse({ ok: true }); }
    else if (msg.type === 'settled') { if (current && current.id === msg.id) settle(msg.text || 'Answered'); sendResponse({ ok: true }); }
  });
})();
