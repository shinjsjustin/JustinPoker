const db = require('../db/db');
const jwt = require('jsonwebtoken');
const express = require('express');
const gameLogic = require('../gamelogic');
const gameUtils = require('../game-utils');
const router = express.Router();

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// ─────────────────────────────────────────
// PLAYER ACTION ENDPOINTS (Poker Engine Integrated)
// ─────────────────────────────────────────

// POST /actions - Submit a player action (now uses poker engine)
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { game_id, action_type, amount = 0 } = req.body;
        const player_id = req.user.playerId;

        // Validate input
        if (!game_id || !action_type) {
            return res.status(400).json({ 
                message: 'game_id and action_type are required' 
            });
        }

        const validActions = ['fold', 'check', 'call', 'bet', 'raise', 'all_in'];
        if (!validActions.includes(action_type)) {
            return res.status(400).json({ message: 'Invalid action type' });
        }

        // Try to get the poker engine for this game
        const engine = req.activeGames.get(game_id);
        if (!engine) {
            return res.status(404).json({ 
                message: 'Game not found or not active. Use /games/{gameId}/action endpoint for active games.' 
            });
        }

        try {
            const result = engine.handleAction(player_id, action_type, amount);
            
            if (result.success) {
                // Record action in database for history
                await db.execute(`
                    INSERT INTO actions (game_id, player_id, action_type, amount, stage)
                    VALUES (?, ?, ?, ?, ?)
                `, [game_id, player_id, action_type, amount, result.game_state.stage]);
                
                // Broadcast update to all players
                req.io.to(`game_${game_id}`).emit('gameUpdate', result.game_state);
                
                res.json({
                    success: true,
                    message: 'Action recorded successfully',
                    action_type,
                    amount: result.result.action.amount,
                    pot: result.game_state.pot_structure.totalPot,
                    player_chips: result.result.player.stack,
                    is_all_in: result.result.player.allIn,
                    is_folded: result.result.player.folded,
                    gameState: result.game_state
                });
            } else {
                res.status(400).json({
                    success: false,
                    message: result.error
                });
            }

        } catch (engineError) {
            res.status(400).json({ 
                success: false, 
                message: engineError.message 
            });
        }

    } catch (error) {
        console.error('Error processing action:', error);
        res.status(500).json({ message: 'Failed to process action' });
    }
});

// GET /actions/game/:gameId - Get all actions for a game
router.get('/game/:gameId', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;

        const [actions] = await db.execute(`
            SELECT 
                a.*,
                p.username,
                tp.seat_number
            FROM actions a
            JOIN players p ON a.player_id = p.player_id
            LEFT JOIN game_players gp ON gp.game_id = a.game_id AND gp.player_id = a.player_id
            LEFT JOIN games g ON g.game_id = a.game_id
            LEFT JOIN table_players tp ON tp.table_id = g.table_id AND tp.player_id = a.player_id
            WHERE a.game_id = ?
            ORDER BY a.acted_at ASC
        `, [gameId]);

        res.json(actions);

    } catch (error) {
        console.error('Error fetching actions:', error);
        res.status(500).json({ message: 'Failed to fetch actions' });
    }
});

// GET /actions/player/:playerId - Get action history for a player
router.get('/player/:playerId', authenticateToken, async (req, res) => {
    try {
        const { playerId } = req.params;
        const { limit = 50, offset = 0 } = req.query;

        // Only allow players to see their own actions or if they're in the same game
        if (req.user.playerId !== parseInt(playerId)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const [actions] = await db.execute(`
            SELECT 
                a.*,
                g.table_id,
                t.name as table_name
            FROM actions a
            JOIN games g ON a.game_id = g.game_id
            JOIN tables t ON g.table_id = t.table_id
            WHERE a.player_id = ?
            ORDER BY a.acted_at DESC
            LIMIT ? OFFSET ?
        `, [playerId, parseInt(limit), parseInt(offset)]);

        res.json(actions);

    } catch (error) {
        console.error('Error fetching player actions:', error);
        res.status(500).json({ message: 'Failed to fetch player actions' });
    }
});

// POST /actions/blinds/:gameId - Post blinds automatically (deprecated - engine handles this)
router.post('/blinds/:gameId', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;

        // This is now handled automatically by the poker engine when starting a hand
        const engine = req.activeGames.get(gameId);
        if (!engine) {
            return res.status(404).json({ message: 'Game not found' });
        }

        // Engine handles blinds automatically in startHand()
        res.json({
            message: 'Blinds are now handled automatically by the poker engine when starting a hand',
            suggestion: 'Use POST /games/{gameId}/start to begin a hand'
        });

    } catch (error) {
        console.error('Error with blinds endpoint:', error);
        res.status(500).json({ message: 'Blinds are handled by poker engine' });
    }
});

