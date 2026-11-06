// STATE CONQUEST - Online Multiplayer Territory Game Server
// Run: npm install && node server.js
// Deploy free on Render.com / Railway.app / Glitch.com

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const TICK_MS = 1000;          // game tick every 1 second
const GROWTH_PER_TICK = 1;      // troops gained per tick per territory
const MAX_TROOPS = 999;
const MAX_PLAYERS = 6;          // <-- room capacity, was 4
const QUICK_MATCH_WAIT_MS = 10000;

// ---- Troop travel time ----
// Attacks/reinforcements no longer resolve the instant you click. Troops
// spend real time "in flight" between territories, based on the distance
// between them on the map (x/y are 0-100 percentage coordinates). Lower
// TRAVEL_SPEED_PCT_PER_SEC = slower overall movement across the map.
const TRAVEL_SPEED_PCT_PER_SEC = 4;   // map-percent units covered per second
const MIN_TRAVEL_MS = 1500;           // even neighboring territories take at least this long

const BOT_NAMES = ["Bot Red", "Bot Blue", "Bot Green", "Bot Yellow", "Bot Purple", "Bot Orange"];
const PLAYER_COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22"];

const PROTECTION_MS = 45000;   // opening rule: first 45s nobody (human or bot) may attack an owned enemy state

const rooms = {};          // roomId -> gameState
const customLobbies = {};  // code -> { code, hostId, maxPlayers, sockets: [socket,...] }

// ---- Real-world map ----
// x/y are percentage positions (0-100) on an equirectangular world map image
// (0,0 = top-left / 180W,90N ... 100,100 = bottom-right / 180E,90S), so the
// client can plot each country in roughly its real location.
const COUNTRIES = [
  { name: "Canada",       x: 21, y: 19 },
  { name: "USA",          x: 23, y: 28 },
  { name: "Mexico",       x: 22, y: 37 },
  { name: "Colombia",     x: 29, y: 48 },
  { name: "Peru",         x: 29, y: 56 },
  { name: "Brazil",       x: 36, y: 56 },
  { name: "Argentina",    x: 32, y: 69 },
  { name: "UK",           x: 49, y: 20 },
  { name: "France",       x: 51, y: 24 },
  { name: "Germany",      x: 53, y: 22 },
  { name: "Spain",        x: 49, y: 28 },
  { name: "Italy",        x: 53, y: 26 },
  { name: "Poland",       x: 55, y: 21 },
  { name: "Russia",       x: 67, y: 16 },
  { name: "Turkey",       x: 60, y: 28 },
  { name: "Egypt",        x: 58, y: 36 },
  { name: "Libya",        x: 55, y: 35 },
  { name: "Algeria",      x: 51, y: 34 },
  { name: "Nigeria",      x: 52, y: 45 },
  { name: "Sudan",        x: 58, y: 42 },
  { name: "Ethiopia",     x: 61, y: 45 },
  { name: "Kenya",        x: 61, y: 49 },
  { name: "DR Congo",     x: 56, y: 52 },
  { name: "South Africa", x: 57, y: 66 },
  { name: "Saudi Arabia", x: 63, y: 37 },
  { name: "Iran",         x: 65, y: 32 },
  { name: "Pakistan",     x: 69, y: 33 },
  { name: "India",        x: 72, y: 38 },
  { name: "China",        x: 79, y: 31 },
  { name: "Mongolia",     x: 79, y: 24 },
  { name: "Kazakhstan",   x: 69, y: 23 },
  { name: "Japan",        x: 88, y: 30 },
  { name: "Indonesia",    x: 81, y: 51 },
  { name: "Australia",    x: 87, y: 64 }
];

