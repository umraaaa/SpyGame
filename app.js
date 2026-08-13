'use strict';
/* 音樂臥底 prototype
 * 連線：PeerJS 點對點，房主裝置就是主機（host-authoritative）。
 * iTunes 搜尋 / 試聽全部在各自裝置上以 JSONP 執行，只回傳選好的 preview url。
 */

// ===== 小工具 =====
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rand = n => Math.floor(Math.random() * n);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

function confirmBox(text, onOk) {
  $('#modalText').textContent = text;
  $('#modal').classList.remove('hidden');
  $('#modalOk').onclick = () => { $('#modal').classList.add('hidden'); onOk(); };
  $('#modalCancel').onclick = () => $('#modal').classList.add('hidden');
}

// ===== 音訊（單一 Audio，音量統一控制）=====
const audio = new Audio();
audio.preload = 'auto';
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
let audioUnlocked = false;

// 手機瀏覽器要在使用者手勢中先「解鎖」音訊，之後才能程式化播放
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  audio.src = SILENT;
  audio.play().catch(() => {});
}
document.addEventListener('click', unlockAudio, { once: true, capture: true });
document.addEventListener('touchend', unlockAudio, { once: true, capture: true });

function playUrl(url, onEnd) {
  audio.onended = onEnd || null;
  audio.onerror = () => { toast('音樂載入失敗 😢'); if (onEnd) onEnd(); };
  audio.src = url;
  audio.play().catch(() => { toast('播放被瀏覽器擋下，請先點一下畫面'); if (onEnd) onEnd(); });
}
function stopAudio() { audio.onended = null; audio.pause(); }

$('#vol').oninput = e => { audio.volume = +e.target.value; localStorage.setItem('mspyVol', e.target.value); };
audio.volume = +(localStorage.getItem('mspyVol') ?? 1);
$('#vol').value = audio.volume;

// ===== iTunes 搜尋（JSONP，在自己裝置上執行）=====
let jsonpSeq = 0;
function itunesSearch(term) {
  return new Promise((resolve, reject) => {
    const cb = '__itunes_cb' + (++jsonpSeq);
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 10000);
    function cleanup() { delete window[cb]; s.remove(); clearTimeout(timer); }
    window[cb] = data => { cleanup(); resolve(data.results || []); };
    s.onerror = () => { cleanup(); reject(new Error('load failed')); };
    s.src = 'https://itunes.apple.com/search?media=music&entity=song&limit=8&country=TW'
        + '&term=' + encodeURIComponent(term) + '&callback=' + cb;
    document.head.appendChild(s);
  });
}

// ===== 連線層 =====
let peer = null, hostConn = null, isHost = false, myId = null, myName = '';
let roomCode = '';
const conns = new Map(); // 房主用：peerId -> DataConnection

// 房主的完整遊戲狀態（唯一真相）
const H = { mode: 'song', phase: 'lobby', players: [], pairs: {}, round: null, roundNum: 0, replaySeq: 0 };

function randCode() {
  const cs = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => cs[rand(cs.length)]).join('');
}

function createRoom(name, mode) {
  H.mode = mode;
  roomCode = randCode();
  peer = new Peer('mspy-' + roomCode);
  peer.on('open', () => {
    isHost = true; myId = 'HOST'; myName = name;
    H.players = [{ id: 'HOST', name, ready: false, connected: true, isHost: true }];
    enterGame();
    broadcast();
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { peer.destroy(); createRoom(name, mode); return; }
    toast('連線錯誤：' + e.type);
  });
  peer.on('connection', c => {
    c.on('open', () => conns.set(c.peer, c));
    c.on('data', m => hostHandle(m, c.peer));
    c.on('close', () => {
      conns.delete(c.peer);
      const p = H.players.find(p => p.id === c.peer);
      if (p) p.connected = false;
      broadcast();
    });
  });
}

