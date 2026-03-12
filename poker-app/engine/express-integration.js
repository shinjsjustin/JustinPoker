const express = require('express');
const { PokerEngine } = require('./engine');

// ─────────────────────────────────────────
// EXPRESS.JS INTEGRATION EXAMPLE
// ─────────────────────────────────────────

const router = express.Router();

// Store active games in memory (use Redis/database in production)
const activeGames = new Map();

/**
 * Create a new poker game
 * POST /api/games
 * Body: { players: [{ player_id, username, chips }], options: { smallBlind, bigBlind } }
 */
router.post('/games', (req, res) => {
    try {
        const { players, options = {} } = req.body;
        
        if (!players || players.length < 2 || players.length > 9) {
            return res.status(400).json({ 
                error: 'Invalid number of players (2-9 required)' 
            });
        }

        const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const engine = new PokerEngine(players, {
            gameId: gameId,
            smallBlind: options.smallBlind || 10,
            bigBlind: options.bigBlind || 20
        });

        // Set up event handlers for real-time updates
        engine.setEventHandlers({
            onPlayerAction: (eventData) => {
                // Broadcast to all players via Socket.io
                if (req.io) {
                    req.io.to(gameId).emit('playerAction', eventData);
                }
            },
            
            onStageChange: (eventData) => {
                if (req.io) {
                    req.io.to(gameId).emit('stageChange', eventData);
                }
            },
            
            onHandComplete: (handSummary) => {
                if (req.io) {
                    req.io.to(gameId).emit('handComplete', handSummary);
                }
            }
        });

        activeGames.set(gameId, engine);

        res.json({
            success: true,
            gameId: gameId,
            gameState: engine.getGameState()
        });

    } catch (error) {
        res.status(400).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Start a hand
 * POST /api/games/:gameId/start
 */
router.post('/games/:gameId/start', (req, res) => {
    try {
        const engine = activeGames.get(req.params.gameId);
        
        if (!engine) {
            return res.status(404).json({ error: 'Game not found' });
        }

        const gameState = engine.startHand();

        // Broadcast game start
        if (req.io) {
            req.io.to(req.params.gameId).emit('handStarted', gameState);
        }

        res.json({
            success: true,
            gameState: gameState
        });

    } catch (error) {
        res.status(400).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Handle player action
 * POST /api/games/:gameId/action
 * Body: { playerId, action, amount? }
 */
router.post('/games/:gameId/action', (req, res) => {
    try {
        const { playerId, action, amount } = req.body;
        const engine = activeGames.get(req.params.gameId);
        
        if (!engine) {
            return res.status(404).json({ error: 'Game not found' });
        }

        if (!playerId || !action) {
            return res.status(400).json({ 
                error: 'playerId and action are required' 
            });
        }

        const result = engine.handleAction(playerId, action, amount);

        if (result.success) {
            // Broadcast successful action
            if (req.io) {
                req.io.to(req.params.gameId).emit('gameUpdate', result.game_state);
            }
        }

        res.json(result);

    } catch (error) {
        res.status(400).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Get current game state
 * GET /api/games/:gameId
 */
router.get('/games/:gameId', (req, res) => {
    try {
        const engine = activeGames.get(req.params.gameId);
        
        if (!engine) {
            return res.status(404).json({ error: 'Game not found' });
        }

        res.json({
            success: true,
            gameState: engine.getGameState()
        });

    } catch (error) {
        res.status(400).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Get private player information (includes hole cards)
 * GET /api/games/:gameId/players/:playerId
 */
router.get('/games/:gameId/players/:playerId', (req, res) => {
    try {
        const engine = activeGames.get(req.params.gameId);
        
        if (!engine) {
            return res.status(404).json({ error: 'Game not found' });
        }

        const playerInfo = engine.getPrivatePlayerInfo(req.params.playerId);

        res.json({
            success: true,
            player: playerInfo,
            gameState: engine.getGameState()
        });

    } catch (error) {
        res.status(400).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Get available actions for a player
 * GET /api/games/:gameId/players/:playerId/actions
 */
router.get('/games/:gameId/players/:playerId/actions', (req, res) => {
    try {
        const engine = activeGames.get(req.params.gameId);
        
        if (!engine) {
            return res.status(404).json({ error: 'Game not found' });
        }

        const gameState = engine.getGameState();
        
        // Check if it's the player's turn
        const isPlayerTurn = gameState.betting_round && 
                            gameState.betting_round.current_player === req.params.playerId;

        const availableActions = isPlayerTurn && gameState.betting_round ? 
                               gameState.betting_round.available_actions : [];

        res.json({
            success: true,
            playerId: req.params.playerId,
            isPlayerTurn: isPlayerTurn,
            availableActions: availableActions,
            currentStage: gameState.stage
        });

    } catch (error) {
        res.status(400).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Delete/end a game
 * DELETE /api/games/:gameId
 */
router.delete('/games/:gameId', (req, res) => {
    try {
        const engine = activeGames.get(req.params.gameId);
        
        if (!engine) {
            return res.status(404).json({ error: 'Game not found' });
        }

        // End the game
        activeGames.delete(req.params.gameId);

        // Notify all players
        if (req.io) {
            req.io.to(req.params.gameId).emit('gameEnded', {
                message: 'Game ended by request'
            });
        }

        res.json({
            success: true,
            message: 'Game ended successfully'
        });

    } catch (error) {
        res.status(400).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ─────────────────────────────────────────
// USAGE EXAMPLE
// ─────────────────────────────────────────

/*
// In your main server.js file:

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const pokerRoutes = require('./engine/express-integration');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());

// Add Socket.io to request object for real-time updates
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Mount poker routes
app.use('/api', pokerRoutes);

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    // Join game room
    socket.on('joinGame', (gameId) => {
        socket.join(gameId);
        console.log(`Player ${socket.id} joined game ${gameId}`);
    });
    
    // Leave game room
    socket.on('leaveGame', (gameId) => {
        socket.leave(gameId);
        console.log(`Player ${socket.id} left game ${gameId}`);
    });
    
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
    });
});

server.listen(3000, () => {
    console.log('Poker server running on port 3000');
});

// EXAMPLE API CALLS:

// 1. Create a game
POST /api/games
{
    "players": [
        { "player_id": "user1", "username": "Alice", "chips": 1000 },
        { "player_id": "user2", "username": "Bob", "chips": 1500 }
    ],
    "options": {
        "smallBlind": 10,
        "bigBlind": 20
    }
}

// 2. Start a hand
POST /api/games/game_123/start

// 3. Make an action
POST /api/games/game_123/action
{
    "playerId": "user1",
    "action": "raise",
    "amount": 60
}

// 4. Get game state
GET /api/games/game_123

// 5. Get player's private info
GET /api/games/game_123/players/user1

*/

module.exports = router;