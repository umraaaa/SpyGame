'use strict';
/* 臥底遊戲 prototype
 * 連線：PeerJS 點對點，房主裝置就是主機（host-authoritative）。
 * iTunes 搜尋 / 試聽全部在各自裝置上以 JSONP 執行，只回傳選好的 preview url。
 * 內容模式：song(歌曲) / word(單詞)；表決模式：multi(多次) / single(單次)。
 */

// ===== 小工具 =====
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rand = n => Math.floor(Math.random() * n);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const MIN_PLAYERS = 4; // ponytail: 規格最小十人；測試暫時調成 4，正式改回 10
const VERSION = 'v14';  // 每次改版就 +1，方便在手機上確認抓到最新程式
$('.logo').insertAdjacentHTML('beforeend', ` <span class="ver">${VERSION}</span>`);

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

// ===== 音訊（單一 Audio，音量 + 暫停統一控制）=====
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

$('#vol').oninput = e => { audio.volume = +e.target.value; audio.muted = false; localStorage.setItem('mspyVol', e.target.value); updateMuteBtn(); };
audio.volume = +(localStorage.getItem('mspyVol') ?? 1);
$('#vol').value = audio.volume;

// 點喇叭圖示 = 靜音 / 取消靜音。用 audio.muted（iOS 不讓程式改 volume，但 muted 有效）
const btnMute = $('#btnMute');
btnMute.onclick = () => { audio.muted = audio.muted === false; updateMuteBtn(); };
function updateMuteBtn() { btnMute.textContent = audio.muted ? '🔇' : '🔊'; }
updateMuteBtn();

// 暫停 / 繼續（涵蓋自己的歌與複盤，因為只有一個 Audio）
const btnPause = $('#btnPause');
btnPause.onclick = () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); };
function updatePauseBtn() { btnPause.textContent = audio.paused ? '▶️' : '⏸️'; }

// 試聽按鈕會依實際播放狀態顯示 ▶ / ⏸，讓同一顆按鈕可以停下試聽
function updatePreviewBtns() {
  document.querySelectorAll('.tryBtn').forEach(b => {
    const active = b.dataset.url === audio.src && audio.paused === false;
    b.textContent = active ? '⏸' : '▶';
  });
}
function togglePreview(url) {
  if (audio.src === url && audio.paused === false) audio.pause();
  else playUrl(url, null);
}
audio.addEventListener('play', () => { updatePauseBtn(); updatePreviewBtns(); });
audio.addEventListener('pause', () => { updatePauseBtn(); updatePreviewBtns(); });
audio.addEventListener('ended', () => { updatePauseBtn(); updatePreviewBtns(); });

