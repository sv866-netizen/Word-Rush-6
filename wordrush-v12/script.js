/* ═══════════════════════════════════════════════════════
   WordRush – client script (v9)
   ═══════════════════════════════════════════════════════ */

const socket = io({ transports: ["websocket","polling"] });

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  playerId: null,
  roomCode: null,
  roomState: null,
  currentGuess: [],
  isSpectator: false,
  muted: false,
  difficulty: "easy",
  selectedMode: "solo_race",
  timeLimit: 60,
  hintedLetters: {},        // position -> letter
  currentTimeRemaining: 60,
  currentTimeLimit: 60,
  gameReady: false,
  roundOverCountdown: null,
};

// ─── Sounds ───────────────────────────────────────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
function getCtx() {
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function playTone(freq, dur = 0.12, type = "sine", vol = 0.2) {
  if (state.muted) return;
  try {
    const ctx = getCtx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = type; o.frequency.setValueAtTime(freq, ctx.currentTime);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.start(); o.stop(ctx.currentTime + dur);
  } catch(e) {}
}
function sfxKey()    { playTone(440, 0.06, "square", 0.1); }
function sfxDelete() { playTone(330, 0.08, "square", 0.1); }
function sfxSubmit() { playTone(550, 0.12, "triangle", 0.15); }
function sfxWin()    { [523,659,784].forEach((f,i) => setTimeout(() => playTone(f, 0.2,"sine",0.2), i*120)); }
function sfxLoss()   { [330,262].forEach((f,i) => setTimeout(() => playTone(f,0.25,"sawtooth",0.15), i*150)); }
function sfxInvalid(){ playTone(200, 0.15, "sawtooth", 0.15); }

// ─── Background canvas ────────────────────────────────────────────────────────
(function initBgCanvas() {
  const canvas = document.getElementById("bg-canvas");
  const ctx = canvas.getContext("2d");
  let particles = [];
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  resize(); window.addEventListener("resize", resize);
  for (let i = 0; i < 60; i++) particles.push({
    x: Math.random() * innerWidth, y: Math.random() * innerHeight,
    r: Math.random() * 1.5 + 0.5, dx: (Math.random()-0.5)*0.3, dy: -Math.random()*0.4-0.1,
    a: Math.random(), hue: Math.floor(Math.random()*360),
  });
  (function draw() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    for (const p of particles) {
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle = `hsla(${p.hue},80%,70%,${p.a*0.3})`; ctx.fill();
      p.x += p.dx; p.y += p.dy; p.a -= 0.001;
      if (p.a <= 0 || p.y < -5) {
        p.x = Math.random()*canvas.width; p.y = canvas.height+5;
        p.a = Math.random()*0.5+0.2; p.hue = Math.floor(Math.random()*360);
      }
    }
    requestAnimationFrame(draw);
  })();
})();

// ─── Screens ──────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
}

// ─── Toasts ───────────────────────────────────────────────────────────────────
function showToast(msg, dur = 3000) {
  const wrap = document.getElementById("toasts");
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), dur);
}

// ─── Emoji picker ─────────────────────────────────────────────────────────────
const AVATARS = ["👾","🐱","🐶","🦊","🐸","🐺","🦁","🐯","🐻","🦄","🐙","🦋","🦅","🦖","🤖","👻","💀","🔥","⚡","🌈"];
function initEmojiPicker(containerId, hiddenId) {
  const c = document.getElementById(containerId);
  AVATARS.forEach(em => {
    const b = document.createElement("button"); b.type="button"; b.className="emoji-btn";
    b.textContent = em;
    b.onclick = () => {
      c.querySelectorAll(".emoji-btn").forEach(x => x.classList.remove("selected"));
      b.classList.add("selected");
      document.getElementById(hiddenId).value = em;
    };
    if (em === "👾") b.classList.add("selected");
    c.appendChild(b);
  });
}
initEmojiPicker("create-emoji-picker","create-emoji");
initEmojiPicker("join-emoji-picker","join-emoji");

