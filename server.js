const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create a new room - returns a UUID
app.get('/api/create-room', (req, res) => {
  const roomId = uuidv4().substring(0, 8);
  res.json({ roomId });
});

// Room page
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// Track rooms and their participants
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join-room', ({ roomId, username }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;

    // Track room participants
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    rooms.get(roomId).set(socket.id, username);

    // Notify existing users about the new peer
    socket.to(roomId).emit('user-joined', {
      userId: socket.id,
      username: username
    });

    // Send the new user a list of existing participants
    const existingUsers = [];
    rooms.get(roomId).forEach((name, id) => {
      if (id !== socket.id) {
        existingUsers.push({ userId: id, username: name });
      }
    });
    socket.emit('existing-users', existingUsers);

    console.log(`${username} joined room ${roomId}. Participants: ${rooms.get(roomId).size}`);
  });

  // WebRTC signaling
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', {
      from: socket.id,
      username: socket.username,
      offer
    });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', {
      from: socket.id,
      answer
    });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', {
      from: socket.id,
      candidate
    });
  });

  // Chat messages (fallback via server if data channel not available)
  socket.on('chat-message', ({ roomId, message, username }) => {
    socket.to(roomId).emit('chat-message', {
      username,
      message,
      timestamp: new Date().toISOString()
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    if (socket.roomId && rooms.has(socket.roomId)) {
      rooms.get(socket.roomId).delete(socket.id);
      if (rooms.get(socket.roomId).size === 0) {
        rooms.delete(socket.roomId);
      }
      socket.to(socket.roomId).emit('user-left', {
        userId: socket.id,
        username: socket.username
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎵 JamSync Server is running!`);
  console.log(`🌐 Open http://localhost:${PORT} in your browser\n`);
});
