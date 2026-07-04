const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const compression = require("compression");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

app.use(compression());
app.use(express.static(path.join(__dirname)));

// ─── Rate Limiting ─────────────────────────────────────────────────────────
const guessRateMap = {};   // socketId -> { count, resetAt }
const GUESS_RATE_LIMIT = 5; // max guesses per second
function isRateLimited(socketId) {
  const now = Date.now();
  let entry = guessRateMap[socketId];
  if (!entry || now > entry.resetAt) {
    guessRateMap[socketId] = { count: 1, resetAt: now + 1000 };
    return false;
  }
  entry.count++;
  return entry.count > GUESS_RATE_LIMIT;
}

// ─── Word list ────────────────────────────────────────────────────────────────
let SERVER_WORDS_BY_LEN = {};

// Difficulty tiers (easy = 3-4 letter common, medium = 5-6, hard = 7-9)
const DIFFICULTY_RANGES = { easy: [3,4], medium: [5,6], hard: [7,8,9] };

try {
  const wordsFile = fs.readFileSync(path.join(__dirname, "words.js"), "utf8");
  const match = wordsFile.match(/window\.WORDS\s*=\s*(\[[\s\S]*?\])/);
  if (match) {
    const all = JSON.parse(match[1]);
    for (const w of all) {
      if (/^[A-Z]+$/.test(w)) {
        const l = w.length;
        if (!SERVER_WORDS_BY_LEN[l]) SERVER_WORDS_BY_LEN[l] = [];
        SERVER_WORDS_BY_LEN[l].push(w);
      }
    }
  }
} catch(e) {
  SERVER_WORDS_BY_LEN[5] = ["CRANE","STARE","PLATE","LIGHT","BRAVE","CHAIR","FLAME","PLANT","STONE","TRAIN"];
}

const FALLBACK = {
  3: ["CAT","DOG","SUN","RUN","FUN","HOT","BIG","MAN","DAY","SKY","RED","CAR","AIR","EAT","SEA"],
  4: ["LOVE","DARK","FIRE","BLUE","GAME","RACE","MOON","STAR","BIRD","FISH","GOLD","LAKE","TREE","WIND","ROAD"],
  5: ["CRANE","STARE","PLATE","LIGHT","BRAVE","CHAIR","FLAME","PLANT","STONE","TRAIN","MOUSE","HOUSE","PAPER","WATER","EARTH"],
  6: ["BRIDGE","CASTLE","DANCER","ROCKET","ORANGE","SILVER","FOREST","BUTTER","YELLOW","CANDLE","GARDEN","TEMPLE"],
  7: ["CABINET","DOLPHIN","FANTASY","JOURNEY","LANTERN","MYSTERY","NOTHING","PROBLEM","CAPITAL","DIAMOND"],
  8: ["ABSOLUTE","BASEBALL","CARNIVAL","DAUGHTER","FOOTBALL","GRATEFUL","LANGUAGE","MOUNTAIN","TOGETHER"],
  9: ["ADVENTURE","BEAUTIFUL","CHOCOLATE","DANGEROUS","EVERYBODY","FAVOURITE","KNOWLEDGE","WONDERFUL"],
};
for (const [l, words] of Object.entries(FALLBACK)) {
  if (!SERVER_WORDS_BY_LEN[l] || SERVER_WORDS_BY_LEN[l].length < 5) {
    SERVER_WORDS_BY_LEN[l] = words;
  }
}

// ─── In-memory state ──────────────────────────────────────────────────────────
const rooms = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function checkGuess(guess, word) {
  const len = word.length;
  const result = Array(len).fill("gray");
  const wordUsed = Array(len).fill(false);
  const guessUsed = Array(len).fill(false);
  for (let i = 0; i < len; i++) {
    if (guess[i] === word[i]) {
      result[i] = "green"; wordUsed[i] = true; guessUsed[i] = true;
    }
  }
  for (let i = 0; i < len; i++) {
    if (guessUsed[i]) continue;
    for (let j = 0; j < len; j++) {
      if (!wordUsed[j] && guess[i] === word[j]) {
        result[i] = "yellow"; wordUsed[j] = true; break;
      }
    }
  }
  return result;
}

