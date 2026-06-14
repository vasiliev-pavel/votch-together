/* ===========================================================================
   Votch Together — синхронный просмотр видео без сервера.
   Синхронизация: PeerJS (WebRTC data channel). Хост — источник истины по
   времени; play/pause/seek может инициировать любой из двоих.
   =========================================================================== */

const $ = (sel) => document.querySelector(sel);

const els = {
  url:       $('#url'),
  load:      $('#load'),
  share:     $('#share'),
  copy:      $('#copy'),
  status:    $('#status'),
  roleHint:  $('#role-hint'),
  wrap:      $('#player-wrap'),
  shareScreen: $('#share-screen'),
  screenStatus: $('#screen-status'),
  chatLog:   $('#chat-log'),
  chatInput: $('#chat-input'),
  chatSend:  $('#chat-send'),
};

/* ----------------------------- состояние --------------------------------- */
let peer = null;
let conn = null;
let isHost = true;
let roomId = null;
let myId = null;
let remotePeerId = null;    // id собеседника — нужен для медиа-звонка

// Демонстрация экрана
let localScreen = null;     // MediaStream того, кто транслирует
let mediaCall = null;       // исходящий звонок (мы транслируем)
let incomingCall = null;    // входящий звонок (нам транслируют)
let sharing = false;

let controller = null;     // активный плеер (YouTube или файл)
let currentSrc = null;     // {type:'youtube', id} | {type:'file', url}
let applyingRemote = false; // подавляем эхо при применении удалённой команды

/* ------------------------------- статус ---------------------------------- */
function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = 'tag' + (kind ? ' ' + kind : '');
}

/* ============================ YouTube IFrame API ========================== */
let ytReady = false;
const ytQueue = [];
window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  ytQueue.forEach((fn) => fn());
  ytQueue.length = 0;
};
function whenYT(fn) { ytReady ? fn() : ytQueue.push(fn); }

/* ============================ Парсинг ссылки ============================== */
function parseUrl(raw) {
  const url = (raw || '').trim();
  if (!url) return null;
  const yt = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|live\/|shorts\/)|youtu\.be\/)([\w-]{11})/
  );
  if (yt) return { type: 'youtube', id: yt[1] };
  return { type: 'file', url };
}

/* =============================== Плееры =================================== */
function clearPlayer() {
  if (controller) { try { controller.destroy(); } catch (_) {} controller = null; }
  els.wrap.innerHTML = '';
}

function showPlaceholder(html) {
  clearPlayer();
  els.wrap.innerHTML =
    '<div class="placeholder"><div class="placeholder-emoji">📺</div><p>' + html + '</p></div>';
}

// Вернуть сцену к видео по ссылке (или к заглушке) после завершения трансляции.
function restoreStage() {
  if (currentSrc) setSource(currentSrc, { time: 0, playing: false });
  else showPlaceholder('Трансляция завершена.');
}

function loadYouTube(id, startTime = 0, playing = false) {
  whenYT(() => {
    clearPlayer();
    const div = document.createElement('div');
    els.wrap.appendChild(div);

    let lastTime = startTime;
    let poll = null;

    const player = new YT.Player(div, {
      width: '100%',
      height: '100%',
      videoId: id,
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1, start: Math.floor(startTime) },
      events: {
        onReady: (e) => {
          if (startTime > 0) e.target.seekTo(startTime, true);
          if (playing) e.target.playVideo();
          lastTime = e.target.getCurrentTime() || startTime;
          poll = setInterval(seekWatch, 500);
        },
        onStateChange: (e) => {
          if (applyingRemote) return;
          if (e.data === YT.PlayerState.PLAYING) broadcast('play', player.getCurrentTime());
          else if (e.data === YT.PlayerState.PAUSED) broadcast('pause', player.getCurrentTime());
        },
      },
    });

    // У YouTube нет события "seeked" — отслеживаем скачок времени вручную.
    function seekWatch() {
      const now = player.getCurrentTime();
      const playingNow = player.getPlayerState() === YT.PlayerState.PLAYING;
      if (applyingRemote) { lastTime = now; return; }
      const expected = lastTime + (playingNow ? 0.5 : 0);
      if (Math.abs(now - expected) > 1.5) broadcast('seek', now);
      lastTime = now;
    }

    controller = {
      type: 'youtube',
      getTime: () => player.getCurrentTime() || 0,
      isPlaying: () => player.getPlayerState() === YT.PlayerState.PLAYING,
      play: () => player.playVideo(),
      pause: () => player.pauseVideo(),
      seek: (t) => { player.seekTo(t, true); lastTime = t; },
      destroy: () => { if (poll) clearInterval(poll); player.destroy(); },
    };
  });
}

