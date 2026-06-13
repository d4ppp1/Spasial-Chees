const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const games = {};

function randCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

// POST /api/create — admin creates game
app.post('/api/create', (req, res) => {
  const { name } = req.body;
  let code;
  do { code = randCode(); } while (games[code]);
  games[code] = {
    code,
    name: name || 'Spasial Chess',
    status: 'lobby',
    round: 1,
    correctAnswer: null,
    players: [],
    answers: [],
    rejoinRequests: [],   // { name, team, timestamp }
    kickedPlayers: []     // { name, team } — track who was kicked/left
  };
  res.json({ success: true, code });
});

// GET /api/game/:code — get full game state
app.get('/api/game/:code', (req, res) => {
  const game = games[req.params.code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  res.json(game);
});

// POST /api/join — player joins lobby
app.post('/api/join', (req, res) => {
  const { code, name, team } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  if (game.status !== 'lobby') return res.status(400).json({ error: 'Game sudah dimulai' });
  if (![1, 2].includes(Number(team))) return res.status(400).json({ error: 'Tim tidak valid' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nama tidak boleh kosong' });

  const teamPlayers = game.players.filter(p => p.team === Number(team));
  if (teamPlayers.length >= 3) return res.status(400).json({ error: 'Tim ini sudah penuh (3/3)' });

  const exists = game.players.find(p => p.name.toLowerCase() === name.trim().toLowerCase());
  if (exists) return res.status(400).json({ error: 'Nama sudah dipakai, pilih nama lain' });

  game.players.push({ name: name.trim(), team: Number(team) });
  res.json({ success: true });
});

// POST /api/answer — player submits answer
// Records timestamp for tie-breaking
app.post('/api/answer', (req, res) => {
  const { code, name, team, answer } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  if (game.status !== 'playing') return res.status(400).json({ error: 'Game belum dimulai' });

  const val = parseFloat(answer);
  if (isNaN(val)) return res.status(400).json({ error: 'Jawaban harus angka' });

  const exists = game.answers.find(a => a.name === name && a.team === Number(team) && a.round === game.round);
  if (exists) return res.status(400).json({ error: 'Sudah mengirim jawaban di ronde ini' });

  game.answers.push({
    name,
    team: Number(team),
    answer: val,
    round: game.round,
    timestamp: Date.now()   // for tie-breaking
  });
  res.json({ success: true });
});

// POST /api/correct — admin sets correct answer
app.post('/api/correct', (req, res) => {
  const { code, correct } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  const val = parseFloat(correct);
  if (isNaN(val)) return res.status(400).json({ error: 'Jawaban harus angka' });
  game.correctAnswer = val;
  res.json({ success: true });
});

// POST /api/start — admin starts game
app.post('/api/start', (req, res) => {
  const { code } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  const t1 = game.players.filter(p => p.team === 1);
  const t2 = game.players.filter(p => p.team === 2);
  if (t1.length < 1 || t2.length < 1) return res.status(400).json({ error: 'Butuh minimal 1 peserta per tim' });
  game.status = 'playing';
  res.json({ success: true });
});

// POST /api/kick — admin kicks a player (lobby or in-game)
app.post('/api/kick', (req, res) => {
  const { code, name } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  const player = game.players.find(p => p.name === name);
  if (!player) return res.status(404).json({ error: 'Pemain tidak ditemukan' });

  // Track kicked players so they can request rejoin
  game.kickedPlayers.push({ name: player.name, team: player.team });
  game.players = game.players.filter(p => p.name !== name);
  game.answers = game.answers.filter(a => a.name !== name);
  res.json({ success: true });
});

// POST /api/leave — player leaves (tab closed / beforeunload)
app.post('/api/leave', (req, res) => {
  const { code, name, team } = req.body;
  const game = games[code];
  if (!game) return res.json({ success: true }); // already gone, no error

  const player = game.players.find(p => p.name === name && p.team === Number(team));
  if (player) {
    // Mark as left (not kicked) so they can request rejoin
    game.kickedPlayers.push({ name: player.name, team: player.team, left: true });
    game.players = game.players.filter(p => !(p.name === name && p.team === Number(team)));
    game.answers = game.answers.filter(a => !(a.name === name && a.round === game.round));
  }
  res.json({ success: true });
});

// POST /api/rejoin-request — player requests to rejoin
app.post('/api/rejoin-request', (req, res) => {
  const { code, name, team } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });

  // Check they were previously in the game
  const wasInGame = game.kickedPlayers.find(p => p.name === name && p.team === Number(team));
  if (!wasInGame) return res.status(400).json({ error: 'Nama atau tim tidak cocok dengan data sebelumnya' });

  // Check not already pending
  const alreadyPending = game.rejoinRequests.find(r => r.name === name && r.status === 'pending');
  if (alreadyPending) return res.json({ success: true, status: 'pending' });

  // Check not already back in
  const alreadyIn = game.players.find(p => p.name === name);
  if (alreadyIn) return res.json({ success: true, status: 'approved' });

  game.rejoinRequests.push({ name, team: Number(team), timestamp: Date.now(), status: 'pending' });
  res.json({ success: true, status: 'pending' });
});

// POST /api/rejoin-approve — admin approves rejoin
app.post('/api/rejoin-approve', (req, res) => {
  const { code, name } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });

  const req2 = game.rejoinRequests.find(r => r.name === name && r.status === 'pending');
  if (!req2) return res.status(404).json({ error: 'Permintaan tidak ditemukan' });

  req2.status = 'approved';

  // Re-add player
  const teamCount = game.players.filter(p => p.team === req2.team).length;
  if (teamCount >= 3) return res.status(400).json({ error: 'Tim sudah penuh' });

  game.players.push({ name: req2.name, team: req2.team });
  // Remove from kicked list
  game.kickedPlayers = game.kickedPlayers.filter(p => p.name !== name);

  res.json({ success: true });
});

// POST /api/rejoin-deny — admin denies rejoin
app.post('/api/rejoin-deny', (req, res) => {
  const { code, name } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });

  const req2 = game.rejoinRequests.find(r => r.name === name && r.status === 'pending');
  if (!req2) return res.status(404).json({ error: 'Permintaan tidak ditemukan' });

  req2.status = 'denied';
  res.json({ success: true });
});

// POST /api/nextround — admin advances round
app.post('/api/nextround', (req, res) => {
  const { code } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  game.round += 1;
  game.correctAnswer = null;
  // Clean up old rejoin requests
  game.rejoinRequests = game.rejoinRequests.filter(r => r.status === 'pending');
  res.json({ success: true, round: game.round });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Spasial Chess v2 running on port ${PORT}`));