// Hard mode: any previously revealed green/yellow letter must be reused in later guesses.
function checkHardMode(guess, priorGuesses, priorColors) {
  const requiredPos = {};   // position -> letter that MUST be there (green)
  const requiredLetters = new Set(); // letters that MUST appear somewhere (yellow)

  priorGuesses.forEach((g, gi) => {
    const cols = priorColors[gi] || [];
    cols.forEach((c, i) => {
      if (c === "green") requiredPos[i] = g[i];
      else if (c === "yellow") requiredLetters.add(g[i]);
    });
  });

  for (const [pos, letter] of Object.entries(requiredPos)) {
    if (guess[pos] !== letter) {
      return { ok: false, message: `Position ${Number(pos) + 1} must be "${letter}" (hard mode)` };
    }
  }
  for (const letter of requiredLetters) {
    if (!guess.includes(letter)) {
      return { ok: false, message: `Guess must include "${letter}" (hard mode)` };
    }
  }
  return { ok: true };
}

function pickWord(room) {
  let pool;

  if (room.difficulty === "easy") {
    const lens = DIFFICULTY_RANGES.easy;
    pool = [].concat(...lens.map(l => SERVER_WORDS_BY_LEN[l] || []));
  } else if (room.difficulty === "hard") {
    const lens = DIFFICULTY_RANGES.hard;
    pool = [].concat(...lens.map(l => SERVER_WORDS_BY_LEN[l] || []));
  } else if (room.difficulty === "medium") {
    const lens = DIFFICULTY_RANGES.medium;
    pool = [].concat(...lens.map(l => SERVER_WORDS_BY_LEN[l] || []));
  } else {
    pool = SERVER_WORDS_BY_LEN[5] || ["CRANE"];
  }

  // Filter out words used this game
  const available = pool.filter(w => !room.usedWords.has(w));
  const source = available.length > 0 ? available : pool; // fallback if all used
  return source[Math.floor(Math.random() * source.length)];
}

function getSafeRoom(room) {
  const safe = {
    code: room.code,
    hostId: room.hostId,
    wordLength: room.wordLength,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    gameMode: room.gameMode,
    difficulty: room.difficulty,
    timeLimit: room.timeLimit,
    timeRemaining: room.timeRemaining,
    phase: room.phase,
    relayTurnIndex: room.relayTurnIndex,
    relaySharedGuesses: room.relaySharedGuesses,
    relaySharedColors: room.relaySharedColors,
    // Never expose the word during active play
    word: ["roundover","gameover"].includes(room.phase) ? room.word : null,
    players: {},
    spectators: room.spectators,
  };
  for (const [id, p] of Object.entries(room.players)) {
    safe.players[id] = {
      id: p.id, name: p.name, emoji: p.emoji,
      score: p.score, guesses: p.guesses, colors: p.colors,
      solved: p.solved, attemptsUsed: p.attemptsUsed,
      solvedAt: p.solvedAt, hintsUsed: p.hintsUsed,
      isReady: p.isReady, roundScore: p.roundScore,
      streak: p.streak, isSpectator: p.isSpectator,
    };
  }
  return safe;
}

function allPlayersDone(room) {
  const players = Object.values(room.players).filter(p => !p.isSpectator);
  if (!players.length) return false;
  return players.every(p => p.solved || p.attemptsUsed >= 6);
}

function makePlayer(id, name, emoji, isSpectator = false) {
  return {
    id, name: (name || "Player").slice(0, 20),
    emoji: emoji || "👾",
    score: 0, guesses: [], colors: [],
    solved: false, attemptsUsed: 0,
    solvedAt: null, hintsUsed: 0,
    isReady: false, roundScore: 0,
    hintedPositions: new Set(),
    streak: 0,
    isSpectator,
  };
}