// Real land borders (plus a few short sea crossings, marked, to keep the
// whole map connected/playable - same simplification classic Risk-style
// games make for islands and narrow straits).
const BORDERS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [3, 5], [4, 5], [5, 6],
  [7, 8], [8, 9], [8, 10], [8, 11], [9, 12], [12, 13], [9, 11],
  [10, 17], [11, 16],
  [14, 13], [14, 25],
  [15, 16], [15, 19], [16, 17], [17, 18], [18, 22],
  [19, 20], [19, 22], [20, 21], [21, 22], [22, 23],
  [15, 24], [24, 25], [25, 26], [26, 27], [27, 28],
  [28, 29], [28, 30], [29, 13], [30, 13], [28, 13],
  [31, 28], [31, 13], [27, 32], [32, 33]
];

function makeAdjacency(borders, total) {
  const adj = {};
  for (let i = 0; i < total; i++) adj[i] = [];
  borders.forEach(([a, b]) => {
    adj[a].push(b);
    adj[b].push(a);
  });
  return adj;
}

const TEAM_SIZES = [2, 3];

function clampMaxPlayers(n) {
  n = Number(n) || 4;
  return Math.max(2, Math.min(MAX_PLAYERS, Math.floor(n)));
}

function clampTeamSize(n) {
  n = Number(n);
  return TEAM_SIZES.includes(n) ? n : 2;
}

// For team mode, total players must be an exact multiple of the team size
// (at least 2 teams). Picks the closest valid total to what was requested.
function clampTeamMaxPlayers(requested, teamSize) {
  teamSize = clampTeamSize(teamSize);
  const maxTeams = Math.floor(MAX_PLAYERS / teamSize);
  let numTeams = Math.round((Number(requested) || teamSize * 2) / teamSize);
  numTeams = Math.max(2, Math.min(maxTeams, numTeams));
  return numTeams * teamSize;
}

function clampMode(mode) {
  return mode === "teams" ? "teams" : "ffa";
}

// Chunk players sequentially into teams of teamSize (join order = team order,
// so friends who join a lobby back-to-back land on the same team). In "ffa"
// mode every player is simply their own team of one.
function assignTeams(ids, mode, teamSize) {
  const teamOf = {};
  ids.forEach((id, i) => {
    teamOf[id] = mode === "teams" ? Math.floor(i / teamSize) : i;
  });
  return teamOf;
}

function createGame(roomId, humanSockets, maxPlayers, mode, teamSize, difficulty) {
  mode = clampMode(mode);
  teamSize = clampTeamSize(teamSize);
  const totalSlots =
    mode === "teams"
      ? clampTeamMaxPlayers(maxPlayers || humanSockets.length || teamSize * 2, teamSize)
      : clampMaxPlayers(maxPlayers || humanSockets.length || 4);
  const total = COUNTRIES.length;
  const adjacency = makeAdjacency(BORDERS, total);

  const owners = {}; // territoryId -> playerId (or null)
  const troops = {}; // territoryId -> count

  for (let i = 0; i < total; i++) {
    owners[i] = null;
    troops[i] = Math.floor(Math.random() * 91) + 30; // neutral starting troops: 30-120 (needed to occupy a state the first time)
  }

  // build player list: humans + bots to fill up to totalSlots
  const players = {};
  humanSockets.forEach((s, i) => {
    players[s.id] = {
      id: s.id,
      name: s.displayName || `Player ${i + 1}`,
      isBot: false,
      alive: true
    };
  });
  for (let i = humanSockets.length; i < totalSlots; i++) {
    const botId = `bot-${roomId}-${i}`;
    players[botId] = {
      id: botId,
      name: BOT_NAMES[i],
      isBot: true,
      alive: true
    };
  }

  // assign teams (join order) then a color per team (ffa = color per player,
  // teams mode = teammates share a color so they read as one force on the map)
  const ids = Object.keys(players);
  const teamOf = assignTeams(ids, mode, teamSize);
  ids.forEach((pid, i) => {
    const team = teamOf[pid];
    players[pid].team = team;
    players[pid].color = PLAYER_COLORS[(mode === "teams" ? team : i) % PLAYER_COLORS.length];
  });

  // corner spawns: each player (or each team) starts in its own corner, as far from the others as possible
  pickCornerSpawns(ids, players, mode).forEach((tId, pid) => { owners[tId] = pid; troops[tId] = 10; });

  const game = {
    roomId,
    countries: COUNTRIES,
    adjacency,
    owners,
    troops,
    players,
    mode,
    teamSize,
    difficulty: ["easy", "normal", "hard"].includes(difficulty) ? difficulty : "normal",
    startedAt: Date.now(),
    botMem: {},
    interval: null,
    pendingMoves: [],  // troops currently in transit: {fromId, toId, sendAmount, attackerOwner, arrivalAt}
    tradeOffers: {}    // offerId -> { offerId, from, to, give, get, ts } (pending state-trade offers)
  };

  rooms[roomId] = game;
  return game;
}