function joinRoom(name, code) {
  peer = new Peer();
  peer.on('error', e => {
    if (e.type === 'peer-unavailable') toast('找不到房間 ' + code);
    else toast('連線錯誤：' + e.type);
  });
  peer.on('open', () => {
    hostConn = peer.connect('mspy-' + code, { reliable: true });
    hostConn.on('open', () => {
      myId = peer.id; myName = name; roomCode = code;
      hostConn.send({ t: 'join', name });
      enterGame();
    });
    hostConn.on('data', m => { if (m.t === 'state') { lastState = m.s; onState(); } });
    hostConn.on('close', () => toast('與房主斷線了'));
  });
}

// 動作統一入口：房主本人直接處理，其他人送給房主
function send(m) {
  if (isHost) hostHandle(m, 'HOST');
  else if (hostConn && hostConn.open) hostConn.send(m);
}

// ===== 房主邏輯 =====
function hostHandle(m, pid) {
  const p = H.players.find(x => x.id === pid);
  if (m.t === 'join') {
    if (p) { p.connected = true; p.name = m.name; }
    else H.players.push({ id: pid, name: m.name, ready: false, connected: true, isHost: false });
  }
  else if (m.t === 'lobbyReady') { if (p) p.ready = m.v; }
  else if (m.t === 'pair') { H.pairs[pid] = m.pair; }
  else if (m.t === 'perfReady') {
    const q = roundPart(pid);
    if (q) q.perfReady = true;
    checkAllPerfReady();
  }
  else if (m.t === 'ended') {
    const q = roundPart(pid);
    if (q) q.ended = true;
    checkAllEnded();
  }
  broadcast();
}

function roundPart(pid) {
  if (H.round == null) return null;
  return H.round.participants.find(q => q.id === pid) || null;
}

function hostStartGame() { H.phase = 'game'; broadcast(); }

function hostStartRound() {
  const ps = H.players.filter(p => p.connected);
  const done = ps.filter(p => H.pairs[p.id]);
  if (done.length === 0) { toast('還沒有人出題'); return; }
  if (ps.length < 2) { toast('至少要 2 個人'); return; }

  // Step 1: 先隨機選一組歌（決定出題者）
  const submitter = done[rand(done.length)];
  const pair = H.pairs[submitter.id];

  // Step 2: 再選人——出題者不能上台；人數為全員的 30% 取 Ceil
  const pool = ps.filter(p => p.id !== submitter.id);
  const n = Math.min(Math.max(Math.ceil(ps.length * 3 / 10), 1), pool.length);
  const parts = shuffle(pool).slice(0, n)
    .map(p => ({ id: p.id, name: p.name, perfReady: false, ended: false }));

  // Step 3: 參加者中隨機一人是臥底
  const spyId = parts[rand(parts.length)].id;

  H.roundNum++;
  H.round = { num: H.roundNum, submitterId: submitter.id, pair, participants: parts, spyId, stage: 'waitReady', replay: null };
  broadcast();
}

function checkAllPerfReady() {
  const r = H.round;
  if (r == null || r.stage !== 'waitReady') return;
  if (r.participants.every(q => q.perfReady) === false) return;
  beginCountdown();
}

function beginCountdown() {
  const r = H.round;
  if (r == null || r.stage !== 'waitReady') return;
  r.stage = 'countdown';
  broadcast();
  setTimeout(() => {
    if (H.round !== r || r.stage !== 'countdown') return;
    r.stage = 'playing';
    broadcast();
    checkAllEnded(); // 有人可能在倒數期間就回報載入失敗
  }, 3000);
}

// 卡關時房主手動推進（取代自動保險絲）
function hostForceDiscuss() {
  const r = H.round;
  if (r == null || r.stage !== 'playing') return;
  r.stage = 'discuss';
  broadcast();
}

