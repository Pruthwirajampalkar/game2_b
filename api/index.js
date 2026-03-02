const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();

const CLIENT_URL = process.env.CLIENT_URL || '*';

app.use(cors({
  origin: CLIENT_URL,
  methods: ['GET', 'POST'],
  credentials: CLIENT_URL !== '*'
}));
app.use(express.json());

// Root health check route
app.get('/', (req, res) => {
  res.status(200).send('SketchClue API is running');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: CLIENT_URL !== '*'
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6,
  allowUpgrades: true,
  perMessageDeflate: {
    threshold: 1024
  }
});

const PORT = process.env.PORT || 3001;

// Game State Management
const rooms = new Map();
// rooms format: 
// { 
//   [roomId]: {
//     players: [{ id, username, score }],
//     currentDrawer: null,
//     currentWord: '',
//     round: 1,
//     status: 'lobby' | 'playing' | 'round_end'
//   }
// }

const MAX_ROUNDS = 3;
const TURN_TIME_SECONDS = 60;
const WORDS = require('./words');

function getEditDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1) // insertion, deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

// Game Engine
function endRound(roomId, room, wordHintMode = false) {
  room.status = 'round_end';
  clearInterval(room.timerInterval);

  // calculate points gained this round (which is score - previous_score)
  // since we don't track previous score, we'll just send the current total scores 
  // and the client can compute the difference if needed, or we just show the current scores

  io.to(roomId).emit('round_ended', {
    word: room.currentWord,
    players: room.players.map(p => ({
      id: p.id,
      username: p.username,
      score: p.score,
      guessed: room.guessedPlayers.has(p.id) || p.id === room.currentDrawer
    }))
  });

  setTimeout(() => {
    // Determine next drawer or end game if all players drew
    startNextTurn(roomId, room);
  }, 5000);
}

function startNextTurn(roomId, room) {
  if (!room || room.players.length < 1) {
    if (room) room.status = 'lobby';
    io.to(roomId).emit('room_update', room);
    return;
  }

  // Move to next player in drawerQueue
  if (room.drawerQueue.length === 0) {
    // End of round
    room.round++;
    if (room.round > (room.maxRounds || 3)) {
      endGame(roomId, room);
      return;
    }
    // Refill drawer queue for the new round
    room.drawerQueue = [...room.players.map(p => p.id)];
  }

  // Setup new round emotions (everyone defaults to 'default')
  room.players.forEach(p => p.emotion = 'default');

  // Pop next drawer
  room.currentDrawer = room.drawerQueue.shift();
  room.status = 'choosing_word';
  room.currentWord = '';
  room.guessedPlayers = new Set();
  room.timer = 30; // 30 seconds to choose a word

  // Select 3 random words
  const options = [];
  const tempWords = [...WORDS];
  for (let i = 0; i < 3; i++) {
    if (tempWords.length > 0) {
      const idx = Math.floor(Math.random() * tempWords.length);
      options.push(tempWords[idx]);
      tempWords.splice(idx, 1);
    }
  }

  // Create a safe copy of room without interval/sets to emit
  const roomData = { ...room, timerInterval: null, guessedPlayers: Array.from(room.guessedPlayers) };
  io.to(roomId).emit('room_update', roomData);
  io.to(roomId).emit('choose_word_options', options);

  // Set timeout to auto-pick a word
  clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    room.timer--;
    io.to(roomId).emit('timer_update', room.timer);
    if (room.timer <= 0) {
      // time is up, auto pick a word
      clearInterval(room.timerInterval);
      const randomFallback = options[Math.floor(Math.random() * options.length)] || WORDS[0];
      startGameTurnWithWord(roomId, room, randomFallback);
    }
  }, 1000);
}