function serializeState(game) {
  return {
    countries: game.countries,
    adjacency: game.adjacency,
    owners: game.owners,
    troops: game.troops,
    players: game.players,
    mode: game.mode
  };
}

function checkGameOver(game) {
  const ownerSet = new Set(Object.values(game.owners).filter(Boolean));
  // mark players with no territories as dead
  Object.values(game.players).forEach((p) => {
    if (!ownerSet.has(p.id)) p.alive = false;
  });
  const aliveTeams = new Set([...ownerSet].map((pid) => game.players[pid].team));
  if (aliveTeams.size === 1) {
    const winningTeam = [...aliveTeams][0];
    const winners = Object.values(game.players).filter((p) => p.team === winningTeam);
    return { team: winningTeam, winners }; // winners = every player on the winning team
  }
  return null;
}

// ---------------------------------------------------------------------
// Opening rule + corner spawns + human-like bot AI
// ---------------------------------------------------------------------
function canAttackNow(game, attackerId, toId) {
  const targetOwner = game.owners[toId];
  if (!targetOwner || targetOwner === attackerId) return true;            // unoccupied or own state
  const a = game.players[attackerId], t = game.players[targetOwner];
  if (a && t && a.team === t.team) return true;                           // teammate = reinforce
  return Date.now() - game.startedAt >= PROTECTION_MS;                    // enemy: only after 45s
}

// Returns Map(playerId -> territoryId). FFA: one corner per player. Teams: one corner per team,
// teammates take the nearest free states to their team's corner.
function pickCornerSpawns(ids, players, mode) {
  const xs = COUNTRIES.map((c) => c.x), ys = COUNTRIES.map((c) => c.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), mx = (x0 + x1) / 2;
  const groups = {};
  ids.forEach((pid) => { const k = mode === "teams" ? players[pid].team : pid; (groups[k] = groups[k] || []).push(pid); });
  const keys = Object.keys(groups).sort(() => Math.random() - 0.5);
  const spots = [[x0, y0], [x1, y1], [x1, y0], [x0, y1], [mx, y0], [mx, y1]].slice(0, keys.length);
  const used = new Set(), out = new Map();
  keys.forEach((k, i) => {
    const order = COUNTRIES.map((c, id) => id).filter((id) => !used.has(id))
      .sort((p, q) => Math.hypot(COUNTRIES[p].x - spots[i][0], COUNTRIES[p].y - spots[i][1]) - Math.hypot(COUNTRIES[q].x - spots[i][0], COUNTRIES[q].y - spots[i][1]));
    groups[k].forEach((pid, j) => { used.add(order[j]); out.set(pid, order[j]); });
  });
  return out;
}

const BOT_LEVELS = {
  easy:   { think: [2500, 4500], send: 0.5,  aggression: 0.35, mistakes: 0.30, neutralBias: 1.0, margin: 1.25 },
  normal: { think: [1200, 2500], send: 0.7,  aggression: 0.65, mistakes: 0.10, neutralBias: 0.6, margin: 1.15 },
  hard:   { think: [500, 1200],  send: 0.75, aggression: 0.95, mistakes: 0.02, neutralBias: 0.3, margin: 1.08 }
};
const rnd = (a, b) => a + Math.random() * (b - a);
const dist2 = (game, a, b) => Math.hypot(game.countries[a].x - game.countries[b].x, game.countries[a].y - game.countries[b].y);