// ─── Game modes ───────────────────────────────────────────────────────────────
const MODES = [
  { id:"solo_race", icon:"🏁", label:"Solo Race",  desc:"Everyone guesses at once" },
  { id:"relay",     icon:"🤝", label:"Relay",       desc:"Take turns guessing" },
  { id:"time_attack",icon:"⏱",label:"Time Attack", desc:"Race against the clock" },
  { id:"hint_mode", icon:"💡", label:"Hint Mode",   desc:"Buy hints with points" },
];
(function buildModePicker() {
  const el = document.getElementById("mode-picker");
  MODES.forEach((m,i) => {
    const b = document.createElement("button"); b.type="button"; b.className="mode-btn" + (i===0?" active":"");
    b.dataset.mode = m.id;
    b.innerHTML = `<span class="mb-icon">${m.icon}</span><span class="mb-label">${m.label}</span><span class="mb-desc">${m.desc}</span>`;
    b.onclick = () => {
      document.querySelectorAll("#mode-picker .mode-btn").forEach(x=>x.classList.remove("active"));
      b.classList.add("active");
      state.selectedMode = m.id;
      document.getElementById("create-mode").value = m.id;
      document.getElementById("time-limit-row").style.display = m.id === "time_attack" ? "block" : "none";
    };
    el.appendChild(b);
  });
})();

// ─── Difficulty picker ────────────────────────────────────────────────────────
function selectDifficulty(diff) {
  state.difficulty = diff;
  document.getElementById("create-difficulty").value = diff;
  ["easy","medium","hard"].forEach(d => {
    const b = document.getElementById("diff-"+d);
    b.className = "diff-btn" + (d === diff ? " active-"+d : "");
  });
}

// ─── Time picker ──────────────────────────────────────────────────────────────
function selectTime(sec) {
  state.timeLimit = sec;
  document.getElementById("create-timelimit").value = sec;
  document.querySelectorAll(".time-btn").forEach(b => {
    b.classList.toggle("active", b.textContent === sec+"s");
  });
}

// ─── Spectator join toggle ────────────────────────────────────────────────────
function toggleSpectatorJoin() {
  const cb = document.getElementById("join-spectator");
  cb.checked = !cb.checked;
}

// ─── Create / Join ───────────────────────────────────────────────────────────
function createRoom() {
  const name = document.getElementById("create-name").value.trim();
  if (!name) return showToast("❌ Enter your name first!");
  const emoji = document.getElementById("create-emoji").value;
  const mode  = document.getElementById("create-mode").value;
  const rounds = parseInt(document.getElementById("create-rounds").value) || 5;
  const timeLimit = parseInt(document.getElementById("create-timelimit").value) || 60;
  const diff = document.getElementById("create-difficulty").value || "easy";
  socket.emit("create_room", { playerName: name, emoji, gameMode: mode, totalRounds: rounds, timeLimit, difficulty: diff });
}

function joinRoom() {
  const code  = document.getElementById("join-code").value.trim().toUpperCase();
  const name  = document.getElementById("join-name").value.trim();
  const emoji = document.getElementById("join-emoji").value;
  const asSpec= document.getElementById("join-spectator").checked;
  document.getElementById("join-error").textContent = "";
  if (!code || code.length !== 6) return (document.getElementById("join-error").textContent = "Enter a 6-character room code");
  if (!name) return (document.getElementById("join-error").textContent = "Enter your name");
  socket.emit("join_room", { roomCode: code, playerName: name, emoji, asSpectator: asSpec });
}

function copyRoomCode() {
  navigator.clipboard.writeText(state.roomCode || "").then(() => showToast("📋 Room code copied!"));
}

function forceStart() { socket.emit("force_start", { roomCode: state.roomCode }); }

function toggleReady() {
  socket.emit("player_ready", { roomCode: state.roomCode });
  document.getElementById("btn-ready").disabled = true;
  document.getElementById("btn-ready").textContent = "✅ Ready!";
}

