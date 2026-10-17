// LITEHORROR multiplayer server (houses, spawns, 9-player cap, player sync)
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const MAX_PLAYERS = 9;   // players per house
const SPAWN_COUNT = 3;   // spawn points per house
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, transports: ['websocket', 'polling'] });

// Serves the newest LITEHORRORVn.html in /public, so new versions need no code changes.
function latestGame() {
  const files = fs.readdirSync(path.join(__dirname, 'public'))
    .filter(f => /^LITEHORRORV\d+\.html$/.test(f));
  if (files.length === 0) return null;
  files.sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  return files[files.length - 1];
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const file = latestGame();
  if (!file) return res.status(404).send('No LITEHORROR game file found in public/');
  res.sendFile(path.join(__dirname, 'public', file));
});
app.get('/health', (req, res) => res.send('ok'));

const houses = [];
let nextHouseId = 1;

function newHouse() {
  const h = { id: nextHouseId++, seed: Math.floor(Math.random() * 1e9), players: new Map() };
  houses.push(h);
  return h;
}
// Join the first house with room, otherwise open a new one.
function findHouse() {
  return houses.find(h => h.players.size < MAX_PLAYERS) || newHouse();
}
// Put the new player at the least crowded spawn point.
function pickSpawn(h) {
  const counts = new Array(SPAWN_COUNT).fill(0);
  for (const p of h.players.values()) counts[p.spawn]++;
  let best = 0;
  for (let i = 1; i < SPAWN_COUNT; i++) if (counts[i] < counts[best]) best = i;
  return best;
}

// Sends the house's scoreboard (most zombies killed first) to everyone in it.
function broadcastScores(h) {
  const list = [...h.players.values()]
    .map(p => ({ id: p.id, name: p.name, kills: p.kills }))
    .sort((a, b) => b.kills - a.kills);
  io.to('house' + h.id).emit('scores', list);
}

io.on('connection', socket => {
  let house = null;
  const room = () => 'house' + house.id;

  socket.on('join', name => {
    if (house) return;
    house = findHouse();
    const spawn = pickSpawn(house);
    const me = { id: socket.id, name: String(name || 'Player').slice(0, 16), spawn, x: 0, z: 0, yaw: 0, kills: 0 };
    house.players.set(socket.id, me);
    socket.join(room());
    socket.emit('joined', {
      houseId: house.id, seed: house.seed, spawn,
      max: MAX_PLAYERS, players: [...house.players.values()]
    });
    socket.to(room()).emit('playerJoined', me);
    broadcastScores(house);
  });

  socket.on('move', d => {
    if (!house) return;
    const p = house.players.get(socket.id);
    if (!p) return;
    p.x = Number(d.x) || 0; p.z = Number(d.z) || 0; p.yaw = Number(d.yaw) || 0;
    socket.to(room()).volatile.emit('moved', { id: socket.id, x: p.x, z: p.z, yaw: p.yaw });
  });

  socket.on('kill', () => {
    if (!house) return;
    const p = house.players.get(socket.id);
    if (!p) return;
    p.kills++;
    broadcastScores(house);
  });

  socket.on('setSkin', url => {
    if (!house) return;
    const p = house.players.get(socket.id);
    if (!p) return;
    p.skin = (typeof url === 'string' && url.startsWith('data:image/') && url.length < 120000) ? url : null;
    socket.to(room()).emit('skin', { id: socket.id, skin: p.skin });
  });

  socket.on('disconnect', () => {
    if (!house) return;
    house.players.delete(socket.id);
    io.to(room()).emit('playerLeft', socket.id);
    broadcastScores(house);
    if (house.players.size === 0) houses.splice(houses.indexOf(house), 1);
  });
});

server.listen(PORT, () => console.log('LITEHORROR server on port ' + PORT));