// GET /actions/game/:gameId/formatted - Get formatted action history for frontend
router.get('/game/:gameId/formatted', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;

        const [actions] = await db.execute(`
            SELECT 
                a.*,
                p.username,
                tp.seat_number
            FROM actions a
            JOIN players p ON a.player_id = p.player_id
            LEFT JOIN game_players gp ON gp.game_id = a.game_id AND gp.player_id = a.player_id
            LEFT JOIN games g ON g.game_id = a.game_id
            LEFT JOIN table_players tp ON tp.table_id = g.table_id AND tp.player_id = a.player_id
            WHERE a.game_id = ?
            ORDER BY a.acted_at ASC
        `, [gameId]);

        const formattedActions = gameUtils.formatActionHistory(actions);
        
        // Group actions by stage for better organization
        const actionsByStage = {
            pre_flop: [],
            flop: [],
            turn: [],
            river: [],
            showdown: []
        };
        
        formattedActions.forEach(action => {
            if (actionsByStage[action.stage]) {
                actionsByStage[action.stage].push(action);
            }
        });

        res.json({
            game_id: gameId,
            total_actions: formattedActions.length,
            actions: formattedActions,
            actions_by_stage: actionsByStage
        });

    } catch (error) {
        console.error('Error fetching formatted actions:', error);
        res.status(500).json({ message: 'Failed to fetch formatted actions' });
    }
});

// GET /actions/game/:gameId/available - Get available actions for current player (uses poker engine)
router.get('/game/:gameId/available', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const playerId = req.user.playerId;

        const engine = req.activeGames.get(gameId);
        if (!engine) {
            return res.status(404).json({ 
                message: 'Game not found or not active',
                available_actions: []
            });
        }

        const gameState = engine.getGameState();
        
        // Check if it's the player's turn
        let isPlayerTurn = false;
        let availableActions = [];
        let currentPlayer = null;
        
        if (gameState.betting_round && engine.bettingRound) {
            currentPlayer = engine.bettingRound.getCurrentPlayer();
            isPlayerTurn = currentPlayer && currentPlayer.player_id === playerId;
            
            if (isPlayerTurn) {
                availableActions = engine.bettingRound.getAvailableActions();
            }
        }

        // Get player's current state
        const playerState = gameState.players.find(p => p.player_id === playerId);

        res.json({
            success: true,
            game_id: gameId,
            player_id: playerId,
            is_player_turn: isPlayerTurn,
            current_player: currentPlayer ? currentPlayer.player_id : null,
            available_actions: availableActions,
            current_stage: gameState.stage,
            player_state: playerState ? {
                stack: playerState.stack,
                bet: playerState.bet,
                folded: playerState.folded,
                all_in: playerState.allIn
            } : null,
            pot_structure: gameState.pot_structure
        });

    } catch (error) {
        console.error('Error getting available actions:', error);
        res.status(500).json({ message: 'Failed to get available actions' });
    }
});

// GET /actions/game/:gameId/summary - Get action summary and game statistics
router.get('/game/:gameId/summary', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;

        const [actions] = await db.execute(`
            SELECT 
                a.*,
                p.username
            FROM actions a
            JOIN players p ON a.player_id = p.player_id
            WHERE a.game_id = ?
            ORDER BY a.acted_at ASC
        `, [gameId]);

        // Calculate statistics
        const actionStats = {
            total_actions: actions.length,
            actions_by_type: {},
            actions_by_player: {},
            actions_by_stage: {},
            total_pot_contributions: 0
        };

        actions.forEach(action => {
            // By type
            actionStats.actions_by_type[action.action_type] = 
                (actionStats.actions_by_type[action.action_type] || 0) + 1;

            // By player
            if (!actionStats.actions_by_player[action.username]) {
                actionStats.actions_by_player[action.username] = {
                    total_actions: 0,
                    total_amount: 0,
                    action_types: {}
                };
            }
            actionStats.actions_by_player[action.username].total_actions++;
            actionStats.actions_by_player[action.username].total_amount += action.amount;
            actionStats.actions_by_player[action.username].action_types[action.action_type] = 
                (actionStats.actions_by_player[action.username].action_types[action.action_type] || 0) + 1;

            // By stage
            actionStats.actions_by_stage[action.stage] = 
                (actionStats.actions_by_stage[action.stage] || 0) + 1;

            // Total contributions
            actionStats.total_pot_contributions += action.amount;
        });

        res.json({
            game_id: gameId,
            statistics: actionStats,
            recent_actions: actions.slice(-10) // Last 10 actions
        });

    } catch (error) {
        console.error('Error getting action summary:', error);
        res.status(500).json({ message: 'Failed to get action summary' });
    }
});

module.exports = router;