function checkAllEnded() {
  const r = H.round;
  if (r == null || r.stage !== 'playing') return;
  if (r.participants.every(q => q.ended) === false) return;
  r.stage = 'discuss';
  broadcast();
}

function hostReplay(pid) {
  if (H.round == null) return;
  H.round.replay = { seq: ++H.replaySeq, pid };
  broadcast();
}

function hostNextRound() {
  // 用過的題目公開了，出題者要重新出題
  delete H.pairs[H.round.submitterId];
  H.round = null;
  broadcast();
}

// 依玩家身分裁切狀態：自己的題目、自己被分配到的歌，別人看不到
function assignedSong(r, pid) {
  const side = (pid === r.spyId) ? r.pair.spy : r.pair.civ;
  if (H.mode === 'word') return { word: side.word };
  return { title: side.song.title, artist: side.song.artist, art: side.song.art, url: side.song.url, hint: side.hint };
}

function stateFor(pid) {
  const r = H.round;
  const meP = r ? r.participants.find(q => q.id === pid) : null;
  return {
    code: roomCode, youId: pid, isHost: pid === 'HOST', phase: H.phase, mode: H.mode,
    players: H.players.map(p => ({
      id: p.id, name: p.name, ready: p.ready, connected: p.connected,
      isHost: p.isHost, hasPair: H.pairs[p.id] != null,
    })),
    myPair: H.pairs[pid] || null,
    round: r == null ? null : {
      num: r.num, stage: r.stage,
      participants: r.participants.map(q => ({ id: q.id, name: q.name, perfReady: q.perfReady, ended: q.ended })),
      isParticipant: meP != null,
      mySong: meP ? assignedSong(r, pid) : null,
      replay: r.replay == null ? null : {
        seq: r.replay.seq,
        name: (H.players.find(p => p.id === r.replay.pid) || {}).name,
        song: assignedSong(r, r.replay.pid),
      },
    },
  };
}

function broadcast() {
  for (const p of H.players) {
    if (p.id === 'HOST') { lastState = stateFor('HOST'); onState(); continue; }
    const c = conns.get(p.id);
    if (c && c.open) c.send({ t: 'state', s: stateFor(p.id) });
  }
}

// ===== 客戶端：狀態 → 畫面 + 音訊效果 =====
let lastState = null;
let prevStageKey = '';
let playedReplaySeq = 0;
let countdownTimer = null;

function onState() {
  syncPending(lastState);
  render(lastState);
  effects(lastState);
}

function effects(s) {
  const r = s.round;
  const key = r ? (r.num + ':' + r.stage) : 'none';
  if (key !== prevStageKey) {
    prevStageKey = key;
    if (r && r.stage === 'countdown') startCountdown(r);
    if (r == null) { stopAudio(); hideCountdown(); }
  }
  // 複盤：所有裝置一起播出該參加者的歌（單詞模式只顯示、不播音）
  if (r && r.replay && r.replay.seq > playedReplaySeq) {
    playedReplaySeq = r.replay.seq;
    if (r.replay.song.url) playUrl(r.replay.song.url, null);
  }
}

function startCountdown(r) {
  let n = 3;
  showCountdown(n);
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    n--;
    if (n > 0) { showCountdown(n); return; }
    clearInterval(countdownTimer);
    hideCountdown();
    if (r.isParticipant && r.mySong && r.mySong.url) {
      playUrl(r.mySong.url, () => send({ t: 'ended' }));
    }
  }, 1000);
}
function showCountdown(n) { $('#countNum').textContent = n; $('#countOverlay').classList.remove('hidden'); }
function hideCountdown() { $('#countOverlay').classList.add('hidden'); }

// ===== 畫面 =====
function enterGame() {
  $('#scrHome').classList.add('hidden');
  $('#scrGame').classList.remove('hidden');
  $('#roomChip').textContent = '房號 ' + roomCode;
  $('#roomChip').classList.remove('hidden');
  $('#btnSavePair').onclick = savePair;
  $('#tabStage').onclick = () => switchTab(true);
  $('#tabSong').onclick = () => switchTab(false);
}