// Human-like bot: reacts with a delay, expands into empty states early, picks targets it can actually
// beat (weak + close + valuable), defends threatened states, finishes off weak players, and makes the
// occasional mistake on lower difficulties. Called through resolveAttack, so the 45s rule applies to it too.
function botTakeTurn(game, botId) {
  const L = BOT_LEVELS[game.difficulty] || BOT_LEVELS.normal, now = Date.now();
  const mem = (game.botMem[botId] = game.botMem[botId] || { nextAt: 0, last: {} });
  if (now < mem.nextAt) return;
  mem.nextAt = now + rnd(L.think[0], L.think[1]);

  const me = game.players[botId];
  const ids = Object.keys(game.owners).map(Number);
  const isFriend = (o) => o && game.players[o] && game.players[o].team === me.team;
  const mine = ids.filter((i) => game.owners[i] === botId);
  if (!mine.length) return;
  const T = (i) => game.troops[i] || 0;
  const enemies = ids.filter((i) => game.owners[i] && !isFriend(game.owners[i]));
  const neutrals = ids.filter((i) => !game.owners[i]);
  const sources = mine.filter((i) => T(i) >= 8 && now - (mem.last[i] || 0) > 3500).sort((a, b) => T(b) - T(a)).slice(0, 5);
  if (!sources.length) return;
  const protectedPhase = now - game.startedAt < PROTECTION_MS;

  // 1) defend: a state of mine that a nearby enemy could take gets reinforced by a safer one
  if (!protectedPhase && Math.random() > L.mistakes) {
    const weak = mine.find((i) => enemies.some((e) => T(e) * 0.7 > T(i) && dist2(game, e, i) < 25));
    const helper = weak !== undefined && sources.find((s) => s !== weak && !enemies.some((e) => T(e) * 0.7 > T(s) * 0.6 && dist2(game, e, s) < 25));
    if (helper !== undefined && helper !== false) { mem.last[helper] = now; return resolveAttack(game, helper, weak, Math.floor(T(helper) * 0.5)); }
  }

  // 2) attack: best (source, target) pair by score. Empty states are the main target early on;
  //    owned enemy states only become options once protection ends (resolveAttack also enforces it).
  const preferEnemy = !protectedPhase && Math.random() < L.aggression;
  const pool = protectedPhase ? neutrals : (preferEnemy ? enemies.concat(neutrals) : neutrals.concat(enemies));
  let best = null, bestScore = -Infinity;
  for (const src of sources) {
    for (const t of pool) {
      if (isFriend(game.owners[t])) continue;
      const need = Math.ceil(T(t) * L.margin) + 2;
      if (T(src) - 1 < need) continue;                          // can't win it yet - never suicide
      const d = dist2(game, src, t);
      let score = -need * 0.15 - d / 6;                         // cheap and close is good
      if (game.owners[t]) {
        score += 5 * (0.5 + L.aggression);                      // players are worth more than empty land
        const left = ids.filter((i) => game.owners[i] === game.owners[t]).length;
        if (left <= 2) score += 8;                              // finish off a nearly-dead player
      } else score += 3 * (1 - L.neutralBias) + 2;
      score += Math.random() * L.mistakes * 25;                 // human-like imperfection
      if (score > bestScore) { bestScore = score; best = { src, t, need }; }
    }
  }
  if (!best) return;                                            // nothing winnable yet: wait and grow
  mem.last[best.src] = now;
  const amount = Math.min(T(best.src) - 1, Math.max(Math.floor(T(best.src) * L.send), best.need));
  resolveAttack(game, best.src, best.t, amount);
}