// ─── Start Game ───────────────────────────────────────────────────────────────
function startGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }

  for (const player of Object.values(room.players)) {
    if (player.isSpectator) continue;
    player.guesses = []; player.colors = [];
    player.solved = false; player.attemptsUsed = 0;
    player.solvedAt = null; player.hintsUsed = 0;
    player.isReady = false; player.roundScore = 0;
    player.hintedPositions = new Set();
    // comebackEligible stays from previous round
  }
  room.relayTurnIndex = 0;
  room.relayGuessesThisTurn = 0;
  room.relaySharedGuesses = [];
  room.relaySharedColors = [];

  room.word = pickWord(room);
  room.usedWords.add(room.word);
  room.wordLength = room.word.length;

  room.phase = "playing";
  room.timeRemaining = room.timeLimit;
  room.roundStartTime = Date.now();

  io.to(roomCode).emit("game_started", {
    wordLength: room.word.length,
    round: room.currentRound,
    mode: room.gameMode,
    totalRounds: room.totalRounds,
    difficulty: room.difficulty,
  });
  io.to(roomCode).emit("room_updated", getSafeRoom(room));

  if (room.gameMode === "time_attack") {
    room.timerInterval = setInterval(() => {
      if (!rooms[roomCode] || room.phase !== "playing") {
        clearInterval(room.timerInterval); room.timerInterval = null; return;
      }
      room.timeRemaining--;
      io.to(roomCode).emit("timer_tick", { timeRemaining: room.timeRemaining });
      if (room.timeRemaining === 30) io.to(roomCode).emit("toast", { message: "⏰ 30 seconds remaining!" });
      if (room.timeRemaining === 10) io.to(roomCode).emit("toast", { message: "⚠️ 10 seconds left!" });
      if (room.timeRemaining <= 0) {
        clearInterval(room.timerInterval); room.timerInterval = null;
        endRound(roomCode);
      }
    }, 1000);
  }

  if (room.gameMode === "relay") {
    const playerIds = Object.keys(room.players).filter(id => !room.players[id].isSpectator);
    const first = playerIds.length ? room.players[playerIds[0]] : null;
    if (first) io.to(roomCode).emit("toast", { message: `🎮 ${first.name} goes first!` });
  }
}