// ===== iTunes 搜尋（JSONP）=====
function itunesSearch(term) {
  return new Promise(async (resolve, reject) => {
    // 1. 我們真正要抓的蘋果 API 網址
    const appleUrl = `https://itunes.apple.com/search?media=music&entity=song&limit=8&country=TW&term=${encodeURIComponent(term)}`;
    
    // 2. 把蘋果網址包裝給 AllOrigins 閘道，加上時間戳防快取
    // 使用 encodeURIComponent 確保網址格式不會亂掉
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(appleUrl)}&_t=${Date.now()}`;
    
    const controller = new AbortController();
    // 設定 8 秒超時保護
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('搜尋超時，請檢查網路'));
    }, 8000);

    try {
      // 3. 透過 fetch 呼叫閘道，因為有合法的 CORS 標頭，瀏覽器絕對不會擋
      const response = await fetch(proxyUrl, {
        signal: controller.signal,
        cache: 'no-store' // 徹底禁止瀏覽器快取
      });
      
      clearTimeout(timer);
      
      if (!response.ok) {
        throw new Error('閘道伺服器無回應');
      }

      // 4. 解析閘道回傳的資料
      const proxyData = await response.json();
      
      // AllOrigins 會把真正的蘋果回傳資料，以「字串」形式包在 proxyData.contents 裡面
      if (proxyData.contents) {
        const appleData = JSON.parse(proxyData.contents);
        resolve(appleData.results || []);
      } else {
        resolve([]);
      }
      
    } catch (err) {
      clearTimeout(timer);
      console.error(err);
      reject(new Error('搜尋失敗，請再試一次'));
    }
  });
}

// ===== 連線層 =====
let peer = null, hostConn = null, isHost = false, myId = null, myName = '';
let roomCode = '';
const conns = new Map(); // 房主用：peerId -> DataConnection

// 房主的完整遊戲狀態（唯一真相）
const H = {
  contentMode: 'song', voteMode: 'multi', phase: 'lobby',
  players: [], queues: {}, pairSeq: 0, round: null, roundNum: 0, replaySeq: 0,
};

function randCode() {
  const cs = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => cs[rand(cs.length)]).join('');
}

function createRoom(name, contentMode, voteMode) {
  H.contentMode = contentMode; H.voteMode = voteMode;
  roomCode = randCode();
  peer = new Peer('mspy-' + roomCode);
  peer.on('open', () => {
    isHost = true; myId = 'HOST'; myName = name;
    H.players = [{ id: 'HOST', name, ready: false, connected: true, isHost: true }];
    enterGame();
    broadcast();
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { peer.destroy(); createRoom(name, contentMode, voteMode); return; }
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

function isConnected(id) { const p = H.players.find(x => x.id === id); return p != null && p.connected; }

// ===== 房主邏輯 =====
function hostHandle(m, pid) {
  const p = H.players.find(x => x.id === pid);
  if (m.t === 'join') {
    if (p) { p.connected = true; p.name = m.name; }
    else H.players.push({ id: pid, name: m.name, ready: false, connected: true, isHost: false });
  }
  else if (m.t === 'lobbyReady') { if (p) p.ready = m.v; }
  else if (m.t === 'queueAdd') {
    if (!H.queues[pid]) H.queues[pid] = [];
    const pair = m.pair; pair.id = ++H.pairSeq;
    H.queues[pid].push(pair);
  }
  else if (m.t === 'queueRemove') {
    if (H.queues[pid]) H.queues[pid] = H.queues[pid].filter(x => x.id !== m.id);
  }
  else if (m.t === 'perfReady') { const q = roundPart(pid); if (q) q.perfReady = true; checkAllPerfReady(); }
  else if (m.t === 'ended') { const q = roundPart(pid); if (q) q.ended = true; checkAllEnded(); }
  else if (m.t === 'vote') { hostVote(pid, m.target); }
  broadcast();
}

function roundPart(pid) {
  if (H.round == null) return null;
  return H.round.participants.find(q => q.id === pid) || null;
}

function hostStartGame() { H.phase = 'game'; broadcast(); }

// 臥底數：≤5→1，6~8→2，9~11→3…（每 3 人多 1），最多留 1 個平民
function spyCount(nPart) {
  const s = Math.max(1, Math.floor((nPart - 6) / 3) + 2);
  return Math.min(s, nPart - 1);
}

function hostStartRound() {
  const ps = H.players.filter(p => p.connected);
  if (ps.length < MIN_PLAYERS) { toast('至少要 ' + MIN_PLAYERS + ' 人才能開始'); return; }
  const havePairs = ps.filter(p => (H.queues[p.id] || []).length > 0);
  if (havePairs.length === 0) { toast('題庫還沒有任何題目'); return; }

  // Step 1: 抽出題者並消掉他題庫最前面的一題
  const setter = havePairs[rand(havePairs.length)];
  const pair = H.queues[setter.id].shift();

  // Step 2: 分角色——7 成參與者、3 成投票者，出題者固定在投票者
  // 上限壓成 N-2，保證至少 2 個投票者（出題者 + 至少 1 個能投的），小人數才玩得動
  const N = ps.length;
  const nPart = Math.min(Math.ceil(N * 0.7), N - 2);
  const others = shuffle(ps.filter(p => p.id !== setter.id));
  const partPlayers = others.slice(0, nPart);
  const voterPlayers = [setter, ...others.slice(nPart)];

  // Step 3: 參與者中抽臥底
  const nSpy = spyCount(nPart);
  const parts = shuffle(partPlayers).map((p, i) => ({
    id: p.id, name: p.name, alive: true, isSpy: i < nSpy, perfReady: false, ended: false,
  }));

  H.roundNum++;
  H.round = {
    num: H.roundNum, contentMode: H.contentMode, voteMode: H.voteMode,
    setterId: setter.id, setterName: setter.name, pair,
    participants: shuffle(parts),
    voterIds: voterPlayers.map(p => p.id),
    stage: 'waitReady',
    votes: {}, candidateIds: null, revoting: false, result: null, replay: null,
  };
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
    checkAllEnded();
  }, 3000);
}

function checkAllEnded() {
  const r = H.round;
  if (r == null || r.stage !== 'playing') return;
  if (r.participants.every(q => q.ended) === false) return;
  r.stage = 'discuss';
  broadcast();
}

// 房主：討論階段強制推進到看題結束（音樂會在客戶端停播）
function hostForceDiscuss() {
  const r = H.round;
  if (r == null || (r.stage !== 'playing' && r.stage !== 'countdown' && r.stage !== 'waitReady')) return;
  r.stage = 'discuss';
  broadcast();
}

// 房主：確認討論完成 → 進入投票
function hostConfirmDiscuss() {
  const r = H.round;
  if (r == null || r.stage !== 'discuss') return;
  r.votes = {}; r.candidateIds = null; r.revoting = false;
  r.stage = 'vote';
  broadcast();
}

// ===== 投票 =====
function eligibleVoterIds(r) {
  return r.voterIds.filter(id => id !== r.setterId && isConnected(id));
}
function candidateIds(r) {
  return r.candidateIds || r.participants.filter(p => p.alive).map(p => p.id);
}

function hostVote(pid, target) {
  const r = H.round;
  if (r == null || r.stage !== 'vote') return;
  if (eligibleVoterIds(r).includes(pid) === false) return;
  if (candidateIds(r).includes(target) === false) return;
  r.votes[pid] = target;
  if (eligibleVoterIds(r).every(id => r.votes[id] != null)) doTally(r);
}

function hostForceTally() {
  const r = H.round;
  if (r == null || r.stage !== 'vote') return;
  doTally(r, true); // 房主強制結算：不等未投的人，平票也直接判定不再重投
}

function doTally(r, forced) {
  const cands = candidateIds(r);
  const counts = {};
  for (const t of Object.values(r.votes)) counts[t] = (counts[t] || 0) + 1;
  let max = 0, tops = [];
  for (const id of cands) {
    const c = counts[id] || 0;
    if (c > max) { max = c; tops = [id]; }
    else if (c === max && max > 0) tops.push(id);
  }
  if (max === 0) tops = cands.slice(); // 沒人投 → 視為平票

  if (tops.length === 1) { applyKill(r, tops[0]); return; }
  // 平票：已經是重投、或房主強制結算 → 這輪不殺，不再回頭等投票
  if (r.revoting || forced) { applyNoKill(r); return; }
  // Step: 最高票的人重新投一次
  r.revoting = true;
  r.candidateIds = tops;
  r.votes = {};
  r.stage = 'vote';
}

function applyKill(r, pid) {
  const p = r.participants.find(x => x.id === pid);
  p.alive = false;
  r.result = { killedName: p.name, wasSpy: p.isSpy, noKill: false };
  finishVote(r);
}
function applyNoKill(r) {
  r.result = { killedName: null, wasSpy: false, noKill: true };
  finishVote(r);
}
function finishVote(r) {
  r.result.outcome = resolveOutcome(r);
  r.revoting = false;
  r.stage = 'result';
}
// 多次表決才會循環；單次表決一律結束
function resolveOutcome(r) {
  if (r.voteMode === 'single') return 'end';
  const alive = r.participants.filter(p => p.alive);
  const spy = alive.filter(p => p.isSpy).length;
  const civ = alive.length - spy;
  if (spy === 0) return 'civWin';
  if (spy >= civ) return 'spyWin';
  return 'continue';
}

// 房主：看完投票結果後推進
function hostAfterResult() {
  const r = H.round;
  if (r == null || r.stage !== 'result') return;
  if (r.result.outcome === 'continue') {
    r.votes = {}; r.candidateIds = null; r.revoting = false; r.result = null;
    r.stage = 'discuss';
  } else {
    r.stage = 'reveal';
  }
  broadcast();
}

function hostReplay(pid) {
  if (H.round == null) return;
  H.round.replay = { seq: ++H.replaySeq, pid };
  broadcast();
}

function hostNextRound() {
  H.round = null; // 題庫不清，出題者的那題已在開局時消掉
  broadcast();
}

// ===== 狀態裁切（依身分，不外洩臥底/別人的詞）=====
function sideView(side) {
  if (H.contentMode === 'word') return { word: side.word };
  return { title: side.song.title, artist: side.song.artist, art: side.song.art, url: side.song.url, hint: side.hint };
}
function assignedContent(r, pid) {
  const p = r.participants.find(x => x.id === pid);
  if (p == null) return null;
  return sideView(p.isSpy ? r.pair.spy : r.pair.civ);
}

function roundView(pid) {
  const r = H.round;
  if (r == null) return null;
  const meP = r.participants.find(p => p.id === pid);
  const amSetter = pid === r.setterId;
  const amVoter = r.voterIds.includes(pid);
  let myRole = 'watch';
  if (meP) myRole = meP.alive ? 'participant' : 'deadParticipant';
  else if (amSetter) myRole = 'setter';
  else if (amVoter) myRole = 'voter';

  const elig = eligibleVoterIds(r);
  const reveal = r.stage === 'reveal';
  const showVotes = r.stage === 'vote' || r.stage === 'result' || reveal;

  return {
    num: r.num, stage: r.stage, contentMode: r.contentMode, voteMode: r.voteMode,
    myRole,
    myContent: meP ? assignedContent(r, pid) : null,
    setterName: r.setterName,
    setterAnswer: amSetter ? { civ: sideView(r.pair.civ), spy: sideView(r.pair.spy) } : null,
    participants: r.participants.map(p => ({
      id: p.id, name: p.name, alive: p.alive, perfReady: p.perfReady, ended: p.ended,
      isSpy: reveal ? p.isSpy : undefined,
      content: reveal ? assignedContent(r, p.id) : undefined,
    })),
    voters: r.voterIds.map(id => ({
      name: (H.players.find(p => p.id === id) || {}).name,
      isSetter: id === r.setterId,
    })),
    candidateIds: candidateIds(r),
    revoting: r.revoting,
    iCanVote: r.stage === 'vote' && elig.includes(pid),
    myVote: r.votes[pid] || null,
    votesPublic: showVotes ? elig.map(id => ({
      voterName: (H.players.find(p => p.id === id) || {}).name,
      targetName: r.votes[id] ? (r.participants.find(p => p.id === r.votes[id]) || {}).name : null,
    })) : null,
    result: (r.stage === 'result' || reveal) ? r.result : null,
    replay: r.replay == null ? null : {
      seq: r.replay.seq,
      name: (H.players.find(p => p.id === r.replay.pid) || {}).name,
      content: assignedContent(r, r.replay.pid),
    },
  };
}

function stateFor(pid) {
  return {
    code: roomCode, youId: pid, isHost: pid === 'HOST',
    phase: H.phase, contentMode: H.contentMode, voteMode: H.voteMode, minPlayers: MIN_PLAYERS,
    players: H.players.map(p => ({
      id: p.id, name: p.name, ready: p.ready, connected: p.connected,
      isHost: p.isHost, queueLen: (H.queues[p.id] || []).length,
    })),
    myQueue: (H.queues[pid] || []).map(q => ({ id: q.id, civ: sideView(q.civ), spy: sideView(q.spy) })),
    round: roundView(pid),
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

function onState() { render(lastState); effects(lastState); }

function effects(s) {
  const r = s.round;
  const key = r ? (r.num + ':' + r.stage) : 'none';
  if (key !== prevStageKey) {
    prevStageKey = key;
    if (r && r.stage === 'countdown') startCountdown(r);
    else if (r == null || ['waitReady', 'discuss', 'vote', 'result', 'reveal'].includes(r.stage)) {
      stopAudio(); hideCountdown();
    }
  }
  // 複盤：所有裝置一起播出該參加者的歌（單詞模式只顯示、不播音）
  if (r && r.replay && r.replay.seq > playedReplaySeq) {
    playedReplaySeq = r.replay.seq;
    if (r.replay.content && r.replay.content.url) playUrl(r.replay.content.url, null);
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
    if (r.myRole === 'participant' && r.myContent && r.myContent.url) {
      playUrl(r.myContent.url, () => send({ t: 'ended' }));
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
  $('#btnAddPair').onclick = addPair;
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

// 參與者自己的詞/歌
function myContentCard(c, mode) {
  if (mode === 'word') {
    return `<div class="card stageBig"><p class="dim">🤫 你的詞（只有你看得到）</p><div class="bigWord">${esc(c.word)}</div></div>`;
  }
  return `<div class="card"><h2>🤫 你的歌（只有你看得到）</h2>${songRow(c)}
    ${c.hint ? `<p class="dim" style="margin-top:8px">💡 提示：${esc(c.hint)}</p>` : ''}
    <div class="eq"><i></i><i></i><i></i><i></i><i></i></div></div>`;
}

function answerBox(ans, mode) {
  const one = x => mode === 'word' ? esc(x.word) : esc(x.title);
  return `<div class="answerBox"><div>平民<br>${one(ans.civ)}</div><div>臥底<br>${one(ans.spy)}</div></div>`;
}

// 投票者 / 出題者的說明卡（#8）
function voterInfoCard(r) {
  if (r.myRole === 'setter') {
    return `<div class="card"><h2>🎬 你是出題者</h2>
      <p class="dim">你出的題目正在被玩，這回合<b>不能投票</b>。請幫忙主持討論、不要暴雷。</p>
      ${answerBox(r.setterAnswer, r.contentMode)}</div>`;
  }
  return `<div class="card"><h2>🗳️ 你是投票者</h2>
    <p class="dim">仔細聽 / 看參與者的描述，和大家<b>討論、鎖定臥底</b>，稍後由你們投票把臥底揪出來。</p></div>`;
}

function partStatusCard(r, kind) {
  const rows = r.participants.map(p => {
    let right = '';
    if (kind === 'ready') right = p.perfReady ? '✅ 已準備' : '⏳ 等待中';
    else if (kind === 'done') right = p.ended ? '👌 好了' : '⌛ 進行中';
    else right = p.alive ? '🙂 存活' : '💀 出局';
    return `<div class="readyRow ${p.alive ? '' : 'dead'}"><span>${esc(p.name)}</span><span>${right}</span></div>`;
  }).join('');
  return `<div class="card"><h2>參與者</h2>${rows}</div>`;
}

function voteBoardCard(r) {
  if (r.votesPublic == null) return '';
  const rows = r.votesPublic.map(v =>
    `<div class="readyRow"><span>${esc(v.voterName)}</span><span>${v.targetName ? '➡️ ' + esc(v.targetName) : '⏳ 未投'}</span></div>`).join('');
  return `<div class="card"><h2>🗳️ 投票情況（公開）</h2>${rows}</div>`;
}

function render(s) {
  if (s == null) return;
  ensurePanels(s.contentMode);
  $('#btnPause').classList.toggle('hidden', s.contentMode !== 'song');

  const r = s.round;
  // 參與者整回合不能編題庫（在台上）
  const locked = r != null && (r.myRole === 'participant' || r.myRole === 'deadParticipant');
  $('#tabSong').disabled = locked;
  if (locked) switchTab(true);

  if (s.phase === 'lobby') return renderLobby(s);
  if (r == null) return renderBetween(s);
  return renderRound(s);
}

function renderLobby(s) {
  const v = $('#viewStage');
  const me = s.players.find(p => p.id === s.youId) || {};
  const allReady = s.players.filter(p => p.connected).every(p => p.ready);
  const modeTxt = (s.contentMode === 'word' ? '✏️ 單詞' : '🎵 歌曲') + '｜' + (s.voteMode === 'single' ? '單次表決' : '多次表決');
  v.innerHTML = `
    <div class="card">
      <h2>🛋️ 大廳</h2>
      <p class="dim">玩法：${modeTxt}<br>把房號 <b>${esc(s.code)}</b> 給朋友，同一網頁輸入就能加入。<br>可以先去「📝 題庫」分頁把題目準備好。</p>
      <div class="pList">${s.players.map(p =>
        `<span class="pTag ${p.connected ? '' : 'off'}">${p.isHost ? '👑' : ''}${esc(p.name)}<span class="badge">${p.ready ? '✅' : '💤'}</span></span>`).join('')}
      </div>
    </div>
    <button id="btnLobbyReady" class="btn big ${me.ready ? 'ghost' : ''}">${me.ready ? '取消準備' : '✋ 我準備好了'}</button>
    ${s.isHost ? `<button id="btnStartGame" class="btn big" ${allReady && s.players.length >= 2 ? '' : 'disabled'} style="margin-top:10px">🚀 開始遊戲</button>` : ''}
  `;
  $('#btnLobbyReady').onclick = () => send({ t: 'lobbyReady', v: me.ready === false });
  if (s.isHost) $('#btnStartGame').onclick = hostStartGame;
}

function renderBetween(s) {
  const v = $('#viewStage');
  const ps = s.players.filter(p => p.connected);
  const withPairs = ps.filter(p => p.queueLen > 0);
  const totalPairs = ps.reduce((a, p) => a + p.queueLen, 0);
  const canStart = ps.length >= s.minPlayers && withPairs.length > 0;
  v.innerHTML = `
    <div class="card">
      <h2>🎲 準備開始回合</h2>
      <p class="dim">目前 <b>${ps.length}</b> 人（最少 ${s.minPlayers} 人）｜題庫共 <b>${totalPairs}</b> 題<br>把房號 <b>${esc(s.code)}</b> 給朋友加入；到「📝 題庫」加題，每回合自動消一題。</p>
      <div class="pList">${s.players.map(p =>
        `<span class="pTag ${p.connected ? '' : 'off'}">${p.isHost ? '👑' : ''}${esc(p.name)}<span class="badge">${p.queueLen > 0 ? '📝' + p.queueLen : ''}</span></span>`).join('')}
      </div>
    </div>
    ${s.isHost ? `<button id="btnStartRound" class="btn big" ${canStart ? '' : 'disabled'}>🎬 開始本回合</button>
      ${canStart ? '' : `<p class="dim" style="text-align:center;margin-top:8px">${ps.length < s.minPlayers ? '等更多人加入…' : '題庫還是空的，先去加題'}</p>`}` : `<p class="dim" style="text-align:center;margin-top:8px">等房主開始本回合…</p>`}
  `;
  if (s.isHost) { const b = $('#btnStartRound'); if (b) b.onclick = hostStartRound; }
}

function renderRound(s) {
  const v = $('#viewStage');
  const r = s.round;
  const mode = r.contentMode;
  let html = `<div class="card"><h2>第 ${r.num} 回合</h2>
    <p class="dim">參與者 ${r.participants.length} 人／投票者 ${r.voters.length} 人（含出題者 ${esc(r.setterName)}）</p>
    <span class="roleBadge">你的身分：${roleLabel(r.myRole)}</span></div>`;

  // ---- 準備看題 ----
  if (r.stage === 'waitReady') {
    if (r.myRole === 'participant') {
      const meRow = r.participants.find(p => p.id === s.youId);
      html += `<div class="card"><h2>${mode === 'word' ? '✋ 準備看你的詞' : '🎧 戴耳機準備聽'}</h2>
        <p class="dim">${mode === 'word' ? '全員按準備後倒數 3 秒同時亮出你的詞。' : '全員按準備後倒數 3 秒同時播放。'}</p></div>`;
      html += partStatusCard(r, 'ready');
      html += meRow.perfReady
        ? `<div class="card stageBig"><span class="emoji">🕰️</span>等其他人按準備…</div>`
        : `<button id="btnPerfReady" class="btn big">${mode === 'word' ? '✋ 準備好了！' : '🎧 耳機戴好了，準備！'}</button>`;
    } else {
      html += voterInfoCard(r) + partStatusCard(r, 'ready');
    }
    if (s.isHost) html += `<button id="btnForceStart" class="btn big ghost" style="margin-top:10px">⏭ 有人卡住，直接開始</button>`;
  }
  // ---- 看題 / 播放 ----
  else if (r.stage === 'countdown' || r.stage === 'playing') {
    if (r.myRole === 'participant') {
      const meRow = r.participants.find(p => p.id === s.youId);
      html += myContentCard(r.myContent, mode);
      html += partStatusCard(r, 'done');
      if (mode === 'word' && meRow.ended === false) html += `<button id="btnSeen" class="btn big">👌 看好了</button>`;
    } else {
      html += voterInfoCard(r);
      html += mode === 'word'
        ? `<div class="card stageBig"><span class="emoji">👀</span><h2>參與者看詞中…</h2></div>`
        : `<div class="card stageBig"><span class="emoji">🎶</span><h2>參與者聽歌中…</h2><div class="eq"><i></i><i></i><i></i><i></i><i></i></div></div>`;
      html += partStatusCard(r, 'done');
    }
    if (s.isHost && r.stage === 'playing') html += `<button id="btnForceDiscuss" class="btn big ghost" style="margin-top:10px">⏭ 有裝置沒反應，直接進討論</button>`;
  }
  // ---- 討論 ----
  else if (r.stage === 'discuss') {
    html += `<div class="card stageBig"><span class="emoji">💬</span><h2>討論時間</h2></div>`;
    if (r.myRole === 'participant') html += myContentCard(r.myContent, mode);
    else html += voterInfoCard(r);
    html += partStatusCard(r, 'alive');
    if (s.isHost) {
      if (mode === 'song') {
        html += `<div class="card"><h2>🔁 複盤（所有人會聽到）</h2>${r.participants.map(p =>
          `<div class="readyRow ${p.alive ? '' : 'dead'}"><span>${esc(p.name)}</span><button class="btn mini btnReplay" data-id="${p.id}" data-name="${esc(p.name)}">🔁</button></div>`).join('')}</div>`;
      }
      html += `<button id="btnConfirmDiscuss" class="btn big">✅ 討論完成，進入投票</button>`;
    }
    if (r.replay) html += replayCard(r, mode);
  }
  // ---- 投票 ----
  else if (r.stage === 'vote') {
    if (r.revoting) html += `<div class="card"><h2>⚖️ 平票！最高票重投</h2><p class="dim">只能從下面平票的人裡面選。再平票就這輪不殺。</p></div>`;
    if (r.iCanVote) {
      const cands = r.participants.filter(p => r.candidateIds.includes(p.id));
      html += `<div class="card"><h2>🗳️ 投出你認為的臥底</h2>${cands.map(p =>
        `<button class="btn voteBtn btnVote ${r.myVote === p.id ? 'mine' : ''}" data-id="${p.id}">${r.myVote === p.id ? '✅ ' : ''}${esc(p.name)}</button>`).join('')}
        <p class="dim">投完可改，等所有投票者投完自動結算。</p></div>`;
    } else {
      const why = r.myRole === 'setter' ? '你是出題者，不投票。'
        : (r.myRole === 'participant' || r.myRole === 'deadParticipant') ? '你是參與者，等投票者決定。' : '';
      html += `<div class="card stageBig"><span class="emoji">🗳️</span><h2>投票進行中</h2><p class="dim">${why}</p></div>`;
    }
    html += voteBoardCard(r);
    if (s.isHost) html += `<button id="btnForceTally" class="btn big ghost" style="margin-top:10px">⏭ 直接結算</button>`;
  }
  // ---- 投票結果 ----
  else if (r.stage === 'result') {
    html += resultCard(r);
    html += voteBoardCard(r);
    if (s.isHost) {
      html += r.result.outcome === 'continue'
        ? `<button id="btnAfterResult" class="btn big">➡️ 進入下一輪討論</button>`
        : `<button id="btnAfterResult" class="btn big">📜 公布所有詞條</button>`;
    }
  }
  // ---- 公布詞條 ----
  else if (r.stage === 'reveal') {
    html += resultCard(r);
    html += `<div class="card"><h2>📜 所有人的詞條</h2>${r.participants.map(p => {
      const c = p.content;
      const txt = mode === 'word' ? esc(c.word) : esc(c.title) + '<span class="dim"> / ' + esc(c.artist) + '</span>';
      return `<div class="readyRow ${p.alive ? '' : 'dead'}"><span>${p.isSpy ? '🕵️ ' : '😇 '}${esc(p.name)}</span><span>${txt}</span></div>`;
    }).join('')}</div>`;
    if (s.isHost) html += `<button id="btnNextRound" class="btn big">➡️ 進入下一回合</button>`;
  }

  v.innerHTML = html;
  bindRoundButtons(r, mode);
}

function roleLabel(role) {
  return { participant: '🎭 參與者', deadParticipant: '💀 已出局', voter: '🗳️ 投票者', setter: '🎬 出題者', watch: '👀 旁觀' }[role] || role;
}

function replayCard(r, mode) {
  const c = r.replay.content;
  return mode === 'word'
    ? `<div class="card"><h2>🔁 複盤中</h2><div class="bigWord">${esc(c.word)}</div><p class="dim">這是 <b>${esc(r.replay.name)}</b> 拿到的詞</p></div>`
    : `<div class="card"><h2>🔁 複盤中</h2>${songRow(c)}<p class="dim" style="margin-top:8px">這是 <b>${esc(r.replay.name)}</b> 聽到的歌</p></div>`;
}

function resultCard(r) {
  const res = r.result;
  let line;
  if (res.noKill) line = '⚖️ 平票，這輪沒有人出局';
  else line = `💀 ${esc(res.killedName)} 被投出局，他${res.wasSpy ? '<b>是臥底！</b>' : '不是臥底 😮'}`;
  const outcome = { civWin: '🎉 臥底全部被抓出來，平民獲勝！', spyWin: '🕵️ 臥底存活數追上平民，臥底獲勝！', end: '本回合結束', continue: '遊戲繼續' }[res.outcome];
  return `<div class="card"><h2>投票結果</h2><div class="big-result">${line}</div><p class="dim" style="text-align:center">${outcome}</p></div>`;
}

function bindRoundButtons(r, mode) {
  const bp = $('#btnPerfReady'); if (bp) bp.onclick = () => send({ t: 'perfReady' });
  const bs = $('#btnSeen'); if (bs) bs.onclick = () => send({ t: 'ended' });
  const bf = $('#btnForceStart'); if (bf) bf.onclick = () => confirmBox('還有參加者沒按準備，確定直接開始倒數嗎？', beginCountdown);
  const bd = $('#btnForceDiscuss'); if (bd) bd.onclick = () => confirmBox('確定不等回報、直接進入討論嗎？（會停止播放）', () => { stopAudio(); hostForceDiscuss(); });
  const bc = $('#btnConfirmDiscuss'); if (bc) bc.onclick = () => confirmBox('確定討論完成、進入投票嗎？', hostConfirmDiscuss);
  const bt = $('#btnForceTally'); if (bt) bt.onclick = () => confirmBox('確定不等所有人、直接結算投票嗎？', hostForceTally);
  const ba = $('#btnAfterResult'); if (ba) ba.onclick = hostAfterResult;
  const bn = $('#btnNextRound'); if (bn) bn.onclick = () => confirmBox('確定進入下一回合嗎？', hostNextRound);
  document.querySelectorAll('.btnVote').forEach(b => b.onclick = () => send({ t: 'vote', target: b.dataset.id }));
  // #5：複盤按鈕加確認，避免不小心讓大家看到/聽到答案
  document.querySelectorAll('.btnReplay').forEach(b => b.onclick = () =>
    confirmBox('確定複盤 ' + b.dataset.name + ' 的題目嗎？所有人都會看到/聽到。', () => hostReplay(b.dataset.id)));
}

// ===== 題庫（出題）面板 =====
const pending = { civ: { song: null, hint: '', word: '' }, spy: { song: null, hint: '', word: '' } };
let panelsMode = null;

function ensurePanels(mode) {
  if (panelsMode === mode) { renderQueue(); return; }
  panelsMode = mode;
  $('#tabSong').textContent = '📝 題庫';
  $('#tipCard').innerHTML = mode === 'word'
    ? '兩邊各填一個有關聯的詞（平民 / 臥底），不能一樣。按「加入題庫」可累積多題，之後每回合自動消一題。'
    : '兩邊各選一首互相有關的歌（平民 / 臥底），不能同一首。按「加入題庫」可累積多題，之後每回合自動消一題。';
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
      <input class="pHint" placeholder="提示（讓上台的人快速知道這是什麼歌）">`;
    const doSearch = async () => {
      const term = el.querySelector('.pSearch').value.trim();
      if (term === '') return;
      el.querySelector('.pResults').innerHTML = '<p class="dim">搜尋中…</p>';
      try { renderResults(el, side, await itunesSearch(term)); }
      catch (e) {
        const why = e.message === 'rate' ? '被 Apple 限流'
          : e.name === 'AbortError' ? '連線逾時（10 秒）'
          : (e.message || e.name || '未知錯誤');
        el.querySelector('.pResults').innerHTML = `<p class="dim">搜尋失敗（${esc(why)}），等幾秒再按一次搜尋。</p>`;
      }
    };
    el.querySelector('.pGo').onclick = doSearch;
    el.querySelector('.pSearch').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
    el.querySelector('.pHint').oninput = e => { pending[side].hint = e.target.value; };
  }
  clearPendingUI();
  renderQueue();
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
    buttons: `<button class="btn mini ghost tryBtn" data-url="${esc(sg.url)}">▶</button><button class="btn mini bPick" data-i="${i}">選</button>`,
  })).join('');
  box.querySelectorAll('.tryBtn').forEach(b => b.onclick = () => togglePreview(b.dataset.url));
  box.querySelectorAll('.bPick').forEach(b => b.onclick = () => {
    pending[side].song = songs[+b.dataset.i];
    stopAudio(); box.innerHTML = ''; renderSelected(el, side);
  });
  updatePreviewBtns();
}