// ─── Lobby render ─────────────────────────────────────────────────────────────
function renderLobby(room) {
  document.getElementById("lobby-room-code").textContent = room.code;
  state.roomCode = room.code;

  // Settings chips
  const settingsEl = document.getElementById("lobby-settings");
  const modeLabel = MODES.find(m=>m.id===room.gameMode)?.label || room.gameMode;
  const diffLabel = room.difficulty ? (room.difficulty[0].toUpperCase()+room.difficulty.slice(1)) : "";
  const wlLabel = room.wordLength ? `${room.wordLength} letters` : "";
  settingsEl.innerHTML = [
    `<span class="lobby-setting-chip">🎮 ${modeLabel}</span>`,
    diffLabel ? `<span class="lobby-setting-chip">📊 ${diffLabel}</span>` : "",
    wlLabel ? `<span class="lobby-setting-chip">🔤 ${wlLabel}</span>` : "",
    `<span class="lobby-setting-chip">🔄 ${room.totalRounds} rounds</span>`,
  ].join("");

  // Player list
  const el = document.getElementById("lobby-players");
  el.innerHTML = "";
  const activePlayers = Object.values(room.players).filter(p=>!p.isSpectator);
  const specs = Object.values(room.players).filter(p=>p.isSpectator);

  for (const p of activePlayers) {
    const card = document.createElement("div");
    card.className = "player-card" + (p.id === room.hostId ? " is-host" : "");
    const readyTag = p.isReady ? `<span class="p-ready">✅ Ready</span>` : `<span class="p-waiting">⏳ Waiting</span>`;
    const hostTag  = p.id === room.hostId ? `<span class="p-host">👑 Host</span>` : "";
    const streakTag = p.streak >= 2 ? `<span class="streak-badge">🔥×${p.streak}</span>` : "";
    card.innerHTML = `<span class="p-emoji">${p.emoji}</span><span class="p-name">${esc(p.name)}</span>${streakTag}${hostTag}${readyTag}`;
    el.appendChild(card);
  }
  if (specs.length) {
    const specDiv = document.createElement("div");
    specDiv.style.cssText = "font-size:0.78rem;color:var(--muted);font-weight:700;text-align:center;margin-top:6px";
    specDiv.textContent = `👁 ${specs.length} spectator${specs.length>1?"s":""} watching`;
    el.appendChild(specDiv);
  }

  document.getElementById("lobby-meta").textContent =
    `${activePlayers.length}/6 players`;

  // Controls
  const isHost = room.hostId === state.playerId;
  document.getElementById("host-controls").style.display = (!state.isSpectator && isHost) ? "block" : "none";
  document.getElementById("guest-controls").style.display = (!state.isSpectator && !isHost) ? "block" : "none";
  document.getElementById("lobby-waiting").style.display = activePlayers.length < 2 ? "block" : "none";
}

// ─── Game board ───────────────────────────────────────────────────────────────
function buildGuessGrid(wl, maxAttempts = 6) {
  const grid = document.getElementById("guess-grid");
  grid.innerHTML = "";
  for (let r = 0; r < maxAttempts; r++) {
    const row = document.createElement("div"); row.className = "guess-row"; row.id = `row-${r}`;
    for (let c = 0; c < wl; c++) {
      const tile = document.createElement("div"); tile.className = "tile"; tile.id = `tile-${r}-${c}`;
      row.appendChild(tile);
    }
    grid.appendChild(row);
  }
}

function buildKeyboard() {
  const rows = [["Q","W","E","R","T","Y","U","I","O","P"],["A","S","D","F","G","H","J","K","L"],["ENTER","Z","X","C","V","B","N","M","⌫"]];
  const kb = document.getElementById("keyboard"); kb.innerHTML = "";
  rows.forEach(r => {
    const row = document.createElement("div"); row.className = "key-row";
    r.forEach(k => {
      const b = document.createElement("button"); b.type="button";
      b.className = "key" + (k.length>1?" wide":""); b.dataset.key=k; b.textContent=k;
      b.onclick = () => handleKey(k);
      row.appendChild(b);
    });
    kb.appendChild(row);
  });
}