function songRow(sg, extra) {
  return `<div class="song ${extra?.sel ? 'sel' : ''}">
    <img src="${esc(sg.art)}" alt="">
    <div class="meta"><div class="t">${esc(sg.title)}</div><div class="a">${esc(sg.artist)}</div></div>
    ${extra?.buttons || ''}
  </div>`;
}

function render(s) {
  if (s == null) return;
  ensurePanels(s.mode);

  // 上台的人整回合都不能切到點歌頁
  const locked = s.round != null && s.round.isParticipant;
  $('#tabSong').disabled = locked;
  if (locked) switchTab(true);

  const v = $('#viewStage');
  const me = s.players.find(p => p.id === s.youId) || {};
  const r = s.round;
  const word = s.mode === 'word';
  const tabName = word ? '出題' : '點歌';

  // ---- 大廳 ----
  if (s.phase === 'lobby') {
    const allReady = s.players.filter(p => p.connected).every(p => p.ready);
    v.innerHTML = `
      <div class="card">
        <h2>🛋️ 大廳</h2>
        <p class="dim">玩法：${word ? '✏️ 單詞臥底' : '🎵 歌曲臥底'}<br>把房號 <b>${esc(s.code)}</b> 給朋友，同一網頁輸入就能加入。<br>可以先去「${tabName}」分頁偷偷出題。</p>
        <div class="pList">${s.players.map(p =>
          `<span class="pTag ${p.connected ? '' : 'off'}">${p.isHost ? '👑' : ''}${esc(p.name)}<span class="badge">${p.ready ? '✅' : '💤'}</span></span>`).join('')}
        </div>
      </div>
      <button id="btnLobbyReady" class="btn big ${me.ready ? 'ghost' : ''}">${me.ready ? '取消準備' : '✋ 我準備好了'}</button>
      ${s.isHost ? `<button id="btnStartGame" class="btn big" ${allReady && s.players.length >= 2 ? '' : 'disabled'} style="margin-top:10px">🚀 開始遊戲</button>` : ''}
    `;
    $('#btnLobbyReady').onclick = () => send({ t: 'lobbyReady', v: me.ready === false });
    if (s.isHost) $('#btnStartGame').onclick = hostStartGame;
    return;
  }

  // ---- 遊戲中、回合間：等待出題 ----
  if (r == null) {
    const ps = s.players.filter(p => p.connected);
    const done = ps.filter(p => p.hasPair);
    v.innerHTML = `
      <div class="card stageBig">
        <span class="emoji">🎼</span>
        <h2>出題時間</h2>
        <p class="dim">到「${tabName}」分頁${word ? '填好兩個詞' : '選好兩首歌'}並送出。<br>不用等全員出完，有題目就能開。出題進度：<b>${done.length} / ${ps.length}</b></p>
        <div class="pList" style="justify-content:center">${ps.map(p =>
          `<span class="pTag">${esc(p.name)}<span class="badge">${p.hasPair ? '🎵' : '⏳'}</span></span>`).join('')}
        </div>
      </div>
      ${s.isHost ? `<button id="btnStartRound" class="btn big" ${done.length >= 1 && ps.length >= 2 ? '' : 'disabled'}>🎬 開始本回合</button>` : ''}
    `;
    if (s.isHost) $('#btnStartRound').onclick = hostStartRound;
    return;
  }

  // ---- 回合進行中 ----
  const meP = r.participants.find(q => q.id === s.youId);
  let html = `<div class="card"><h2>第 ${r.num} 回合</h2><p class="dim">上台：${r.participants.map(q => esc(q.name)).join('、')}</p></div>`;

  if (r.stage === 'waitReady') {
    html += `<div class="card">
      <h2>${word ? '✋ 上台準備' : '🎧 上台準備'}</h2>
      <p class="dim">${word ? '參加者請按下準備。全員就緒後倒數 3 秒同時亮出你的詞。' : '參加者請戴上耳機，按下準備。全員就緒後倒數 3 秒同時播放。'}</p>
      ${r.participants.map(q => `<div class="readyRow"><span>${esc(q.name)}</span><span>${q.perfReady ? '✅ 已準備' : '⏳ 等待中'}</span></div>`).join('')}
    </div>`;
    if (r.isParticipant) {
      html += meP.perfReady
        ? `<div class="card stageBig"><span class="emoji">🕰️</span>等其他人按準備…</div>`
        : `<button id="btnPerfReady" class="btn big">${word ? '✋ 準備好了！' : '🎧 耳機戴好了，準備！'}</button>`;
    }
    if (s.isHost) {
      html += `<button id="btnForceStart" class="btn big ghost" style="margin-top:10px">⏭ 有人卡住了，直接開始</button>`;
    }
  }
  else if (r.stage === 'countdown' || r.stage === 'playing') {
    const seenRows = r.participants.map(q =>
      `<div class="readyRow"><span>${esc(q.name)}</span><span>${q.ended ? '👌 看好了' : '⌛ 看詞中'}</span></div>`).join('');
    if (r.isParticipant && r.mySong) {
      if (word) {
        html += `<div class="card stageBig"><p class="dim">🤫 你的詞（只有你看得到）</p><div class="bigWord">${esc(r.mySong.word)}</div></div>
          <div class="card">${seenRows}</div>
          ${meP.ended ? '' : `<button id="btnSeen" class="btn big">👌 看好了</button>`}`;
      } else {
        html += `<div class="card">
          <h2>🤫 你的歌（只有你看得到）</h2>
          ${songRow(r.mySong)}
          ${r.mySong.hint ? `<p class="dim" style="margin-top:8px">💡 提示：${esc(r.mySong.hint)}</p>` : ''}
          <div class="eq"><i></i><i></i><i></i><i></i><i></i></div>
        </div>`;
      }
    } else {
      html += word
        ? `<div class="card stageBig"><span class="emoji">👀</span><h2>看詞中…</h2>
            <p class="dim">參加者正在記自己的詞</p></div><div class="card">${seenRows}</div>`
        : `<div class="card stageBig"><span class="emoji">🎶</span><h2>演出中…</h2>
            <p class="dim">參加者正在用耳機聽歌</p>
            <div class="eq"><i></i><i></i><i></i><i></i><i></i></div></div>`;
    }
    if (s.isHost && r.stage === 'playing') {
      html += `<button id="btnForceDiscuss" class="btn big ghost" style="margin-top:10px">⏭ 有裝置沒反應，強制進討論</button>`;
    }
  }
  else if (r.stage === 'discuss') {
    html += `<div class="card stageBig"><span class="emoji">💬</span><h2>討論時間！</h2>
      <p class="dim">輪流描述、哼唱自己聽到的歌，找出臥底 🕵️</p></div>`;
    if (r.replay) {
      html += word
        ? `<div class="card"><h2>🔁 複盤中</h2><div class="bigWord">${esc(r.replay.song.word)}</div><p class="dim">這是 <b>${esc(r.replay.name)}</b> 拿到的詞</p></div>`
        : `<div class="card"><h2>🔁 複盤中</h2>${songRow(r.replay.song)}<p class="dim" style="margin-top:8px">這是 <b>${esc(r.replay.name)}</b> 聽到的歌</p></div>`;
    }
    if (s.isHost) {
      html += `<div class="card"><h2>👑 房主控制</h2>
        ${r.participants.map(q => `<div class="readyRow"><span>${esc(q.name)}</span><button class="btn mini btnReplay" data-id="${q.id}">🔁 複盤</button></div>`).join('')}
      </div>
      <button id="btnNextRound" class="btn big">➡️ 下一輪</button>`;
    }
  }

  v.innerHTML = html;
  const bp = $('#btnPerfReady');
  if (bp) bp.onclick = () => send({ t: 'perfReady' });
  const bs = $('#btnSeen');
  if (bs) bs.onclick = () => send({ t: 'ended' });
  const bf = $('#btnForceStart');
  if (bf) bf.onclick = () => confirmBox('還有參加者沒按準備，確定直接開始倒數嗎？', beginCountdown);
  const bd = $('#btnForceDiscuss');
  if (bd) bd.onclick = () => confirmBox('確定不等回報、直接進入討論嗎？', hostForceDiscuss);
  document.querySelectorAll('.btnReplay').forEach(b => b.onclick = () => hostReplay(b.dataset.id));
  const bn = $('#btnNextRound');
  if (bn) bn.onclick = () => confirmBox('確定要結束討論、進入下一輪嗎？（這回合的題目會作廢，出題者要重新出題）', hostNextRound);
}