// Straight-line distance between two territories using their 0-100 map
// percentage coordinates, converted into a travel duration in ms.
function travelTimeMs(game, fromId, toId) {
  const a = game.countries[fromId];
  const b = game.countries[toId];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  return Math.max(MIN_TRAVEL_MS, (dist / TRAVEL_SPEED_PCT_PER_SEC) * 1000);
}

function resolveAttack(game, fromId, toId, sendAmount) {
  fromId = Number(fromId);
  toId = Number(toId);
  const attackerOwner = game.owners[fromId];
  if (!attackerOwner) return;
  if (!canAttackNow(game, attackerOwner, toId)) return;   // opening rule applies to everyone
  // Border restriction removed: any territory can now attack/reinforce
  // any other territory anywhere on the map, not just adjacent ones.

  sendAmount = Math.min(sendAmount, game.troops[fromId] - 1);
  if (sendAmount <= 0) return;

  // Troops leave the source territory immediately (so they can't be spent
  // twice), but no longer land instantly - they travel for a duration based
  // on real distance, and the attack/reinforce effect only applies on arrival.
  game.troops[fromId] -= sendAmount;

  const duration = travelTimeMs(game, fromId, toId);
  const arrivalAt = Date.now() + duration;

  game.pendingMoves.push({ fromId, toId, sendAmount, attackerOwner, arrivalAt });

  // Let every client in the room animate this move (marching dots), even
  // players who didn't trigger it themselves (other humans, bot moves).
  // Sending the real duration lets the client animate the full flight time
  // instead of a fixed-length animation.
  io.to(game.roomId).emit("troopMove", {
    from: fromId,
    to: toId,
    amount: sendAmount,
    owner: attackerOwner,
    duration
  });
}

// Called when an in-flight move's travel time has elapsed. Whether it's a
// reinforcement or an attack is decided at arrival (not at launch), since
// the target's owner may have changed while the troops were en route.
function applyArrival(game, move) {
  const { fromId, toId, sendAmount, attackerOwner } = move;
  const targetOwner = game.owners[toId];
  const attackerTeam = game.players[attackerOwner]?.team;
  const targetTeam = targetOwner ? game.players[targetOwner]?.team : null;
  const wasReinforce = !!targetOwner && targetTeam === attackerTeam;

  // Opening rule: if the target was captured by an enemy while the troops were in flight and protection
  // is still on, the troops turn back instead of attacking a player.
  if (targetOwner && !wasReinforce && Date.now() - game.startedAt < PROTECTION_MS) {
    if (game.owners[fromId] === attackerOwner) game.troops[fromId] = Math.min(MAX_TROOPS, game.troops[fromId] + sendAmount);
    return;
  }

  if (wasReinforce) {
    game.troops[toId] = Math.min(MAX_TROOPS, game.troops[toId] + sendAmount);
  } else {
    if (sendAmount > game.troops[toId]) {
      game.owners[toId] = attackerOwner;
      game.troops[toId] = sendAmount - game.troops[toId];
    } else {
      game.troops[toId] -= sendAmount;
    }
  }

  io.to(game.roomId).emit("troopArrived", {
    from: fromId,
    to: toId,
    amount: sendAmount,
    owner: attackerOwner,
    reinforce: wasReinforce
  });
}

// Resolves any in-flight moves whose travel time has elapsed.
function processArrivals(game) {
  if (!game.pendingMoves.length) return;
  const now = Date.now();
  const arrived = game.pendingMoves.filter((m) => m.arrivalAt <= now);
  if (!arrived.length) return;
  game.pendingMoves = game.pendingMoves.filter((m) => m.arrivalAt > now);
  arrived.forEach((m) => applyArrival(game, m));
}