function revealHint(roomId, room) {
  if (!room.currentWord) return;
  if (!room.revealedIndices) room.revealedIndices = new Set();

  const chars = room.currentWord.split('');
  const hiddenIndices = [];
  chars.forEach((c, i) => {
    if (c.match(/[a-zA-Z]/) && !room.revealedIndices.has(i)) {
      hiddenIndices.push(i);
    }
  });

  // Calculate how many letters we should reveal.
  // For long words (>6 letters), reveal 2 letters at a time if possible. Otherwise 1.
  const wordLength = chars.filter(c => c.match(/[a-zA-Z]/)).length;
  let numToReveal = wordLength > 6 ? 2 : 1;

  // Don't reveal more than what's hidden, and always leave at least 1 letter hidden overall
  numToReveal = Math.min(numToReveal, hiddenIndices.length - 1);

  if (numToReveal > 0) {
    for (let i = 0; i < numToReveal; i++) {
      const randomIndex = hiddenIndices[Math.floor(Math.random() * hiddenIndices.length)];
      room.revealedIndices.add(randomIndex);
      hiddenIndices.splice(hiddenIndices.indexOf(randomIndex), 1); // Remove so we don't pick it again
    }

    const newMask = chars.map((c, i) => {
      if (!c.match(/[a-zA-Z]/)) return c + ' ';
      return room.revealedIndices.has(i) ? c + ' ' : '_ ';
    }).join('');

    io.to(roomId).emit('word_hint', newMask);
    io.to(roomId).emit('chat_message', { username: 'System', message: `Hint revealed!` });
  }
}

function startGameTurnWithWord(roomId, room, word) {
  room.currentWord = word;
  room.revealedIndices = new Set();
  room.timer = room.turnTime || 60;
  room.status = 'playing';

  const maskedWord = word.split('').map(c => c.match(/[a-zA-Z]/) ? '_ ' : c + ' ').join('');
  io.to(roomId).emit('game_started');
  // Broadcast hint to everyone (clients logic prevents drawer from seeing it anyway)
  io.to(roomId).emit('word_hint', maskedWord);

  const roomData = { ...room, timerInterval: null, guessedPlayers: Array.from(room.guessedPlayers || []) };
  io.to(roomId).emit('room_update', roomData);

  // Start realistic drawing turn countdown
  clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    room.timer--;
    io.to(roomId).emit('timer_update', room.timer);

    const turnTime = room.turnTime || 60;
    if (room.timer === Math.floor(turnTime * 0.5) || room.timer === Math.floor(turnTime * 0.25)) {
      revealHint(roomId, room);
    }

    if (room.timer <= 0) {
      io.to(roomId).emit('chat_message', { username: 'System', message: `Time's up! The word was ${room.currentWord}` });
      endRound(roomId, room);
    }
  }, 1000);
}

