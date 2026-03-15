const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const session = require('express-session');
const dotenv = require('dotenv');
const { router: authRoutes } = require('./routes/userauth');
const tablesRoutes = require('./routes/tables');
const gamesRoutes = require('./routes/games');
const actionsRoutes = require('./routes/actions');
const { createGameSockets } = require('./sockets/gamesockets');
const db = require('./db/db');

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

// Initialize game sockets utilities
const gameSockets = createGameSockets(io);

// Store active poker engines in memory
const activeGames = new Map();

// Make poker engines, io, and gameSockets available to routes
app.use((req, res, next) => {
  req.activeGames = activeGames;
  req.io = io;
  req.gameSockets = gameSockets;
  next();
});

// Make helper functions available to routes
app.locals.createPokerEngine = createPokerEngine;
app.locals.persistGameState = persistGameState;

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
app.use('/api/tables', tablesRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/actions', actionsRoutes);

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

// Poker Engine Management Functions
async function createPokerEngine(gameId, players, options) {
  const engine = new PokerEngine(players, {
    gameId: gameId,
    smallBlind: options.smallBlind || 10,
    bigBlind: options.bigBlind || 20
  });

  // Set up event handlers for real-time updates
  engine.setEventHandlers({
    onHandComplete: async (handSummary) => {
      console.log(`Hand ${handSummary.hand_number} complete in game ${gameId}`);
      io.to(`game_${gameId}`).emit('handComplete', handSummary);
      
      // Persist final hand state to database
      await persistGameState(gameId, engine);
    },
    
    onPlayerAction: (eventData) => {
      console.log(`Player action in game ${gameId}:`, eventData.action.type);
      io.to(`game_${gameId}`).emit('playerAction', eventData);
    },
    
    onStageChange: (eventData) => {
      console.log(`Stage change in game ${gameId}: ${eventData.stage}`);
      io.to(`game_${gameId}`).emit('stageChange', eventData);
    }
  });

  activeGames.set(gameId, engine);
  return engine;
}

async function persistGameState(gameId, engine) {
  try {
    const gameState = engine.getGameState();
    
    // Update game record
    await db.execute(
      'UPDATE games SET pot = ?, community_cards = ?, stage = ?, active_seat = ?, ended_at = ? WHERE game_id = ?',
      [
        gameState.pot_structure.totalPot,
        JSON.stringify(gameState.community_cards),
        gameState.stage,
        gameState.betting_round ? gameState.betting_round.current_player : null,
        gameState.stage === 'complete' ? new Date() : null,
        gameId
      ]
    );

    // Update player states
    for (const player of gameState.players) {
      await db.execute(
        'UPDATE game_players SET current_bet = ?, chips_end = ?, is_folded = ?, is_all_in = ? WHERE game_id = ? AND player_id = ?',
        [player.bet, player.stack, player.folded, player.allIn, gameId, player.player_id]
      );
      
      // Update table chip stacks
      await db.execute(
        'UPDATE table_players SET chip_stack = ? WHERE player_id = ? AND table_id = (SELECT table_id FROM games WHERE game_id = ?)',
        [player.stack, player.player_id, gameId]
      );
    }
  } catch (error) {
    console.error('Error persisting game state:', error);
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.username} (${socket.playerId}) - Socket: ${socket.id}`);
  
  // Join player to their personal room
  socket.join(`player_${socket.playerId}`);
  
  // Handle poker game events
  socket.on('join_game', (gameId) => {
    socket.join(`game_${gameId}`);
    console.log(`${socket.username} joined game ${gameId}`);
    
    // Send current game state to joining player
    const engine = activeGames.get(gameId);
    if (engine) {
      socket.emit('gameState', engine.getGameState());
      socket.emit('privatePlayerInfo', engine.getPrivatePlayerInfo(socket.playerId));
    }
    
    // Broadcast to other players
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

  // Handle poker actions via Socket.io
  socket.on('poker_action', async (data) => {
    try {
      const { gameId, action, amount } = data;
      const engine = activeGames.get(gameId);
      
      if (!engine) {
        socket.emit('action_error', { message: 'Game not found' });
        return;
      }

      const result = engine.handleAction(socket.playerId, action, amount);
      
      if (result.success) {
        // Persist state after successful action
        await persistGameState(gameId, engine);
        
        // Broadcast game update
        io.to(`game_${gameId}`).emit('gameUpdate', result.game_state);
        
        // Send private info to acting player
        socket.emit('privatePlayerInfo', engine.getPrivatePlayerInfo(socket.playerId));
      } else {
        socket.emit('action_error', { message: result.error });
      }
    } catch (error) {
      console.error('Error handling poker action:', error);
      socket.emit('action_error', { message: 'Failed to process action' });
    }
  });

  socket.on('disconnect', async () => {
    console.log(`Player disconnected: ${socket.username} (${socket.playerId}) - Socket: ${socket.id}`);
    
    // Auto-leave any table the player is seated at (unless they're in an active game)
    try {
      const db = require('./db/db');
      
      // Check if player is seated at any table
      const [tableResult] = await db.execute(`
        SELECT tp.table_id, tp.table_player_id, tp.chip_stack
        FROM table_players tp
        WHERE tp.player_id = ? AND tp.status IN ('active', 'sitting_out')
        LIMIT 1
      `, [socket.playerId]);
      
      if (tableResult.length > 0) {
        const player = tableResult[0];
        
        // Check if player is in an active game
        const [activeGame] = await db.execute(`
          SELECT g.game_id 
          FROM games g 
          JOIN game_players gp ON g.game_id = gp.game_id 
          WHERE g.table_id = ? AND gp.player_id = ? AND g.ended_at IS NULL
        `, [player.table_id, socket.playerId]);
        
        // Only auto-leave if not in an active game
        if (activeGame.length === 0) {
          await db.query('START TRANSACTION');
          try {
            // Update player status to 'left'
            await db.execute(
              'UPDATE table_players SET status = "left" WHERE table_player_id = ?', 
              [player.table_player_id]
            );
            
            // Return chips to player
            await db.execute(
              'UPDATE players SET chip_balance = chip_balance + ? WHERE player_id = ?', 
              [player.chip_stack, socket.playerId]
            );
            
            await db.query('COMMIT');
            console.log(`Auto-left table ${player.table_id} for disconnected player ${socket.username}`);
          } catch (error) {
            await db.query('ROLLBACK');
            console.error('Failed to auto-leave table:', error);
          }
        }
      }
    } catch (error) {
      console.error('Error handling player disconnect:', error);
    }
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