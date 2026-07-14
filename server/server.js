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

const BOT_NAMES = ["Bot Red", "Bot Blue", "Bot Green", "Bot Yellow", "Bot Purple", "Bot Orange"];
const PLAYER_COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22"];

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

function createGame(roomId, humanSockets, maxPlayers, mode, teamSize) {
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
    troops[i] = Math.floor(Math.random() * 3) + 1; // neutral starting troops
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

  // assign each player a random starting territory
  const freeTerritories = Array.from({ length: total }, (_, i) => i);
  ids.forEach((pid) => {
    if (freeTerritories.length === 0) return;
    const idx = Math.floor(Math.random() * freeTerritories.length);
    const tId = freeTerritories.splice(idx, 1)[0];
    owners[tId] = pid;
    troops[tId] = 10;
  });

  const game = {
    roomId,
    countries: COUNTRIES,
    adjacency,
    owners,
    troops,
    players,
    mode,
    teamSize,
    interval: null
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

function botTakeTurn(game, botId) {
  // very simple AI: pick a territory it owns with troops > 3,
  // attack the weakest adjacent non-owned territory
  const owned = Object.keys(game.owners).filter(
    (t) => game.owners[t] === botId && game.troops[t] > 3
  );
  if (owned.length === 0) return;

  const from = owned[Math.floor(Math.random() * owned.length)];
  const allTerritories = Object.keys(game.troops).map(Number).filter((t) => t !== Number(from));
  const botTeam = game.players[botId].team;
  // never attack a teammate's territory - only unowned or enemy-team ones
  // (borders no longer restrict targets - bots can pick anywhere on the map)
  const targets = allTerritories.filter((n) => {
    const o = game.owners[n];
    return !o || game.players[o].team !== botTeam;
  });
  if (targets.length === 0) return;

  // attack weakest target
  targets.sort((a, b) => game.troops[a] - game.troops[b]);
  const to = targets[0];
  resolveAttack(game, from, to, Math.floor(game.troops[from] * 0.7));
}

function resolveAttack(game, fromId, toId, sendAmount) {
  fromId = Number(fromId);
  toId = Number(toId);
  const attackerOwner = game.owners[fromId];
  if (!attackerOwner) return;
  // Border restriction removed: any territory can now attack/reinforce
  // any other territory anywhere on the map, not just adjacent ones.

  sendAmount = Math.min(sendAmount, game.troops[fromId] - 1);
  if (sendAmount <= 0) return;

  game.troops[fromId] -= sendAmount;
  const targetOwner = game.owners[toId];
  const attackerTeam = game.players[attackerOwner]?.team;
  const targetTeam = targetOwner ? game.players[targetOwner]?.team : null;
  // sending troops onto your own OR a teammate's territory reinforces it
  // instead of attacking - teammates never fight each other
  const wasReinforce = !!targetOwner && targetTeam === attackerTeam;

  if (wasReinforce) {
    // reinforce own/ally territory (troops are credited to whoever owns it)
    game.troops[toId] = Math.min(MAX_TROOPS, game.troops[toId] + sendAmount);
  } else {
    // attack
    if (sendAmount > game.troops[toId]) {
      game.owners[toId] = attackerOwner;
      game.troops[toId] = sendAmount - game.troops[toId];
    } else {
      game.troops[toId] -= sendAmount;
    }
  }

  // Let every client in the room animate this move (marching dots), even
  // players who didn't trigger it themselves (other humans, bot moves).
  io.to(game.roomId).emit("troopMove", {
    from: fromId,
    to: toId,
    amount: sendAmount,
    owner: attackerOwner,
    reinforce: wasReinforce
  });
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
      if (p.isBot && p.alive && Math.random() < 0.5) {
        botTakeTurn(game, p.id);
      }
    });

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

function launchGame(roomId, humanSockets, maxPlayers, mode, teamSize) {
  humanSockets.forEach((s) => s.join(roomId));
  const game = createGame(roomId, humanSockets, maxPlayers, mode, teamSize);
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

function startMatch() {
  const humans = queue.splice(0, queueMaxPlayers);
  queue = [];
  const roomId = `room-${Date.now()}`;
  launchGame(roomId, humans, queueMaxPlayers);
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
  socket.on("findMatch", ({ soloMode, displayName, maxPlayers }) => {
    socket.displayName = (displayName || "Player").toString().slice(0, 24);

    if (soloMode) {
      const roomId = `room-${Date.now()}-${socket.id}`;
      launchGame(roomId, [socket], clampMaxPlayers(maxPlayers || 4));
      return;
    }

    // all quick-match players in the current queue must share one room size;
    // the first player in an empty queue sets it for that match
    if (queue.length === 0) {
      queueMaxPlayers = clampMaxPlayers(maxPlayers || 4);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`State Conquest server running on port ${PORT}`));