function handleKey(key) {
  if (state.isSpectator) return;
  const room = state.roomState;
  if (!room || room.phase !== "playing") return;
  const me = room.players[state.playerId];
  if (!me || me.solved || me.attemptsUsed >= 6) return;

  if (room.gameMode === "relay") {
    const playerIds = Object.keys(room.players).filter(id => !room.players[id].isSpectator);
    if (playerIds[room.relayTurnIndex % playerIds.length] !== state.playerId) return;
  }

  const wl = room.wordLength || 5;
  if (key === "⌫" || key === "Backspace") {
    if (state.currentGuess.length) { state.currentGuess.pop(); sfxDelete(); updateCurrentRow(me.attemptsUsed, wl); }
    return;
  }
  if (key === "ENTER" || key === "Enter") {
    if (state.currentGuess.length !== wl) { sfxInvalid(); shakeRow(me.attemptsUsed); return; }
    sfxSubmit();
    socket.emit("submit_guess", { roomCode: state.roomCode, guess: state.currentGuess.join("") });
    state.currentGuess = [];
    return;
  }
  if (/^[A-Za-z]$/.test(key) && state.currentGuess.length < wl) {
    state.currentGuess.push(key.toUpperCase()); sfxKey();
    updateCurrentRow(me.attemptsUsed, wl);
  }
}

document.addEventListener("keydown", e => {
  if (["INPUT","TEXTAREA"].includes(e.target.tagName)) return;
  const room = state.roomState;
  if (!room || room.phase !== "playing") return;
  handleKey(e.key === "Backspace" ? "⌫" : e.key === "Enter" ? "ENTER" : e.key);
});

function updateCurrentRow(rowIdx, wl) {
  for (let c = 0; c < wl; c++) {
    const tile = document.getElementById(`tile-${rowIdx}-${c}`);
    if (!tile) continue;
    const letter = state.currentGuess[c] || "";
    tile.textContent = letter;
    tile.className = "tile" + (letter ? " filled current-row" : " current-row");
  }
}

function shakeRow(rowIdx) {
  const row = document.getElementById(`row-${rowIdx}`);
  if (!row) return;
  row.classList.add("shake");
  setTimeout(() => row.classList.remove("shake"), 400);
}

function fillRow(rowIdx, guess, colors, wl) {
  guess.split("").forEach((letter, c) => {
    const tile = document.getElementById(`tile-${rowIdx}-${c}`);
    if (!tile) return;
    setTimeout(() => {
      tile.classList.add("flip");
      setTimeout(() => {
        tile.textContent = letter; tile.className = `tile ${colors[c]}`;
      }, 250);
    }, c * 80);
  });
}

function updateKeyboardColors(guesses, colors) {
  const priority = { green:3, yellow:2, gray:1 };
  const best = {};
  guesses.forEach((g, ri) => {
    g.split("").forEach((letter, c) => {
      const col = colors[ri][c];
      if (!best[letter] || priority[col] > priority[best[letter]]) best[letter] = col;
    });
  });
  document.querySelectorAll(".key").forEach(k => {
    const l = k.dataset.key;
    if (best[l]) { k.className = "key" + (l.length>1?" wide":"") + " " + best[l]; }
  });
}

function buildHintRow(wl) {
  const row = document.getElementById("hint-row");
  row.innerHTML = "";
  row.style.display = "flex";
  for (let i=0; i<wl; i++) {
    const t = document.createElement("div"); t.className="hint-tile"; t.id=`hint-${i}`; t.textContent="?";
    row.appendChild(t);
  }
}

function applyHintLetter(pos, letter) {
  state.hintedLetters[pos] = letter;
  const t = document.getElementById(`hint-${pos}`);
  if (t) { t.textContent = letter; t.style.color = "#f0f0ff"; t.style.borderColor = "#c084fc"; }
}

