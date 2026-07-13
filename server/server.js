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
const MAP_COLS = 6;
const MAP_ROWS = 5;
const BOT_NAMES = ["Bot Red", "Bot Blue", "Bot Green", "Bot Yellow"];
const PLAYER_COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f"];

const rooms = {}; // roomId -> gameState

function makeAdjacency(cols, rows) {
  // simple grid adjacency (4-directional)
  const adj = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      adj[id] = [];
      if (c > 0) adj[id].push(id - 1);
      if (c < cols - 1) adj[id].push(id + 1);
      if (r > 0) adj[id].push(id - cols);
      if (r < rows - 1) adj[id].push(id + cols);
    }
  }
  return adj;
}

function createGame(roomId, humanSockets) {
  const totalSlots = 4;
  const cols = MAP_COLS, rows = MAP_ROWS;
  const total = cols * rows;
  const adjacency = makeAdjacency(cols, rows);

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
    cols,
    rows,
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
    cols: game.cols,
    rows: game.rows,
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