function renderSelected(el, side) {
  const sg = pending[side].song;
  el.querySelector('.pSel').innerHTML = sg == null ? '' :
    songRow(sg, { sel: true, buttons: `<button class="btn mini ghost tryBtn" data-url="${esc(sg.url)}">▶</button>` });
  const b = el.querySelector('.tryBtn');
  if (b) b.onclick = () => togglePreview(sg.url);
  const hint = el.querySelector('.pHint'); if (hint) hint.value = pending[side].hint;
  updatePreviewBtns();
}

function clearPendingUI() {
  pending.civ = { song: null, hint: '', word: '' };
  pending.spy = { song: null, hint: '', word: '' };
  for (const el of document.querySelectorAll('.panel')) {
    if (panelsMode === 'word') { const w = el.querySelector('.pWord'); if (w) w.value = ''; }
    else { const box = el.querySelector('.pResults'); if (box) box.innerHTML = ''; renderSelected(el, el.dataset.side); }
  }
}

function sameSong(a, b) { return a && b && a.title === b.title && a.artist === b.artist; }

function addPair() {
  const q = (lastState && lastState.myQueue) || [];
  if (panelsMode === 'word') {
    const c = pending.civ.word.trim(), s = pending.spy.word.trim();
    if (c === '' || s === '') { toast('兩邊都要填一個詞'); return; }
    if (c === s) { toast('平民和臥底不能是同一個詞'); return; }
    if (q.some(x => x.civ.word === c && x.spy.word === s)) { toast('題庫已經有一模一樣的了'); return; }
  } else {
    if (pending.civ.song == null || pending.spy.song == null) { toast('兩邊都要選一首歌'); return; }
    if (sameSong(pending.civ.song, pending.spy.song)) { toast('平民和臥底不能是同一首歌'); return; }
    if (q.some(x => sameSong(x.civ, pending.civ.song) && sameSong(x.spy, pending.spy.song))) { toast('題庫已經有一模一樣的了'); return; }
  }
  send({ t: 'queueAdd', pair: JSON.parse(JSON.stringify(pending)) });
  clearPendingUI();
  toast('已加入題庫 ✅');
}