// ─── Opponents panel ──────────────────────────────────────────────────────────
function renderOpponents(room) {
  const panel = document.getElementById("opponents-panel");
  panel.innerHTML = "";
  const playerIds = Object.keys(room.players).filter(id => !room.players[id].isSpectator);
  const relayPlayerIds = playerIds;

  for (const [id, p] of Object.entries(room.players)) {
    const isMe = id === state.playerId;
    const card = document.createElement("div"); card.className = "opponent-card";

    let activeTurn = false;
    if (room.gameMode === "relay" && room.phase === "playing") {
      activeTurn = relayPlayerIds[room.relayTurnIndex % relayPlayerIds.length] === id && !p.isSpectator;
    }
    if (activeTurn) card.classList.add("active-turn");
    if (p.solved) card.classList.add("solved-card");

    const wl = room.wordLength || 5;
    const specTag = p.isSpectator ? `<span class="spec-tag">👁</span>` : "";
    const streakTag = p.streak >= 2 ? `<span class="streak-badge">🔥×${p.streak}</span>` : "";
    const turnTag = activeTurn ? `<span style="font-size:0.65rem;color:var(--green);font-weight:800">YOUR TURN</span>` : "";
    const solvedBadge = p.solved ? `<span style="color:var(--green);font-size:0.75rem;font-weight:800">✅ ${p.attemptsUsed} tries</span>` : "";

    card.innerHTML = `
      <div class="opp-header">
        <span class="opp-emoji">${p.emoji}</span>
        <span class="opp-name">${esc(p.name)}${isMe?" (you)":""}</span>
        ${streakTag}${specTag}
        <span class="opp-score">⭐${p.score}</span>
      </div>
      ${turnTag}${solvedBadge}
      <div class="mini-grid" id="mini-${id}"></div>
    `;
    panel.appendChild(card);

    if (!p.isSpectator) renderMiniGrid(id, p.guesses || [], p.colors || [], wl);
  }

  // Spectator count
  if (room.spectators > 0) {
    const div = document.createElement("div");
    div.style.cssText = "font-size:0.75rem;color:var(--muted);font-weight:700;text-align:center;padding:4px";
    div.textContent = `👁 ${room.spectators} spectator${room.spectators>1?"s":""} watching`;
    panel.appendChild(div);
  }
}

function renderMiniGrid(playerId, guesses, colors, wl) {
  const grid = document.getElementById("mini-"+playerId);
  if (!grid) return;
  grid.innerHTML = "";
  for (let r=0; r<6; r++) {
    const row = document.createElement("div"); row.className="mini-row";
    for (let c=0; c<wl; c++) {
      const t = document.createElement("div"); t.className="mini-tile";
      if (guesses[r]) t.classList.add(colors[r]?.[c] || "gray");
      row.appendChild(t);
    }
    grid.appendChild(row);
  }
}

// ─── Timer bar ────────────────────────────────────────────────────────────────
function updateTimerBar(remaining, total) {
  const fill = document.getElementById("time-attack-fill");
  const secs = document.getElementById("time-attack-secs");
  const pct = Math.max(0, (remaining / total) * 100);
  fill.style.width = pct+"%";
  secs.textContent = remaining+"s";
  fill.classList.toggle("danger", pct < 25);
}

// ─── Topbar ───────────────────────────────────────────────────────────────────
function updateTopbar(room) {
  document.getElementById("game-room-code").textContent = room.code;
  document.getElementById("game-round-info").textContent = `Round ${room.currentRound}/${room.totalRounds}`;
  const me = room.players[state.playerId];
  document.getElementById("game-score").textContent = me ? `⭐ ${me.score}` : "";

  const modeLabel = MODES.find(m=>m.id===room.gameMode)?.label || room.gameMode;
  const diffColor = { easy:"diff-badge-easy", medium:"diff-badge-medium", hard:"diff-badge-hard" }[room.difficulty] || "";
  const diffLabel = room.difficulty ? ` · ${room.difficulty[0].toUpperCase()+room.difficulty.slice(1)}` : "";
  document.getElementById("topbar-mode-badge").innerHTML =
    `<span class="${diffColor}">${modeLabel}${diffLabel}</span>`;
}