function endGame(roomId, room) {
  room.status = 'game_over';
  room.currentWord = '';
  clearInterval(room.timerInterval);

  // Find winner(s)
  let maxScore = -1;
  room.players.forEach(p => { if (p.score > maxScore) maxScore = p.score; });
  const winners = room.players.filter(p => p.score === maxScore);

  // Update emotions: guessed correctly = happy, otherwise = sad
  room.players.forEach(p => {
    if (room.guessedPlayers.has(p.id)) p.emotion = 'happy';
    else if (p.id !== room.currentDrawer) p.emotion = 'sad';
  });

  const roomData = { ...room, timerInterval: null, guessedPlayers: [] };
  io.to(roomId).emit('room_update', roomData);
  io.to(roomId).emit('game_over', { winners, maxScore });

  // Reset for next game
  setTimeout(() => {
    if (rooms.has(roomId)) {
      const r = rooms.get(roomId);
      r.status = 'lobby';
      r.round = 1;
      r.players.forEach(p => {
        p.score = 0;
        p.emotion = 'default';
      });
      io.to(roomId).emit('room_update', { ...r, timerInterval: null, guessedPlayers: [] });
    }
  }, 10000);
}

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id, 'Transport:', socket.conn?.transport?.name || 'unknown');
  console.log('📊 Active connections:', io.engine?.clientsCount || 'N/A');

  socket.on('join_room', ({ username, avatar, roomId }) => {
    let room = rooms.get(roomId);

    let existingPlayerIndex = room ? room.players.findIndex(p => p.username === username) : -1;

    // Apply maxPlayers limit
    if (room && room.players.length >= (room.maxPlayers || 8) && existingPlayerIndex === -1) {
      socket.emit('room_error', `Room is full (max ${room.maxPlayers || 8} players)`);
      return;
    }

    socket.join(roomId);

    if (!room) {
      rooms.set(roomId, {
        players: [],
        drawerQueue: [],
        currentDrawer: null,
        currentWord: '',
        round: 1,
        maxRounds: 3,
        turnTime: 60,
        maxPlayers: 8,
        hostId: socket.id,
        hostName: username,
        status: 'lobby',
        timer: 0,
        timerInterval: null,
        guessedPlayers: new Set()
      });
      room = rooms.get(roomId);
    }

    if (existingPlayerIndex !== -1) {
      const oldId = room.players[existingPlayerIndex].id;
      room.players[existingPlayerIndex].id = socket.id;

      const dqIndex = room.drawerQueue.indexOf(oldId);
      if (dqIndex !== -1) room.drawerQueue[dqIndex] = socket.id;

      if (room.currentDrawer === oldId) room.currentDrawer = socket.id;
      if (room.hostId === oldId) room.hostId = socket.id;

      if (room.guessedPlayers.has(oldId)) {
        room.guessedPlayers.delete(oldId);
        room.guessedPlayers.add(socket.id);
      }
    } else {
      if (room.hostName === username && !room.hostId) {
        room.hostId = socket.id;
      }
      room.players.push({ id: socket.id, username, avatar: avatar || 'Felix', score: 0, emotion: 'default' });
    }

    const roomData = { ...room, timerInterval: null, guessedPlayers: Array.from(room.guessedPlayers || []), hostId: room.hostId };
    io.to(roomId).emit('room_update', roomData);
    console.log(`${username} joined room ${roomId}`);

    // auto-start logic: when the number of players equals maxPlayers in lobby
    if (room.status === 'lobby' && room.players.length === (room.maxPlayers || 2)) {
      console.log(`Auto-starting game in room ${roomId} because player count reached limit`);
      room.round = 1;
      room.players.forEach(p => p.score = 0);
      room.drawerQueue = [...room.players.map(p => p.id)];
      startNextTurn(roomId, room);
    }
  });

  socket.on('word_chosen', ({ roomId, word }) => {
    const room = rooms.get(roomId);
    if (room && room.status === 'choosing_word' && room.currentDrawer === socket.id) {
      clearInterval(room.timerInterval);
      startGameTurnWithWord(roomId, room, word);
    }
  });

  socket.on('start_game', (roomId) => {
    console.log(`start_game event from ${socket.id} for room ${roomId}`);
    const room = rooms.get(roomId);
    if (room && room.players.length > 0 && room.status === 'lobby' && room.hostId === socket.id) {
      room.round = 1;
      room.players.forEach(p => p.score = 0);
      room.drawerQueue = [...room.players.map(p => p.id)];
      startNextTurn(roomId, room);
    }
  });

  socket.on('update_settings', ({ roomId, settings }) => {
    const room = rooms.get(roomId);
    if (room && room.status === 'lobby' && room.players.length > 0 && room.hostId === socket.id) {
      if (settings.maxRounds) room.maxRounds = settings.maxRounds;
      if (settings.turnTime) room.turnTime = settings.turnTime;
      if (settings.maxPlayers) room.maxPlayers = settings.maxPlayers;
      const roomData = { ...room, timerInterval: null, guessedPlayers: Array.from(room.guessedPlayers || []), hostId: room.hostId };
      io.to(roomId).emit('room_update', roomData);
      // if current count already meets new limit, start immediately
      if (room.players.length === room.maxPlayers) {
        console.log(`Auto-start after setting change in room ${roomId}`);
        room.round = 1;
        room.players.forEach(p => p.score = 0);
        room.drawerQueue = [...room.players.map(p => p.id)];
        startNextTurn(roomId, room);
      }
    }
  });

  socket.on('draw', ({ roomId, drawData }) => {
    socket.to(roomId).emit('draw_update', drawData);
  });

  socket.on('fill_background', ({ roomId, color }) => {
    socket.to(roomId).emit('fill_background', color);
  });

  socket.on('clear_canvas', (roomId) => {
    socket.to(roomId).emit('canvas_cleared');
  });

  socket.on('send_message', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      io.to(roomId).emit('chat_message', { username: player.username, message });
    }
  });

  socket.on('guess', ({ roomId, guess }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || !room.currentWord) return;

    // Reject drawer guessing
    if (socket.id === room.currentDrawer) return;

    // Reject already guessed
    if (room.guessedPlayers.has(socket.id)) {
      socket.emit('chat_message', { username: 'System', message: 'You already guessed it!' });
      return;
    }

    const guessStr = guess.trim();
    if (!guessStr) return;
    const distance = getEditDistance(guessStr.toLowerCase(), room.currentWord.toLowerCase());

    const player = room.players.find(p => p.id === socket.id);

    if (distance === 0) {
      room.guessedPlayers.add(socket.id);

      const drawer = room.players.find(p => p.id === room.currentDrawer);
      const totalTime = room.turnTime || 60;
      const totalGuessers = room.players.length - 1; // everyone except drawer

      // --- Skribbl.io-style scoring ---
      // Guesser: 50-550 points based on how fast they guess
      const timeRatio = Math.max(0, room.timer / totalTime);
      const guesserPoints = Math.floor(500 * timeRatio) + 50;

      // Drawer: gets proportional points per correct guess
      // More guessers = more total drawer points (rewarding good drawings)
      const drawerPoints = Math.max(25, Math.floor(guesserPoints / totalGuessers));

      if (player && drawer) {
        player.score += guesserPoints;
        player.emotion = 'happy';
        drawer.score += drawerPoints;
      }

      io.to(roomId).emit('correct_guess', {
        username: player?.username || 'Unknown',
        points: guesserPoints,
        drawerPoints: drawerPoints
      });
      const roomData = { ...room, timerInterval: null, guessedPlayers: Array.from(room.guessedPlayers) };
      io.to(roomId).emit('room_update', roomData);

      // If all guessers guessed it, end round immediately
      if (room.guessedPlayers.size === totalGuessers && totalGuessers > 0) {
        endRound(roomId, room);
      }

    } else {
      io.to(roomId).emit('chat_message', { username: player?.username || 'Unknown', message: guessStr });

      // Send close guess hint
      if (distance <= 2 && room.currentWord.length > 3) {
        socket.emit('chat_message', { username: 'System', message: `'${guessStr}' is very close!` });
        if (player) {
          player.emotion = 'curious';
          const roomData = { ...room, timerInterval: null, guessedPlayers: Array.from(room.guessedPlayers) };
          io.to(roomId).emit('room_update', roomData);
        }
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
    try {
      for (const [roomId, room] of rooms.entries()) {
        const index = room.players.findIndex(p => p.id === socket.id);
        if (index !== -1) {
          const wasHost = room.hostId === socket.id;
          const disconnectedPlayer = room.players[index];
          room.players.splice(index, 1);

          // Remove from drawer queue
          room.drawerQueue = room.drawerQueue.filter(id => id !== socket.id);

          console.log(`Player ${disconnectedPlayer.username} (${socket.id}) left room ${roomId}`);

          // reassign host if needed
          if (wasHost) {
            room.hostId = room.players[0]?.id || null;
            room.hostName = room.players[0]?.username || null;
            if (room.hostId) console.log(`Host transferred to: ${room.hostName}`);
          }

          if (room.players.length === 0) {
            clearInterval(room.timerInterval);
            rooms.delete(roomId);
            console.log(`Room ${roomId} cleared (0 players)`);
          } else {
            // If drawer left while drawing, end round
            if (room.status === 'playing' && room.currentDrawer === socket.id) {
              io.to(roomId).emit('chat_message', { username: 'System', message: 'Drawer disconnected!' });
              endRound(roomId, room);
            } else {
              const roomData = { ...room, timerInterval: null, guessedPlayers: Array.from(room.guessedPlayers || []), hostId: room.hostId };
              io.to(roomId).emit('room_update', roomData);
            }
          }
        }
      }
    } catch (err) {
      console.error('⚠️ Disconnect error:', err);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT} at 0.0.0.0`);
});