function renderQueue() {
  const box = $('#queueList');
  if (box == null) return;
  const q = (lastState && lastState.myQueue) || [];
  if (q.length === 0) { box.innerHTML = '<p class="dim">還沒有題目，上面編好一組後按「加入題庫」。</p>'; return; }
  const one = (side) => panelsMode === 'word' ? esc(side.word) : esc(side.title);
  box.innerHTML = q.map(item =>
    `<div class="qItem"><div class="qtxt">平民：<b>${one(item.civ)}</b>　臥底：<b>${one(item.spy)}</b></div>
      <button class="btn mini ghost qDel" data-id="${item.id}">🗑</button></div>`).join('');
  box.querySelectorAll('.qDel').forEach(b => b.onclick = () => send({ t: 'queueRemove', id: +b.dataset.id }));
}

// ===== 首頁事件 =====
let createContent = 'song', createVote = 'multi';
$('#modeSong').onclick = () => { createContent = 'song'; $('#modeSong').classList.add('on'); $('#modeWord').classList.remove('on'); };
$('#modeWord').onclick = () => { createContent = 'word'; $('#modeWord').classList.add('on'); $('#modeSong').classList.remove('on'); };
$('#voteMulti').onclick = () => { createVote = 'multi'; $('#voteMulti').classList.add('on'); $('#voteSingle').classList.remove('on'); };
$('#voteSingle').onclick = () => { createVote = 'single'; $('#voteSingle').classList.add('on'); $('#voteMulti').classList.remove('on'); };

$('#btnCreate').onclick = () => {
  const name = $('#inName').value.trim();
  if (name === '') { toast('先輸入暱稱'); return; }
  createRoom(name, createContent, createVote);
};
$('#btnJoin').onclick = () => {
  const name = $('#inName').value.trim();
  const code = $('#inCode').value.trim().toUpperCase();
  if (name === '') { toast('先輸入暱稱'); return; }
  if (code.length !== 4) { toast('房號是 4 碼'); return; }
  joinRoom(name, code);
};