// ─── Relay info panel ──────────────────────────────────────────────────────────
function updateRelayInfo(room) {
  const el = document.getElementById("relay-info");
  if (room.gameMode !== "relay") { el.style.display="none"; return; }
  el.style.display = "block";
  const playerIds = Object.keys(room.players).filter(id=>!room.players[id].isSpectator);
  const current = room.players[playerIds[room.relayTurnIndex % playerIds.length]];
  el.textContent = current ? `🎮 ${current.name}'s turn` : "";
}

// ─── Spectator UI ─────────────────────────────────────────────────────────────
function setSpectatorUI(isSpec) {
  const banner = document.getElementById("spectator-banner");
  const reactionBar = document.getElementById("reaction-bar");
  if (isSpec) {
    banner.classList.add("visible");
    reactionBar.classList.add("visible");
  } else {
    banner.classList.remove("visible");
    reactionBar.classList.remove("visible");
  }
}

function sendReaction(emoji) {
  socket.emit("send_reaction", { roomCode: state.roomCode, reaction: emoji });
}

function showFloatingReaction(reaction, playerName) {
  const el = document.createElement("div");
  el.className = "float-reaction";
  el.textContent = reaction;
  el.style.left = (20 + Math.random() * 60) + "vw";
  el.style.bottom = "80px";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

// ─── Round over ───────────────────────────────────────────────────────────────
function renderRoundOver(data) {
  showScreen("screen-roundover");
  if (state.roundOverCountdown) clearInterval(state.roundOverCountdown);

  document.getElementById("roundover-title").textContent =
    data.playerResults?.find(p=>p.id===state.playerId)?.solved ? "🎉 Well Done!" : "😬 Round Over!";

  // Word reveal tiles
  const wrap = document.getElementById("roundover-word");
  wrap.innerHTML = "";
  if (data.word) {
    data.word.split("").forEach(l => {
      const t = document.createElement("div"); t.className="tile green"; t.textContent=l;
      wrap.appendChild(t);
    });
  }

  // Leaderboard
  const lb = document.getElementById("roundover-leaderboard");
  lb.innerHTML = `<tr><th>#</th><th>Player</th><th>+Pts</th><th>Total</th><th>Streak</th></tr>`;
  (data.playerResults||[]).forEach((p,i) => {
    const tr = document.createElement("tr");
    if (i<3) tr.className=`podium-${i+1}`;
    tr.innerHTML = `
      <td>${i+1}</td>
      <td>${p.emoji || ""} ${esc(p.name)}</td>
      <td class="points">+${p.roundScore||0}</td>
      <td class="points">${p.score}</td>
      <td>${p.streak>=2?"🔥×"+p.streak:"-"}</td>
    `;
    lb.appendChild(tr);
  });

  document.getElementById("host-next-btn").style.display =
    state.roomState?.hostId === state.playerId && !state.isSpectator ? "block" : "none";

  let secs = 8;
  const cd = document.getElementById("roundover-countdown");
  cd.textContent = `Next round in ${secs}s...`;
  state.roundOverCountdown = setInterval(() => {
    secs--;
    if (secs <= 0) { clearInterval(state.roundOverCountdown); cd.textContent = "Starting..."; }
    else cd.textContent = `Next round in ${secs}s...`;
  }, 1000);
}

// ─── Game over ────────────────────────────────────────────────────────────────
function renderGameOver(players) {
  showScreen("screen-gameover");
  if (state.roundOverCountdown) clearInterval(state.roundOverCountdown);
  const winner = players[0];
  document.getElementById("winner-announce").innerHTML =
    winner ? `${winner.emoji} <strong>${esc(winner.name)}</strong> wins with <strong>${winner.score}</strong> pts! 🏆` : "It's a tie!";

  const lb = document.getElementById("gameover-leaderboard");
  lb.innerHTML = `<tr><th>#</th><th>Player</th><th>Score</th><th>Best Streak</th></tr>`;
  players.forEach((p,i) => {
    const tr = document.createElement("tr");
    if (i<3) tr.className=`podium-${i+1}`;
    tr.innerHTML = `<td>${i+1}</td><td>${p.emoji||""} ${esc(p.name)}</td><td class="points">${p.score}</td><td>${p.streak>=2?"🔥×"+p.streak:"-"}</td>`;
    lb.appendChild(tr);
  });
  sfxWin();
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc(s="") {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function exitGame() {
  if (!confirm("Exit to home?")) return;
  setSpectatorUI(false);
  state.isSpectator = false;
  showScreen("screen-home");
}

function restartGame() { socket.emit("restart_game", { roomCode: state.roomCode }); }
function nextRound()   { socket.emit("next_round",    { roomCode: state.roomCode }); }
function newGame()     { setSpectatorUI(false); state.isSpectator=false; showScreen("screen-home"); }

function toggleMute() {
  state.muted = !state.muted;
  document.getElementById("btn-mute").textContent = state.muted ? "🔇" : "🔊";
}

function useHint() {
  if (state.isSpectator) return;
  socket.emit("use_hint", { roomCode: state.roomCode });
}

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on("connect", () => {
  const loading = document.getElementById("screen-loading");
  loading.classList.add("hidden");
  setTimeout(() => loading.style.display="none", 500);
});

socket.on("connect_error", () => {
  document.querySelector(".loading-text").textContent = "⚠️ Connecting...";
});

// FIX: room_created now redirects to lobby
socket.on("room_created", ({ roomCode, playerId }) => {
  state.playerId = playerId;
  state.roomCode = roomCode;
  state.isSpectator = false;
  showScreen("screen-lobby");
  document.getElementById("lobby-room-code").textContent = roomCode;
});

socket.on("join_success", ({ playerId, roomState, isSpectator }) => {
  state.playerId = playerId;
  state.roomCode = roomState.code;
  state.isSpectator = isSpectator;
  state.roomState = roomState;
  setSpectatorUI(isSpectator);
  renderLobby(roomState);
  showScreen("screen-lobby");
});

socket.on("join_error", ({ message }) => {
  document.getElementById("join-error").textContent = message;
});

socket.on("room_updated", (room) => {
  state.roomState = room;
  const screen = document.querySelector(".screen.active")?.id;
  if (screen === "screen-lobby") renderLobby(room);
  if (screen === "screen-game") {
    updateTopbar(room);
    renderOpponents(room);
    updateRelayInfo(room);
    const me = room.players[state.playerId];
    if (me) document.getElementById("game-score").textContent = `⭐ ${me.score}`;
  }
});

socket.on("game_started", ({ wordLength, round, mode, totalRounds, difficulty }) => {
  state.currentGuess = [];
  state.hintedLetters = {};
  if (state.roundOverCountdown) { clearInterval(state.roundOverCountdown); state.roundOverCountdown = null; }
  setSpectatorUI(state.isSpectator);

  buildGuessGrid(wordLength, 6);
  buildKeyboard();

  // Hint row for hint mode
  if (mode === "hint_mode") {
    buildHintRow(wordLength);
    document.getElementById("hint-btn-wrap").style.display = !state.isSpectator ? "flex" : "none";
  } else {
    document.getElementById("hint-row").style.display = "none";
    document.getElementById("hint-btn-wrap").style.display = "none";
  }

  // Timer bar
  const timerWrap = document.getElementById("time-attack-bar-wrap");
  if (mode === "time_attack") {
    timerWrap.style.display = "flex";
    const room = state.roomState;
    state.currentTimeLimit = room?.timeLimit || 60;
    state.currentTimeRemaining = state.currentTimeLimit;
    updateTimerBar(state.currentTimeLimit, state.currentTimeLimit);
  } else {
    timerWrap.style.display = "none";
  }

  // Relay info
  document.getElementById("relay-info").style.display = mode === "relay" ? "block" : "none";

  // Keyboard disabled for spectators
  document.getElementById("keyboard").style.opacity = state.isSpectator ? "0.4" : "1";
  document.getElementById("keyboard").style.pointerEvents = state.isSpectator ? "none" : "auto";

  showScreen("screen-game");
  if (state.roomState) {
    updateTopbar(state.roomState);
    renderOpponents(state.roomState);
  }
});

socket.on("timer_tick", ({ timeRemaining }) => {
  state.currentTimeRemaining = timeRemaining;
  updateTimerBar(timeRemaining, state.currentTimeLimit || state.roomState?.timeLimit || 60);
});

socket.on("guess_made", ({ playerId, guess, colors, attemptsUsed, solved, relaySharedGuesses, relaySharedColors, relayTurnIndex }) => {
  const room = state.roomState;
  if (!room) return;
  const wl = room.wordLength || 5;

  if (playerId === state.playerId && !state.isSpectator) {
    const rowIdx = attemptsUsed - 1;
    fillRow(rowIdx, guess, colors, wl);
    const me = room.players[state.playerId];
    if (me) {
      updateKeyboardColors(me.guesses || [guess], me.colors || [colors]);
    }
    if (solved) sfxWin();
    else if (attemptsUsed >= 6) sfxLoss();
  }

  // Relay board — clear old and redraw
  if (room.gameMode === "relay") {
    (relaySharedGuesses||[]).forEach((g,r) => fillRow(r, g, relaySharedColors[r], wl));
    if (typeof relayTurnIndex === "number" && room.players) {
      room.relayTurnIndex = relayTurnIndex;
      updateRelayInfo(room);
    }
  }

  renderOpponents(room);
});

socket.on("guess_rejected", ({ reason, message }) => {
  if (reason === "hard_mode") {
    showToast(`🔒 ${message || "Hard mode: reuse your revealed hints!"}`);
    sfxInvalid();
    const room = state.roomState;
    if (room) shakeRow(room.players[state.playerId]?.attemptsUsed || 0);
  } else if (reason === "not_a_word") {
    showToast("❌ Not a valid dictionary word!");
    sfxInvalid();
    const room = state.roomState;
    if (room) shakeRow(room.players[state.playerId]?.attemptsUsed || 0);
  }
});

socket.on("hint_received", ({ position, letter }) => {
  applyHintLetter(position, letter);
  showToast(`💡 Hint: Position ${position+1} is "${letter}"`);
});

socket.on("score_updated", ({ playerId, score }) => {
  if (state.roomState?.players[playerId]) {
    state.roomState.players[playerId].score = score;
  }
  if (playerId === state.playerId) {
    document.getElementById("game-score").textContent = `⭐ ${score}`;
  }
});

socket.on("round_over", (data) => {
  renderRoundOver(data);
});

socket.on("game_over", ({ players }) => {
  renderGameOver(players);
});

socket.on("reaction_received", ({ playerId, playerName, reaction }) => {
  showFloatingReaction(reaction, playerName);
  // Show near that player's opponent card
  const card = document.querySelector(`#mini-${playerId}`)?.closest(".opponent-card");
  if (card) {
    const pop = document.createElement("div");
    pop.style.cssText = "position:absolute;top:-24px;right:4px;font-size:1.4rem;animation:floatUp 1s ease-out forwards;pointer-events:none";
    pop.textContent = reaction;
    card.style.position = "relative";
    card.appendChild(pop);
    setTimeout(() => pop.remove(), 1000);
  }
});

socket.on("toast", ({ message }) => showToast(message));

// ─── Loading timeout fallback ──────────────────────────────────────────────────
setTimeout(() => {
  const l = document.getElementById("screen-loading");
  if (l && !l.classList.contains("hidden")) {
    l.classList.add("hidden");
    setTimeout(() => l.style.display="none", 500);
  }
}, 8000);