// ─── Score Calculation ────────────────────────────────────────────────────────
function endRound(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase === "roundover" || room.phase === "gameover") return;
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
  room.phase = "roundover";

  const players = Object.values(room.players).filter(p => !p.isSpectator);
  const wl = room.word ? room.word.length : (room.wordLength || 5);
  const baseByLength = { 3:20, 4:30, 5:50, 6:60, 7:70, 8:80, 9:100 };
  const solved = players.filter(p => p.solved).sort((a, b) => a.solvedAt - b.solvedAt);

  // Identify last-place player for comeback bonus (player with lowest score before this round).
  // Only counts if they're UNIQUELY in last place — a tie (e.g. round 1, everyone at 0) shouldn't
  // arbitrarily hand the bonus to whoever happens to sort first.
  const sortedByScore = [...players].sort((a, b) => a.score - b.score);
  const lastPlaceId = (sortedByScore.length > 1 && sortedByScore[0].score < sortedByScore[1].score)
    ? sortedByScore[0].id
    : null;

  for (const player of players) {
    if (!player.solved) {
      player.roundScore = 0;
      player.streak = 0;
      continue;
    }

    const isFirst = solved[0]?.id === player.id;
    const isSecond = solved[1]?.id === player.id;
    let earned = 0;

    if (room.gameMode === "time_attack") {
      // Use THIS player's own solve time, not the room's final clock value —
      // otherwise everyone who solved gets the same bonus regardless of speed.
      const elapsedMs = player.solvedAt ? (player.solvedAt - (room.roundStartTime || player.solvedAt)) : 0;
      const playerTimeRemaining = Math.max(0, room.timeLimit - elapsedMs / 1000);
      const timeBonus = Math.floor((playerTimeRemaining / room.timeLimit) * 30);
      earned = (baseByLength[wl] || 50) + timeBonus;
    } else if (room.gameMode === "hint_mode") {
      // Hints already cost the player points immediately when purchased (use_hint),
      // so the round bonus should NOT subtract for hints again — that was double-charging.
      earned = baseByLength[wl] || 50;
    } else if (room.gameMode === "relay") {
      // Whole team shares credit based on how many shared guesses the team used.
      const teamAttempts = room.relaySharedGuesses.length;
      earned = (baseByLength[wl] || 50) + Math.max(0, 6 - teamAttempts) * 10;
    } else {
      // solo_race
      earned = (baseByLength[wl] || 50) + (6 - player.attemptsUsed) * 10;
    }

    // "First/second to solve" bonus doesn't make sense for relay — it's a team, not a race.
    if (room.gameMode !== "relay") {
      if (isFirst) earned += 20;
      else if (isSecond) earned += 10;
    }

    // Streak bonus — extra points for consecutive rounds solved
    player.streak++;
    if (player.streak >= 2) {
      const streakBonus = Math.min(player.streak - 1, 10) * 10;
      earned += streakBonus;
      io.to(player.id).emit("toast", { message: `🔥 ${player.streak} round streak! +${streakBonus} bonus!` });
    }

    // Comeback bonus: last-place player who solved
    if (player.id === lastPlaceId && players.length > 1) {
      earned += 25;
      io.to(player.id).emit("toast", { message: `💪 Comeback bonus! +25 pts!` });
    }

    player.score += earned;
    player.roundScore = earned;
  }

  const playerResults = [...players].sort((a, b) => b.roundScore - a.roundScore);
  io.to(roomCode).emit("round_over", { word: room.word, playerResults, roundNumber: room.currentRound });
  io.to(roomCode).emit("room_updated", getSafeRoom(room));

  room.roundTimer = setTimeout(() => {
    if (!rooms[roomCode]) return;
    if (room.currentRound < room.totalRounds) {
      room.currentRound++;
      startGame(roomCode);
    } else {
      room.phase = "gameover";
      const finalPlayers = [...Object.values(room.players)].filter(p => !p.isSpectator).sort((a, b) => b.score - a.score);
      io.to(roomCode).emit("game_over", { players: finalPlayers });
      io.to(roomCode).emit("room_updated", getSafeRoom(room));
    }
  }, 8000);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("create_room", ({ playerName, emoji, gameMode, totalRounds, timeLimit, wordLength, difficulty }) => {
    const roomCode = generateRoomCode();
    const diff = ["easy","medium","hard"].includes(difficulty) ? difficulty : "medium";
    const initialWl = diff === "easy" ? 4 : diff === "hard" ? 7 : 5;

    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      word: null,
      wordLength: initialWl,
      usedWords: new Set(),
      currentRound: 1,
      totalRounds: Math.min(Math.max(parseInt(totalRounds) || 5, 1), 10),
      gameMode: gameMode || "solo_race",
      difficulty: diff,
      timeLimit: parseInt(timeLimit) || 60,
      timerInterval: null,
      timeRemaining: parseInt(timeLimit) || 60,
      phase: "lobby",
      players: {},
      spectators: 0,
      relayTurnIndex: 0,
      relayGuessesThisTurn: 0,
      relaySharedGuesses: [],
      relaySharedColors: [],
      roundTimer: null,
    };

    rooms[roomCode].players[socket.id] = makePlayer(socket.id, playerName, emoji, false);
    socket.join(roomCode);
    // FIX: emit both room_created AND trigger lobby display
    socket.emit("room_created", { roomCode, playerId: socket.id });
    io.to(roomCode).emit("room_updated", getSafeRoom(rooms[roomCode]));
  });

  socket.on("join_room", ({ roomCode, playerName, emoji, asSpectator }) => {
    const code = (roomCode || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit("join_error", { message: "Room not found" });

    const activePlayers = Object.values(room.players).filter(p => !p.isSpectator).length;

    if (!asSpectator && room.phase !== "lobby") return socket.emit("join_error", { message: "Game already in progress — join as spectator?" });
    if (!asSpectator && activePlayers >= 6) return socket.emit("join_error", { message: "Room is full (max 6) — join as spectator?" });

    const isSpec = asSpectator || (room.phase !== "lobby");
    if (isSpec) room.spectators = (room.spectators || 0) + 1;

    room.players[socket.id] = makePlayer(socket.id, playerName, emoji, isSpec);
    socket.join(code);
    socket.emit("join_success", { playerId: socket.id, roomState: getSafeRoom(room), isSpectator: isSpec });
    if (isSpec) {
      socket.emit("toast", { message: "👁 You joined as a spectator. Watch and react!" });
    }
    io.to(code).emit("room_updated", getSafeRoom(room));
  });

  socket.on("player_ready", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.players[socket.id]) return;
    if (room.players[socket.id].isSpectator) return;
    room.players[socket.id].isReady = true;
    io.to(roomCode).emit("room_updated", getSafeRoom(room));
    const activePlayers = Object.values(room.players).filter(p => !p.isSpectator);
    if (activePlayers.length >= 2 && activePlayers.every(p => p.isReady)) startGame(roomCode);
  });

  socket.on("force_start", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    startGame(roomCode);
  });

  socket.on("submit_guess", ({ roomCode, guess }) => {
    // Rate limiting
    if (isRateLimited(socket.id)) return;

    const room = rooms[roomCode];
    if (!room || room.phase !== "playing") return;
    const player = room.players[socket.id];
    if (!player || player.isSpectator) return;
    if (player.solved || player.attemptsUsed >= 6) return;
    if (!guess || typeof guess !== "string") return;

    guess = guess.toUpperCase().trim();
    if (!/^[A-Z]+$/.test(guess) || guess.length !== room.word.length) return;

    // Hard mode: must reuse previously revealed green/yellow letters
    if (room.difficulty === "hard") {
      const priorGuesses = room.gameMode === "relay" ? room.relaySharedGuesses : player.guesses;
      const priorColors = room.gameMode === "relay" ? room.relaySharedColors : player.colors;
      const hardCheck = checkHardMode(guess, priorGuesses, priorColors);
      if (!hardCheck.ok) {
        socket.emit("guess_rejected", { reason: "hard_mode", message: hardCheck.message });
        return;
      }
    }

    // Relay turn check
    if (room.gameMode === "relay") {
      const playerIds = Object.keys(room.players).filter(id => !room.players[id].isSpectator);
      if (playerIds[room.relayTurnIndex % playerIds.length] !== socket.id) return;
    }

    const colors = checkGuess(guess, room.word);
    player.guesses.push(guess);
    player.colors.push(colors);
    player.attemptsUsed++;

    const solvedNow = guess === room.word;
    if (solvedNow) {
      if (room.gameMode === "relay") {
        // The whole team solved it together — credit everyone, not just the finisher
        const now = Date.now();
        for (const p of Object.values(room.players)) {
          if (p.isSpectator) continue;
          p.solved = true;
          p.solvedAt = now;
        }
        io.to(roomCode).emit("toast", { message: `🎉 ${player.name} landed the winning guess! Team solved it!` });
      } else {
        player.solved = true;
        player.solvedAt = Date.now();
        io.to(roomCode).emit("toast", { message: `🎉 ${player.name} guessed it in ${player.attemptsUsed} ${player.attemptsUsed === 1 ? "try" : "tries"}!` });
      }
    }

    if (room.gameMode === "relay") {
      room.relaySharedGuesses.push(guess);
      room.relaySharedColors.push(colors);

      if (!solvedNow && room.relaySharedGuesses.length < 6) {
        room.relayGuessesThisTurn++;
        if (room.relayGuessesThisTurn >= 2) {
          room.relayGuessesThisTurn = 0;
          room.relayTurnIndex++;
          const playerIds = Object.keys(room.players).filter(id => !room.players[id].isSpectator);
          const nextPlayer = room.players[playerIds[room.relayTurnIndex % playerIds.length]];
          if (nextPlayer) io.to(roomCode).emit("toast", { message: `🎮 ${nextPlayer.name}'s turn!` });
        }
      }
    }

    io.to(roomCode).emit("guess_made", {
      playerId: socket.id, guess, colors,
      attemptsUsed: player.attemptsUsed,
      solved: player.solved,
      relaySharedGuesses: room.relaySharedGuesses,
      relaySharedColors: room.relaySharedColors,
      relayTurnIndex: room.relayTurnIndex,
    });
    io.to(roomCode).emit("room_updated", getSafeRoom(room));

    if (allPlayersDone(room) || (room.gameMode === "relay" && (solvedNow || room.relaySharedGuesses.length >= 6))) {
      endRound(roomCode);
    }
  });

  socket.on("use_hint", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "playing") return;
    if (room.gameMode !== "hint_mode") return;
    const player = room.players[socket.id];
    if (!player || player.isSpectator) return;
    if (player.score < 10) return socket.emit("toast", { message: "❌ Not enough points for a hint!" });

    const wl = room.word.length;
    if (!(player.hintedPositions instanceof Set)) player.hintedPositions = new Set(player.hintedPositions || []);
    const correctPos = new Set();
    for (const g of player.guesses) {
      checkGuess(g, room.word).forEach((c, i) => { if (c === "green") correctPos.add(i); });
    }
    const candidates = Array.from({ length: wl }, (_, i) => i)
      .filter(i => !correctPos.has(i) && !player.hintedPositions.has(i));

    if (!candidates.length) return socket.emit("toast", { message: "💡 No new hints available!" });

    player.score -= 10;
    player.hintsUsed++;
    const pos = candidates[Math.floor(Math.random() * candidates.length)];
    player.hintedPositions.add(pos);
    socket.emit("hint_received", { position: pos, letter: room.word[pos] });
    io.to(roomCode).emit("score_updated", { playerId: socket.id, score: player.score });
    io.to(roomCode).emit("room_updated", getSafeRoom(room));
  });

  // ─── Emoji Reactions ──────────────────────────────────────────────────────
  socket.on("send_reaction", ({ roomCode, reaction }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const ALLOWED = ["🔥","😱","🤣","👏","😤","🎉","💀","🫡"];
    if (!ALLOWED.includes(reaction)) return;
    io.to(roomCode).emit("reaction_received", {
      playerId: socket.id,
      playerName: player.name,
      emoji: player.emoji,
      reaction,
    });
  });

  socket.on("next_round", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
    if (room.currentRound < room.totalRounds) {
      room.currentRound++;
      startGame(roomCode);
    } else {
      room.phase = "gameover";
      const finalPlayers = [...Object.values(room.players)].filter(p => !p.isSpectator).sort((a, b) => b.score - a.score);
      io.to(roomCode).emit("game_over", { players: finalPlayers });
      io.to(roomCode).emit("room_updated", getSafeRoom(room));
    }
  });

  socket.on("restart_game", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }

    room.currentRound = 1;
    room.phase = "lobby";
    room.word = null;
    room.usedWords = new Set();
    for (const p of Object.values(room.players)) {
      if (p.isSpectator) continue;
      p.score = 0; p.guesses = []; p.colors = [];
      p.solved = false; p.attemptsUsed = 0;
      p.solvedAt = null; p.hintsUsed = 0;
      p.isReady = false; p.roundScore = 0;
      p.streak = 0; p.hintedPositions = new Set();
    }
    io.to(roomCode).emit("room_updated", getSafeRoom(room));
  });

  socket.on("disconnect", () => {
    for (const [code, room] of Object.entries(rooms)) {
      if (!room.players[socket.id]) continue;
      const player = room.players[socket.id];
      const playerName = player.name;
      const wasSpectator = player.isSpectator;

      if (wasSpectator) room.spectators = Math.max(0, (room.spectators || 1) - 1);
      delete room.players[socket.id];
      delete guessRateMap[socket.id];

      if (Object.keys(room.players).length === 0) {
        if (room.timerInterval) clearInterval(room.timerInterval);
        if (room.roundTimer) clearTimeout(room.roundTimer);
        delete rooms[code];
        break;
      }

      // Recalculate host
      if (room.hostId === socket.id) {
        const nextActive = Object.keys(room.players).find(id => !room.players[id].isSpectator);
        room.hostId = nextActive || Object.keys(room.players)[0];
      }

      io.to(code).emit("room_updated", getSafeRoom(room));
      if (!wasSpectator) {
        io.to(code).emit("toast", { message: `👋 ${playerName} left the game` });
      }

      // Fix relay turn index if it's now out of bounds
      if (room.phase === "playing" && room.gameMode === "relay") {
        const playerIds = Object.keys(room.players).filter(id => !room.players[id].isSpectator);
        if (playerIds.length > 0) {
          room.relayTurnIndex = room.relayTurnIndex % playerIds.length;
        }
      }

      if (room.phase === "playing" && allPlayersDone(room)) endRound(code);
      break;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🔥 WordRush running on http://localhost:${PORT}`));