function loadFile(url, startTime = 0, playing = false) {
  clearPlayer();
  const v = document.createElement('video');
  v.src = url;
  v.controls = true;
  v.playsInline = true;
  els.wrap.appendChild(v);

  v.addEventListener('loadedmetadata', () => {
    if (startTime > 0) v.currentTime = startTime;
    if (playing) v.play().catch(() => {});
  });
  v.addEventListener('play',   () => { if (!applyingRemote) broadcast('play',  v.currentTime); });
  v.addEventListener('pause',  () => { if (!applyingRemote) broadcast('pause', v.currentTime); });
  v.addEventListener('seeked', () => { if (!applyingRemote) broadcast('seek',  v.currentTime); });
  v.addEventListener('error',  () => setStatus('Не удалось загрузить видео', 'err'));

  controller = {
    type: 'file',
    getTime: () => v.currentTime || 0,
    isPlaying: () => !v.paused,
    play: () => v.play().catch(() => {}),
    pause: () => v.pause(),
    seek: (t) => { v.currentTime = t; },
    destroy: () => { v.pause(); v.remove(); },
  };
}

function setSource(src, opts = {}) {
  currentSrc = src;
  if (src.type === 'youtube') loadYouTube(src.id, opts.time || 0, !!opts.playing);
  else loadFile(src.url, opts.time || 0, !!opts.playing);
}

/* ===================== Применение удалённых команд ======================= */
function withRemote(fn) {
  applyingRemote = true;
  try { fn(); } finally { setTimeout(() => { applyingRemote = false; }, 250); }
}

function applyRemote(type, time) {
  if (!controller) return;
  withRemote(() => {
    if (type === 'play')      { controller.seek(time); controller.play(); }
    else if (type === 'pause'){ controller.pause();    controller.seek(time); }
    else if (type === 'seek') { controller.seek(time); }
  });
}

// Дрейф-коррекция от хоста (раз в несколько секунд).
function applyBeat(time, playing) {
  if (!controller) return;
  withRemote(() => {
    if (Math.abs(controller.getTime() - time) > 1.2) controller.seek(time);
    if (playing && !controller.isPlaying()) controller.play();
    if (!playing && controller.isPlaying()) controller.pause();
  });
}

/* ============================ Сеть (PeerJS) ============================== */
function send(obj) {
  if (conn && conn.open) conn.send(obj);
}

function broadcast(type, time) {
  send({ t: type, time });
}

function onData(msg) {
  switch (msg.t) {
    case 'req': // партнёр просит текущее состояние
      if (currentSrc) {
        send({
          t: 'state',
          src: currentSrc,
          time: controller ? controller.getTime() : 0,
          playing: controller ? controller.isPlaying() : false,
        });
      }
      break;
    case 'state':
      if (msg.src) setSource(msg.src, { time: msg.time, playing: msg.playing });
      break;
    case 'src':
      setSource(msg.src, { time: 0, playing: false });
      break;
    case 'play':
    case 'pause':
    case 'seek':
      applyRemote(msg.t, msg.time);
      break;
    case 'beat':
      if (!isHost) applyBeat(msg.time, msg.playing);
      break;
    case 'screen-start':
      setScreenStatus('Собеседник начинает трансляцию…');
      break;
    case 'screen-stop':
      setScreenStatus('');
      if (incomingCall) { try { incomingCall.close(); } catch (_) {} incomingCall = null; }
      restoreStage();
      break;
    case 'chat':
      addChat('them', msg.text);
      break;
  }
}

function setupConn(c) {
  conn = c;
  remotePeerId = c.peer;
  c.on('open', () => {
    setStatus('Подключено ✓', 'ok');
    addChat('sys', 'Собеседник присоединился');
    if (!isHost) c.send({ t: 'req' });       // гость просит состояние
    else if (currentSrc) {                    // хост сразу делится тем, что уже открыто
      send({ t: 'state', src: currentSrc,
             time: controller ? controller.getTime() : 0,
             playing: controller ? controller.isPlaying() : false });
    }
  });
  c.on('data', onData);
  c.on('close', () => { setStatus('Соединение закрыто', 'err'); addChat('sys', 'Собеседник отключился'); });
  c.on('error', () => setStatus('Ошибка соединения', 'err'));
}