// ===== 點歌 / 出題面板 =====
// pending = 本機編輯中的題目；送出後才同步給房主
const pending = { civ: { song: null, hint: '', word: '' }, spy: { song: null, hint: '', word: '' } };
let pendingInit = false, hadPair = false, panelsMode = null;

// 面板依玩法長不一樣：歌曲＝搜尋+試聽+提示，單詞＝一個輸入框
function ensurePanels(mode) {
  if (panelsMode === mode) return;
  panelsMode = mode;
  $('#tabSong').textContent = mode === 'word' ? '✏️ 出題' : '🎼 點歌';
  $('#tipCard').innerHTML = mode === 'word'
    ? '兩邊各填一個有關聯的詞：多數人會拿到「平民的詞」，臥底拿到「臥底的詞」。<br>送出後只有你自己看得到，隨時可以改。'
    : '兩邊各選一首互相有關的歌：多數人會拿到「平民的歌」，臥底拿到「臥底的歌」。<br>送出後只有你自己看得到，隨時可以改。';
  for (const el of document.querySelectorAll('.panel')) {
    const side = el.dataset.side;
    el.querySelector('h3').textContent = (side === 'civ' ? '😇 平民的' : '🕵️ 臥底的') + (mode === 'word' ? '詞' : '歌');
    const body = el.querySelector('.pBody');
    if (mode === 'word') {
      body.innerHTML = `<input class="pWord" maxlength="30" placeholder="輸入一個詞，例如：珍珠奶茶">`;
      body.querySelector('.pWord').oninput = e => { pending[side].word = e.target.value; };
      continue;
    }
    body.innerHTML = `
      <div class="row"><input class="pSearch" placeholder="搜尋歌名或歌手"><button class="btn mini pGo">搜尋</button></div>
      <div class="pResults"></div>
      <div class="pSel"></div>
      <input class="pHint" placeholder="提示（讓上台的人快速知道這是什麼歌）">
    `;
    const doSearch = async () => {
      const term = el.querySelector('.pSearch').value.trim();
      if (term === '') return;
      el.querySelector('.pResults').innerHTML = '<p class="dim">搜尋中…</p>';
      try {
        const results = await itunesSearch(term);
        renderResults(el, side, results);
      } catch { el.querySelector('.pResults').innerHTML = '<p class="dim">搜尋失敗，再試一次</p>'; }
    };
    el.querySelector('.pGo').onclick = doSearch;
    el.querySelector('.pSearch').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
    el.querySelector('.pHint').oninput = e => { pending[side].hint = e.target.value; };
  }
  refreshPanels();
}