function startGameLoop(game) {
  game.interval = setInterval(() => {
    // growth phase
    for (const tId in game.troops) {
      if (game.owners[tId]) {
        game.troops[tId] = Math.min(MAX_TROOPS, game.troops[tId] + GROWTH_PER_TICK);
      }
    }

    // bot AI phase
    Object.values(game.players).forEach((p) => {
      if (p.isBot && p.alive) {
        botTakeTurn(game, p.id);
      }
    });

    // resolve any troops that have finished traveling this tick
    processArrivals(game);

    const result = checkGameOver(game);
    io.to(game.roomId).emit("gameState", serializeState(game));

    if (result) {
      io.to(game.roomId).emit("gameOver", {
        winners: result.winners.map((p) => p.id),
        names: result.winners.map((p) => p.name),
        teamMode: game.mode === "teams"
      });
      clearInterval(game.interval);
      delete rooms[game.roomId];
    }
  }, TICK_MS);
}

function launchGame(roomId, humanSockets, maxPlayers, mode, teamSize, difficulty) {
  humanSockets.forEach((s) => s.join(roomId));
  const game = createGame(roomId, humanSockets, maxPlayers, mode, teamSize, difficulty);
  humanSockets.forEach((s) => {
    s.emit("matchFound", { roomId, playerId: s.id, state: serializeState(game) });
  });
  startGameLoop(game);
  return game;
}

// ---------------------------------------------------------------------
// Quick matchmaking queue - waits briefly for others, then fills with bots
// ---------------------------------------------------------------------
let queue = [];
let queueTimer = null;
let queueMaxPlayers = 4;
let queueDifficulty = "normal";

function startMatch() {
  const humans = queue.splice(0, queueMaxPlayers);
  queue = [];
  const roomId = `room-${Date.now()}`;
  launchGame(roomId, humans, queueMaxPlayers, undefined, undefined, queueDifficulty);
}

// ---------------------------------------------------------------------
// Custom match lobbies - host picks player count (2-6), gets a short
// shareable code, friends join with the code, host starts whenever ready
// (remaining open slots get filled with bots).
// ---------------------------------------------------------------------
function generateLobbyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (customLobbies[code]);
  return code;
}

function lobbySummary(lobby) {
  return {
    code: lobby.code,
    maxPlayers: lobby.maxPlayers,
    mode: lobby.mode,
    teamSize: lobby.teamSize,
    hostId: lobby.hostId,
    players: lobby.sockets.map((s) => ({ id: s.id, name: s.displayName || "Player" }))
  };
}

function broadcastLobby(lobby) {
  io.to(`lobby-${lobby.code}`).emit("customLobbyUpdate", lobbySummary(lobby));
}

function removeSocketFromLobby(socket) {
  const code = socket.customLobbyCode;
  if (!code) return;
  const lobby = customLobbies[code];
  if (!lobby) return;

  lobby.sockets = lobby.sockets.filter((s) => s.id !== socket.id);
  socket.leave(`lobby-${code}`);
  socket.customLobbyCode = null;

  if (lobby.sockets.length === 0) {
    delete customLobbies[code];
    return;
  }
  if (lobby.hostId === socket.id) {
    lobby.hostId = lobby.sockets[0].id; // hand off host to next player
  }
  broadcastLobby(lobby);
}

