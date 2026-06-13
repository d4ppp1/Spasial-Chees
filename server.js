cat > /mnt/user-data/outputs/server.js << 'SERVEREOF'
const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const games = {};

function randCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

// POST /api/create
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
    players: [],      // { name, team, online, lastSeen }
    answers: [],      // { name, team, answer, round, timestamp }
    rejoinRequests: [],// { name, team, requestedAt }
    tiebreaker: null  // nama pemain yang jawab pertama saat seri
  };
  res.json({ success: true, code });
});

// GET /api/game/:code
app.get('/api/game/:code', (req, res) => {
  const game = games[req.params.code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  res.json(game);
});

// POST /api/join — lobby only
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

  game.players.push({ name: name.trim(), team: Number(team), online: true, lastSeen: Date.now() });
  res.json({ success: true });
});

// POST /api/start
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

// POST /api/heartbeat — player sends heartbeat to mark online
app.post('/api/heartbeat', (req, res) => {
  const { code, name, team } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  const player = game.players.find(p => p.name === name && p.team === Number(team));
  if (!player) return res.status(404).json({ error: 'Pemain tidak ditemukan' });
  player.online = true;
  player.lastSeen = Date.now();
  res.json({ success: true });
});

// Mark players offline if lastSeen > 8 seconds ago, check every 4s
setInterval(() => {
  const now = Date.now();
  for (const game of Object.values(games)) {
    if (game.status !== 'playing') continue;
    for (const player of game.players) {
      if (player.online && now - player.lastSeen > 8000) {
        player.online = false;
      }
    }
  }
}, 4000);

// POST /api/rejoin-request — offline player requests to rejoin
app.post('/api/rejoin-request', (req, res) => {
  const { code, name, team } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  const player = game.players.find(p => p.name === name && p.team === Number(team));
  if (!player) return res.status(404).json({ error: 'Pemain tidak ditemukan di game ini' });

  // Remove old request if exists
  game.rejoinRequests = game.rejoinRequests.filter(r => r.name !== name);
  game.rejoinRequests.push({ name, team: Number(team), requestedAt: Date.now(), status: 'pending' });
  res.json({ success: true });
});

// POST /api/rejoin-approve — admin approves rejoin
app.post('/api/rejoin-approve', (req, res) => {
  const { code, name } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  const req2 = game.rejoinRequests.find(r => r.name === name && r.status === 'pending');
  if (!req2) return res.status(404).json({ error: 'Permintaan tidak ditemukan' });
  req2.status = 'approved';
  const player = game.players.find(p => p.name === name);
  if (player) { player.online = true; player.lastSeen = Date.now(); }
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

// POST /api/answer — with timestamp for tiebreaker
app.post('/api/answer', (req, res) => {
  const { code, name, team, answer } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  if (game.status !== 'playing') return res.status(400).json({ error: 'Game belum dimulai' });

  const val = parseFloat(answer);
  if (isNaN(val)) return res.status(400).json({ error: 'Jawaban harus angka' });

  const exists = game.answers.find(a => a.name === name && a.team === Number(team) && a.round === game.round);
  if (exists) return res.status(400).json({ error: 'Sudah mengirim jawaban di ronde ini' });

  game.answers.push({ name, team: Number(team), answer: val, round: game.round, timestamp: Date.now() });
  res.json({ success: true });
});

// POST /api/correct
app.post('/api/correct', (req, res) => {
  const { code, correct } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  const val = parseFloat(correct);
  if (isNaN(val)) return res.status(400).json({ error: 'Jawaban harus angka' });
  game.correctAnswer = val;

  // Compute tiebreaker: if tie by distance, who answered first
  const t1a = game.answers.filter(a => a.team === 1 && a.round === game.round);
  const t2a = game.answers.filter(a => a.team === 2 && a.round === game.round);
  const avg1 = t1a.length ? t1a.reduce((s, a) => s + a.answer, 0) / t1a.length : null;
  const avg2 = t2a.length ? t2a.reduce((s, a) => s + a.answer, 0) / t2a.length : null;

  if (avg1 !== null && avg2 !== null) {
    const d1 = Math.abs(avg1 - val);
    const d2 = Math.abs(avg2 - val);
    if (Math.abs(d1 - d2) < 0.0001) {
      // TIE — find first answer submitted across both teams this round
      const allAnswers = game.answers.filter(a => a.round === game.round).sort((a, b) => a.timestamp - b.timestamp);
      if (allAnswers.length > 0) {
        game.tiebreaker = allAnswers[0].team; // team number of first answerer
        game.tiebreakerName = allAnswers[0].name;
      }
    } else {
      game.tiebreaker = null;
      game.tiebreakerName = null;
    }
  }

  res.json({ success: true });
});

// POST /api/kick
app.post('/api/kick', (req, res) => {
  const { code, name } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  const before = game.players.length;
  game.players = game.players.filter(p => p.name !== name);
  if (game.players.length === before) return res.status(404).json({ error: 'Pemain tidak ditemukan' });
  game.answers = game.answers.filter(a => a.name !== name);
  game.rejoinRequests = game.rejoinRequests.filter(r => r.name !== name);
  res.json({ success: true });
});

// POST /api/nextround
app.post('/api/nextround', (req, res) => {
  const { code } = req.body;
  const game = games[code];
  if (!game) return res.status(404).json({ error: 'Game tidak ditemukan' });
  game.round += 1;
  game.correctAnswer = null;
  game.tiebreaker = null;
  game.tiebreakerName = null;
  res.json({ success: true, round: game.round });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Spasial Chess v3 running on port ${PORT}`));