// 把 pending 的內容套回面板（初次載入 / 題目被用掉時）
function refreshPanels() {
  for (const el of document.querySelectorAll('.panel')) {
    const side = el.dataset.side;
    if (panelsMode === 'word') {
      const w = el.querySelector('.pWord');
      if (w) w.value = pending[side].word;
      continue;
    }
    renderSelected(el, side);
  }
}

function switchTab(stage) {
  $('#tabStage').classList.toggle('on', stage);
  $('#tabSong').classList.toggle('on', stage === false);
  $('#viewStage').classList.toggle('hidden', stage === false);
  $('#viewSong').classList.toggle('hidden', stage);
}

function renderResults(el, side, results) {
  const box = el.querySelector('.pResults');
  const songs = results.filter(t => t.previewUrl).map(t => ({
    title: t.trackName, artist: t.artistName, art: t.artworkUrl100, url: t.previewUrl,
  }));
  if (songs.length === 0) { box.innerHTML = '<p class="dim">沒有找到可試聽的歌</p>'; return; }
  box.innerHTML = songs.map((sg, i) => songRow(sg, {
    buttons: `<button class="btn mini ghost bTry" data-i="${i}">▶</button><button class="btn mini bPick" data-i="${i}">選</button>`,
  })).join('');
  box.querySelectorAll('.bTry').forEach(b => b.onclick = () => playUrl(songs[+b.dataset.i].url, null));
  box.querySelectorAll('.bPick').forEach(b => b.onclick = () => {
    pending[side].song = songs[+b.dataset.i];
    stopAudio();
    box.innerHTML = '';
    renderSelected(el, side);
  });
}