function initPeer() {
  const hash = location.hash.slice(1);
  if (hash) { isHost = false; roomId = hash; }

  peer = new Peer();

  peer.on('open', (id) => {
    myId = id;
    if (isHost) {
      els.share.value = location.origin + location.pathname + '#' + id;
      els.roleHint.textContent = 'Ты — ведущий. Открой видео и отправь ссылку другу.';
      setStatus('Ожидание второго зрителя…', 'wait');
    } else {
      remotePeerId = roomId;
      els.share.value = location.href;
      els.roleHint.textContent = 'Ты подключаешься к комнате друга.';
      setStatus('Подключение к комнате…', 'wait');
      setupConn(peer.connect(roomId, { reliable: true }));
    }
  });

  // Хост получает входящее подключение гостя.
  peer.on('connection', (c) => setupConn(c));

  // Входящий медиа-звонок = собеседник транслирует экран.
  peer.on('call', (call) => {
    if (incomingCall) { try { incomingCall.close(); } catch (_) {} }
    incomingCall = call;
    call.answer(); // принимаем только на приём, свой поток не отправляем
    setScreenStatus('Собеседник транслирует экран');
    call.on('stream', (stream) => showRemoteStream(stream));
    call.on('close', () => { setScreenStatus(''); restoreStage(); incomingCall = null; });
  });

  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') setStatus('Комната не найдена или хост вышел', 'err');
    else setStatus('Ошибка сети: ' + err.type, 'err');
  });
}

// Хост раз в 4 с рассылает «маяк» времени для коррекции рассинхрона.
setInterval(() => {
  if (isHost && conn && conn.open && controller) {
    send({ t: 'beat', time: controller.getTime(), playing: controller.isPlaying() });
  }
}, 4000);

/* ========================= Демонстрация экрана =========================== */
function setScreenStatus(text) { els.screenStatus.textContent = text; }

function showStreamVideo(stream, muted) {
  clearPlayer();
  const v = document.createElement('video');
  v.srcObject = stream;
  v.autoplay = true;
  v.playsInline = true;
  v.muted = muted;            // свой превью — без звука, чтобы не было эха
  v.controls = !muted;        // зрителю даём громкость/полный экран
  els.wrap.appendChild(v);
  v.play().catch(() => {});
}

function showRemoteStream(stream) { showStreamVideo(stream, false); }

async function startScreenShare() {
  if (!remotePeerId) { setScreenStatus('Сначала дождитесь подключения друга'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    setScreenStatus('Браузер не поддерживает захват экрана'); return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (_) {
    setScreenStatus('Доступ к экрану не выдан'); return;
  }
  localScreen = stream;
  sharing = true;
  els.shareScreen.textContent = '⏹ Остановить трансляцию';
  els.shareScreen.classList.add('live');
  setScreenStatus('Вы транслируете экран');
  showStreamVideo(stream, true);                 // локальный превью
  mediaCall = peer.call(remotePeerId, stream);   // отправляем поток собеседнику
  send({ t: 'screen-start' });
  // Пользователь нажал «Прекратить доступ» в плашке браузера.
  stream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);
}

function stopScreenShare() {
  if (!sharing) return;
  sharing = false;
  els.shareScreen.textContent = '🖥 Поделиться экраном';
  els.shareScreen.classList.remove('live');
  setScreenStatus('');
  if (localScreen) { localScreen.getTracks().forEach((t) => t.stop()); localScreen = null; }
  if (mediaCall) { try { mediaCall.close(); } catch (_) {} mediaCall = null; }
  send({ t: 'screen-stop' });
  restoreStage();
}

/* =============================== Чат ===================================== */
function addChat(kind, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + (kind === 'me' ? 'me' : kind === 'them' ? 'them' : 'sys');
  if (kind === 'me' || kind === 'them') {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = kind === 'me' ? 'Вы' : 'Собеседник';
    div.appendChild(who);
    div.appendChild(document.createTextNode(text));
  } else {
    div.textContent = text;
  }
  els.chatLog.appendChild(div);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  addChat('me', text);
  send({ t: 'chat', text });
  els.chatInput.value = '';
}

/* ============================ Обработчики UI ============================== */
els.load.addEventListener('click', () => {
  const src = parseUrl(els.url.value);
  if (!src) { setStatus('Введите ссылку на видео', 'err'); return; }
  setSource(src, { time: 0, playing: false });
  send({ t: 'src', src });
});
els.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.load.click(); });

els.copy.addEventListener('click', async () => {
  if (!els.share.value) return;
  try { await navigator.clipboard.writeText(els.share.value); }
  catch (_) { els.share.select(); document.execCommand('copy'); }
  const old = els.copy.textContent;
  els.copy.textContent = 'Скопировано ✓';
  setTimeout(() => { els.copy.textContent = old; }, 1500);
});

els.shareScreen.addEventListener('click', () => { sharing ? stopScreenShare() : startScreenShare(); });

els.chatSend.addEventListener('click', sendChat);
els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

/* ================================ Старт ================================== */
initPeer();
