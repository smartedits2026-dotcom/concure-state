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
const BOT_NAMES = ["Bot Red", "Bot Blue", "Bot Green", "Bot Yellow"];
const PLAYER_COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f"];

const rooms = {}; // roomId -> gameState

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

function createGame(roomId, humanSockets) {
  const totalSlots = 4;
  const total = COUNTRIES.length;
  const adjacency = makeAdjacency(BORDERS, total);

  const owners = {}; // territoryId -> playerId (or null)
  const troops = {}; // territoryId -> count

  for (let i = 0; i < total; i++) {
    owners[i] = null;
    troops[i] = Math.floor(Math.random() * 3) + 1; // neutral starting troops
  }

  // build player list: humans + bots to fill up to 4
  const players = {};
  humanSockets.forEach((s, i) => {
    players[s.id] = {
      id: s.id,
      name: s.displayName || `Player ${i + 1}`,
      color: PLAYER_COLORS[i],
      isBot: false,
      alive: true
    };
  });
  for (let i = humanSockets.length; i < totalSlots; i++) {
    const botId = `bot-${roomId}-${i}`;
    players[botId] = {
      id: botId,
      name: BOT_NAMES[i],
      color: PLAYER_COLORS[i],
      isBot: true,
      alive: true
    };
  }

  // assign each player a random starting territory
  const ids = Object.keys(players);
  const freeTerritories = Array.from({ length: total }, (_, i) => i);
  ids.forEach((pid) => {
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
    players: game.players
  };
}

function checkGameOver(game) {
  const ownerSet = new Set(Object.values(game.owners).filter(Boolean));
  // mark players with no territories as dead
  Object.values(game.players).forEach((p) => {
    if (!ownerSet.has(p.id)) p.alive = false;
  });
  const aliveOwners = [...ownerSet];
  if (aliveOwners.length === 1) {
    return aliveOwners[0]; // winner playerId
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
  const neighbors = game.adjacency[from] || [];
  const targets = neighbors.filter((n) => game.owners[n] !== botId);
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
  if (!game.adjacency[fromId].includes(toId)) return;

  sendAmount = Math.min(sendAmount, game.troops[fromId] - 1);
  if (sendAmount <= 0) return;

  game.troops[fromId] -= sendAmount;

  if (game.owners[toId] === attackerOwner) {
    // reinforce own/ally territory
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

    const winner = checkGameOver(game);
    io.to(game.roomId).emit("gameState", serializeState(game));

    if (winner) {
      io.to(game.roomId).emit("gameOver", { winner, name: game.players[winner]?.name });
      clearInterval(game.interval);
      delete rooms[game.roomId];
    }
  }, TICK_MS);
}

// matchmaking queue - waits briefly for others, then fills with bots
let queue = [];
let queueTimer = null;

function startMatch() {
  const humans = queue.splice(0, 4);
  queue = [];
  const roomId = `room-${Date.now()}`;
  humans.forEach((s) => s.join(roomId));

  const game = createGame(roomId, humans);

  humans.forEach((s) => {
    s.emit("matchFound", { roomId, playerId: s.id, state: serializeState(game) });
  });

  startGameLoop(game);
}

io.on("connection", (socket) => {
  socket.on("findMatch", ({ soloMode, displayName }) => {
    socket.displayName = (displayName || "Player").toString().slice(0, 24);
    if (soloMode) {
      const roomId = `room-${Date.now()}-${socket.id}`;
      socket.join(roomId);
      const game = createGame(roomId, [socket]);
      socket.emit("matchFound", { roomId, playerId: socket.id, state: serializeState(game) });
      startGameLoop(game);
      return;
    }

    queue.push(socket);
    socket.emit("waiting");

    if (queue.length >= 4) {
      clearTimeout(queueTimer);
      startMatch();
    } else if (!queueTimer) {
      // wait up to 10s for more players, then fill rest with bots
      queueTimer = setTimeout(() => {
        queueTimer = null;
        if (queue.length > 0) startMatch();
      }, 10000);
    }
  });

  socket.on("attack", ({ roomId, from, to, amount }) => {
    const game = rooms[roomId];
    if (!game) return;
    if (game.owners[from] !== socket.id) return;
    resolveAttack(game, from, to, amount);
  });

  socket.on("disconnect", () => {
    queue = queue.filter((s) => s.id !== socket.id);
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