io.on("connection", (socket) => {
  // ---- Quick match (Play Online) ----
  socket.on("findMatch", ({ soloMode, displayName, maxPlayers, difficulty }) => {
    socket.displayName = (displayName || "Player").toString().slice(0, 24);

    if (soloMode) {
      const roomId = `room-${Date.now()}-${socket.id}`;
      launchGame(roomId, [socket], clampMaxPlayers(maxPlayers || 4), undefined, undefined, difficulty);
      return;
    }

    // all quick-match players in the current queue must share one room size;
    // the first player in an empty queue sets it for that match
    if (queue.length === 0) {
      queueMaxPlayers = clampMaxPlayers(maxPlayers || 4);
      queueDifficulty = difficulty;
    }

    queue.push(socket);
    socket.emit("waiting", { current: queue.length, needed: queueMaxPlayers });

    if (queue.length >= queueMaxPlayers) {
      clearTimeout(queueTimer);
      queueTimer = null;
      startMatch();
    } else if (!queueTimer) {
      // wait up to 10s for more players, then fill rest with bots
      queueTimer = setTimeout(() => {
        queueTimer = null;
        if (queue.length > 0) startMatch();
      }, QUICK_MATCH_WAIT_MS);
    }
  });

  // ---- Custom match: create a private lobby with a shareable code ----
  socket.on("createCustomMatch", ({ displayName, maxPlayers, mode, teamSize }) => {
    socket.displayName = (displayName || "Player").toString().slice(0, 24);
    removeSocketFromLobby(socket); // in case they were already in one

    const code = generateLobbyCode();
    const lobbyMode = clampMode(mode);
    const lobbyTeamSize = clampTeamSize(teamSize);
    const lobby = {
      code,
      hostId: socket.id,
      mode: lobbyMode,
      teamSize: lobbyTeamSize,
      maxPlayers:
        lobbyMode === "teams"
          ? clampTeamMaxPlayers(maxPlayers, lobbyTeamSize)
          : clampMaxPlayers(maxPlayers || 4),
      sockets: [socket]
    };
    customLobbies[code] = lobby;
    socket.customLobbyCode = code;
    socket.join(`lobby-${code}`);

    socket.emit("customMatchCreated", lobbySummary(lobby));
  });

  // ---- Custom match: join an existing lobby by code ----
  socket.on("joinCustomMatch", ({ code, displayName }) => {
    socket.displayName = (displayName || "Player").toString().slice(0, 24);
    code = (code || "").toString().trim().toUpperCase();
    const lobby = customLobbies[code];

    if (!lobby) {
      socket.emit("customMatchError", { message: "No match found with that code." });
      return;
    }
    if (lobby.sockets.find((s) => s.id === socket.id)) return; // already in it
    if (lobby.sockets.length >= lobby.maxPlayers) {
      socket.emit("customMatchError", { message: "That match is already full." });
      return;
    }

    removeSocketFromLobby(socket); // leave any previous lobby first
    lobby.sockets.push(socket);
    socket.customLobbyCode = code;
    socket.join(`lobby-${code}`);

    broadcastLobby(lobby);
  });

  // ---- Custom match: host starts the game (fills remaining slots with bots) ----
  socket.on("startCustomMatch", ({ code }) => {
    code = (code || "").toString().trim().toUpperCase();
    const lobby = customLobbies[code];
    if (!lobby) return;
    if (lobby.hostId !== socket.id) {
      socket.emit("customMatchError", { message: "Only the host can start the match." });
      return;
    }

    const humans = lobby.sockets.slice();
    humans.forEach((s) => { s.customLobbyCode = null; s.leave(`lobby-${code}`); });
    delete customLobbies[code];

    launchGame(`room-${code}-${Date.now()}`, humans, lobby.maxPlayers, lobby.mode, lobby.teamSize);
  });

  socket.on("leaveCustomMatch", () => {
    removeSocketFromLobby(socket);
  });

  // ---- Player voluntarily leaves an in-progress game (stays connected) ----
  socket.on("leaveGame", ({ roomId }) => {
    const game = rooms[roomId];
    if (!game || !game.players[socket.id]) return;

    // release their territories to neutral, same treatment as a disconnect,
    // but the game keeps running for everyone else
    for (const tId in game.owners) {
      if (game.owners[tId] === socket.id) game.owners[tId] = null;
    }
    game.players[socket.id].alive = false;
    socket.leave(roomId);

    const result = checkGameOver(game);
    io.to(roomId).emit("gameState", serializeState(game));
    if (result) {
      io.to(roomId).emit("gameOver", {
        winners: result.winners.map((p) => p.id),
        names: result.winners.map((p) => p.name),
        teamMode: game.mode === "teams"
      });
      clearInterval(game.interval);
      delete rooms[roomId];
    }
  });

  // ---- In-game attack/reinforce ----
  socket.on("attack", ({ roomId, from, to, amount }) => {
    const game = rooms[roomId];
    if (!game) return;
    if (game.owners[from] !== socket.id) return;
    resolveAttack(game, from, to, amount);
  });

  // ---- State trading ----
  // A trade really swaps ownership on the server: the traded states change
  // owner immediately (colour, attack authority, reinforce/attack rules and
  // rocket colour all follow the new owner) and the troops stay on each state.
  const TRADE_TTL_MS = 25000;
  const toIdList = (a) => (Array.isArray(a) ? a : a ? Object.values(a) : []).map(Number).filter((n) => Number.isInteger(n));

  socket.on("tradeOffer", ({ roomId, offerId, from, to, give, get }) => {
    const game = rooms[roomId];
    if (!game || !offerId || from !== socket.id) return;
    if (!game.players[from] || !game.players[to] || from === to) return;
    game.tradeOffers[offerId] = { offerId, from, to, give: toIdList(give), get: toIdList(get), ts: Date.now() };
    // drop stale offers so the table can't grow forever
    for (const id in game.tradeOffers) {
      if (Date.now() - game.tradeOffers[id].ts > TRADE_TTL_MS * 2) delete game.tradeOffers[id];
    }
  });

  socket.on("tradeResponse", ({ roomId, offerId, accept }) => {
    const game = rooms[roomId];
    if (!game) return;
    const offer = game.tradeOffers[offerId];
    if (!offer) {
      if (accept) socket.emit("tradeResult", { offerId, accepted: false, reason: "The offer is no longer available." });
      return;
    }
    // only the receiver may accept - or the offerer, on behalf of a bot receiver
    const receiver = game.players[offer.to];
    const allowed = socket.id === offer.to || (receiver && receiver.isBot && socket.id === offer.from);
    if (!allowed) return;
    delete game.tradeOffers[offerId];
    if (!accept) return;

    const fail = (reason) => {
      socket.emit("tradeResult", { offerId, accepted: false, reason });
      const other = socket.id === offer.from ? offer.to : offer.from;
      io.to(other).emit("tradeResult", { offerId, accepted: false, reason });
    };
    if (Date.now() - offer.ts > TRADE_TTL_MS) return fail("The offer expired.");
    if (offer.give.some((t) => game.owners[t] !== offer.from) || offer.get.some((t) => game.owners[t] !== offer.to)) {
      return fail("The states changed hands - offer no longer valid.");
    }
    if (!offer.give.length && !offer.get.length) return fail("Empty offer.");
    const count = (pid) => Object.values(game.owners).filter((o) => o === pid).length;
    if (count(offer.from) - offer.give.length + offer.get.length < 1 ||
        count(offer.to) - offer.get.length + offer.give.length < 1) {
      return fail("A player must keep at least one state.");
    }

    // Swap ownership for real. The troops that are standing on each state go
    // with it to the new owner, who can now command that state (attack from it,
    // reinforce it) - and enemies attacking it now fight those troops.
    offer.give.forEach((t) => { game.owners[t] = offer.to; });
    offer.get.forEach((t) => { game.owners[t] = offer.from; });
    io.to(roomId).emit("gameState", serializeState(game));
    io.to(roomId).emit("tradeResult", {
      offerId, accepted: true,
      from: offer.from, to: offer.to, give: offer.give, get: offer.get
    });
  });

  socket.on("disconnect", () => {
    queue = queue.filter((s) => s.id !== socket.id);
    removeSocketFromLobby(socket);

    for (const roomId in rooms) {
      const game = rooms[roomId];
      if (game.players[socket.id]) {
        // release their territories to neutral instead of ending the game
        for (const tId in game.owners) {
          if (game.owners[tId] === socket.id) game.owners[tId] = null;
        }
        if (game.players[socket.id]) game.players[socket.id].alive = false;
      }
    }
  });
});

// Open https://YOUR-SERVER-URL/version in a browser to confirm which server.js Render is running
app.get("/version", (req, res) => res.send("State Conquest server - authoritative trades v2 + neutral troops 30-120 + corner spawns + 45s protection + smart bots"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`State Conquest server running on port ${PORT}`));