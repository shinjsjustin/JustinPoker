const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const session = require('express-session');
const dotenv = require('dotenv');
const { router: authRoutes, authenticateToken } = require('./routes/userauth');

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Routes
app.use('/api/auth', authRoutes);

// Basic route for testing
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Socket.io authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.playerId = decoded.playerId;
    socket.username = decoded.username;
    next();
  } catch (err) {
    next(new Error('Authentication error: Invalid token'));
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.username} (${socket.playerId}) - Socket: ${socket.id}`);
  
  // Join player to their personal room
  socket.join(`player_${socket.playerId}`);
  
  // Handle poker game events here
  socket.on('join_game', (gameId) => {
    socket.join(`game_${gameId}`);
    console.log(`${socket.username} joined game ${gameId}`);
    // Broadcast to other players in the game
    socket.to(`game_${gameId}`).emit('player_joined', {
      playerId: socket.playerId,
      username: socket.username
    });
  });

  socket.on('leave_game', (gameId) => {
    socket.leave(`game_${gameId}`);
    console.log(`${socket.username} left game ${gameId}`);
    socket.to(`game_${gameId}`).emit('player_left', {
      playerId: socket.playerId,
      username: socket.username
    });
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.username} (${socket.playerId}) - Socket: ${socket.id}`);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Poker app running on http://localhost:${PORT}`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
});