function renderSelected(el, side) {
  const sg = pending[side].song;
  el.querySelector('.pSel').innerHTML = sg == null ? '' :
    songRow(sg, { sel: true, buttons: '<button class="btn mini ghost bTry2">▶</button>' });
  const b = el.querySelector('.bTry2');
  if (b) b.onclick = () => playUrl(sg.url, null);
  el.querySelector('.pHint').value = pending[side].hint;
}

function savePair() {
  if (panelsMode === 'word') {
    if (pending.civ.word.trim() === '' || pending.spy.word.trim() === '') { toast('兩邊都要填一個詞'); return; }
  }
  else if (pending.civ.song == null || pending.spy.song == null) { toast('兩邊都要選一首歌'); return; }
  send({ t: 'pair', pair: JSON.parse(JSON.stringify(pending)) });
  toast('題目已送出 🎵（隨時可以改）');
  switchTab(true);
}

// 從房主回傳的狀態同步自己的題目（第一次載入 / 題目被用掉時）
function syncPending(s) {
  if (s == null) return;
  if (pendingInit === false && s.myPair) {
    Object.assign(pending.civ, JSON.parse(JSON.stringify(s.myPair.civ)));
    Object.assign(pending.spy, JSON.parse(JSON.stringify(s.myPair.spy)));
    refreshPanels();
  }
  if (s.myPair) { pendingInit = true; hadPair = true; }
  if (hadPair && s.myPair == null) {
    hadPair = false;
    pending.civ = { song: null, hint: '', word: '' };
    pending.spy = { song: null, hint: '', word: '' };
    refreshPanels();
    toast('你的題目被用掉了，請出新題 🎼');
  }
}

// ===== 首頁事件 =====
let createMode = 'song';
$('#modeSong').onclick = () => { createMode = 'song'; $('#modeSong').classList.add('on'); $('#modeWord').classList.remove('on'); };
$('#modeWord').onclick = () => { createMode = 'word'; $('#modeWord').classList.add('on'); $('#modeSong').classList.remove('on'); };
$('#btnCreate').onclick = () => {
  const name = $('#inName').value.trim();
  if (name === '') { toast('先輸入暱稱'); return; }
  createRoom(name, createMode);
};
$('#btnJoin').onclick = () => {
  const name = $('#inName').value.trim();
  const code = $('#inCode').value.trim().toUpperCase();
  if (name === '') { toast('先輸入暱稱'); return; }
  if (code.length !== 4) { toast('房號是 4 碼'); return; }
  joinRoom(name, code);
};
