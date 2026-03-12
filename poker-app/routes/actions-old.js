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
// PLAYER ACTION ENDPOINTS
// ─────────────────────────────────────────

// POST /actions - Submit a player action
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { game_id, action_type, amount = 0, stage } = req.body;
        const player_id = req.user.playerId;

        // Validate input
        if (!game_id || !action_type || !stage) {
            return res.status(400).json({ 
                message: 'game_id, action_type, and stage are required' 
            });
        }

        const validActions = ['fold', 'check', 'call', 'raise', 'all_in', 'blind'];
        if (!validActions.includes(action_type)) {
            return res.status(400).json({ message: 'Invalid action type' });
        }

        const validStages = ['pre_flop', 'flop', 'turn', 'river'];
        if (!validStages.includes(stage)) {
            return res.status(400).json({ message: 'Invalid stage' });
        }

        // Start transaction
        await db.query('START TRANSACTION');

        try {
            // Verify game exists and is active
            const [gameResult] = await db.execute(`
                SELECT g.*, t.small_blind, t.big_blind
                FROM games g
                JOIN tables t ON g.table_id = t.table_id
                WHERE g.game_id = ? AND g.ended_at IS NULL
            `, [game_id]);

            if (gameResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Game not found or already ended' });
            }

            const game = gameResult[0];

            // Verify player is in this game
            const [playerResult] = await db.execute(`
                SELECT gp.*, tp.seat_number, tp.chip_stack as table_chip_stack
                FROM game_players gp
                JOIN table_players tp ON tp.table_id = ? AND tp.player_id = gp.player_id
                WHERE gp.game_id = ? AND gp.player_id = ? AND gp.is_folded = FALSE
            `, [game.table_id, game_id, player_id]);

            if (playerResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(403).json({ 
                    message: 'Player not in this game or already folded' 
                });
            }

            const player = playerResult[0];

            // Verify it's the player's turn (basic check - you might want more sophisticated turn logic)
            if (game.active_seat && game.active_seat !== player.seat_number) {
                await db.query('ROLLBACK');
                return res.status(400).json({ message: 'Not your turn' });
            }

            // Get current betting info
            const [bettingResult] = await db.execute(`
                SELECT MAX(current_bet) as max_bet, MIN(current_bet) as min_bet
                FROM game_players 
                WHERE game_id = ? AND is_folded = FALSE
            `, [game_id]);

            const maxBet = bettingResult[0].max_bet || 0;
            const toCall = Math.max(0, maxBet - player.current_bet);

            // Validate action amounts more precisely
            let finalAmount = amount;
            let updatedCurrentBet = player.current_bet;
            let updatedChipsEnd = player.chips_end || player.chips_start;
            let isAllIn = false;
            let isFolded = false;

            // Get current highest bet to calculate proper call/raise amounts
            const [bettingInfoResult] = await db.execute(`
                SELECT 
                    MAX(current_bet) as highest_bet,
                    COUNT(CASE WHEN is_folded = FALSE THEN 1 END) as active_players
                FROM game_players 
                WHERE game_id = ?
            `, [game_id]);

            const highestBet = bettingInfoResult[0].highest_bet || 0;
            const activePlayersCount = bettingInfoResult[0].active_players || 0;
            const amountToCall = Math.max(0, highestBet - player.current_bet);

            switch (action_type) {
                case 'fold':
                    isFolded = true;
                    finalAmount = 0;
                    break;

                case 'check':
                    if (amountToCall > 0) {
                        await db.query('ROLLBACK');
                        return res.status(400).json({ 
                            message: `Cannot check, must call ${amountToCall} chips or fold` 
                        });
                    }
                    finalAmount = 0;
                    break;

                case 'call':
                    if (amountToCall === 0) {
                        await db.query('ROLLBACK');
                        return res.status(400).json({ message: 'Nothing to call, you can check' });
                    }
                    
                    finalAmount = Math.min(amountToCall, updatedChipsEnd);
                    
                    if (finalAmount === updatedChipsEnd && finalAmount < amountToCall) {
                        isAllIn = true;
                    }
                    
                    updatedCurrentBet += finalAmount;
                    updatedChipsEnd -= finalAmount;
                    break;

                case 'raise':
                    const minimumRaise = highestBet + (game.big_blind || 20); // Use big blind from table
                    
                    if (amount < minimumRaise) {
                        await db.query('ROLLBACK');
                        return res.status(400).json({ 
                            message: `Minimum raise is ${minimumRaise} chips` 
                        });
                    }

                    const raiseAmount = amount - player.current_bet;
                    
                    if (raiseAmount > updatedChipsEnd) {
                        // Player doesn't have enough chips for this raise, make it all-in
                        finalAmount = updatedChipsEnd;
                        isAllIn = true;
                    } else {
                        finalAmount = raiseAmount;
                    }

                    updatedCurrentBet = player.current_bet + finalAmount;
                    updatedChipsEnd -= finalAmount;
                    break;

                case 'all_in':
                    finalAmount = updatedChipsEnd;
                    updatedCurrentBet += finalAmount;
                    updatedChipsEnd = 0;
                    isAllIn = true;
                    break;

                case 'blind':
                    // For posting blinds - typically handled automatically
                    if (amount > updatedChipsEnd) {
                        finalAmount = updatedChipsEnd;
                        isAllIn = true;
                    } else {
                        finalAmount = amount;
                    }
                    updatedCurrentBet += finalAmount;
                    updatedChipsEnd -= finalAmount;
                    break;

                default:
                    await db.query('ROLLBACK');
                    return res.status(400).json({ message: 'Invalid action type' });
            }

            // Record the action
            await db.execute(`
                INSERT INTO actions (game_id, player_id, action_type, amount, stage)
                VALUES (?, ?, ?, ?, ?)
            `, [game_id, player_id, action_type, finalAmount, stage]);

            // Update player state in game
            await db.execute(`
                UPDATE game_players 
                SET current_bet = ?, chips_end = ?, is_folded = ?, is_all_in = ?
                WHERE game_id = ? AND player_id = ?
            `, [updatedCurrentBet, updatedChipsEnd, isFolded, isAllIn, game_id, player_id]);

            // Update pot
            const newPot = game.pot + finalAmount;
            await db.execute(
                'UPDATE games SET pot = ? WHERE game_id = ?',
                [newPot, game_id]
            );

            // Update table player chip stack
            await db.execute(`
                UPDATE table_players 
                SET chip_stack = ?
                WHERE table_id = ? AND player_id = ?
            `, [updatedChipsEnd, game.table_id, player_id]);

            // Determine next active player (simplified logic - you may want more sophisticated turn management)
            if (!isFolded) {
                const [nextPlayerResult] = await db.execute(`
                    SELECT tp.seat_number, tp.player_id
                    FROM table_players tp
                    JOIN game_players gp ON tp.player_id = gp.player_id AND gp.game_id = ?
                    WHERE tp.table_id = ? 
                      AND tp.seat_number > ? 
                      AND gp.is_folded = FALSE 
                      AND tp.status = 'active'
                    ORDER BY tp.seat_number ASC
                    LIMIT 1
                `, [game_id, game.table_id, player.seat_number]);

                if (nextPlayerResult.length > 0) {
                    await db.execute(
                        'UPDATE games SET active_seat = ? WHERE game_id = ?',
                        [nextPlayerResult[0].seat_number, game_id]
                    );
                } else {
                    // Wrap around to first player
                    const [firstPlayerResult] = await db.execute(`
                        SELECT tp.seat_number
                        FROM table_players tp
                        JOIN game_players gp ON tp.player_id = gp.player_id AND gp.game_id = ?
                        WHERE tp.table_id = ? 
                          AND gp.is_folded = FALSE 
                          AND tp.status = 'active'
                        ORDER BY tp.seat_number ASC
                        LIMIT 1
                    `, [game_id, game.table_id]);

                    if (firstPlayerResult.length > 0) {
                        await db.execute(
                            'UPDATE games SET active_seat = ? WHERE game_id = ?',
                            [firstPlayerResult[0].seat_number, game_id]
                        );
                    }
                }
            }

            await db.query('COMMIT');

            res.json({
                message: 'Action recorded successfully',
                action_type,
                amount: finalAmount,
                pot: newPot,
                player_chips: updatedChipsEnd,
                is_all_in: isAllIn,
                is_folded: isFolded
            });

        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
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

// POST /actions/blinds/:gameId - Post blinds automatically
router.post('/blinds/:gameId', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;

        // Start transaction
        await db.query('START TRANSACTION');

        try {
            // Get game and table info
            const [gameResult] = await db.execute(`
                SELECT g.*, t.small_blind, t.big_blind
                FROM games g
                JOIN tables t ON g.table_id = t.table_id
                WHERE g.game_id = ? AND g.ended_at IS NULL
            `, [gameId]);

            if (gameResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Game not found' });
            }

            const game = gameResult[0];

            // Find small blind and big blind seats
            const dealerSeat = game.dealer_seat;
            
            // Get all active players ordered by seat
            const [playersResult] = await db.execute(`
                SELECT tp.*, gp.player_id as game_player_id
                FROM table_players tp
                JOIN game_players gp ON tp.player_id = gp.player_id AND gp.game_id = ?
                WHERE tp.table_id = ? 
                  AND tp.status = 'active' 
                  AND gp.is_folded = FALSE
                ORDER BY tp.seat_number
            `, [gameId, game.table_id]);

            if (playersResult.length < 2) {
                await db.query('ROLLBACK');
                return res.status(400).json({ message: 'Need at least 2 players for blinds' });
            }

            // Find dealer position in array
            const dealerIndex = playersResult.findIndex(p => p.seat_number === dealerSeat);
            if (dealerIndex === -1) {
                await db.query('ROLLBACK');
                return res.status(400).json({ message: 'Dealer not found among active players' });
            }

            // Small blind is next player after dealer
            const sbIndex = (dealerIndex + 1) % playersResult.length;
            const sbPlayer = playersResult[sbIndex];

            // Big blind is next player after small blind
            const bbIndex = (dealerIndex + 2) % playersResult.length;
            const bbPlayer = playersResult[bbIndex];

            // Post small blind
            await db.execute(`
                INSERT INTO actions (game_id, player_id, action_type, amount, stage)
                VALUES (?, ?, 'blind', ?, 'pre_flop')
            `, [gameId, sbPlayer.player_id, game.small_blind]);

            await db.execute(`
                UPDATE game_players 
                SET current_bet = ?, chips_end = chips_start - ?
                WHERE game_id = ? AND player_id = ?
            `, [game.small_blind, game.small_blind, gameId, sbPlayer.player_id]);

            // Post big blind
            await db.execute(`
                INSERT INTO actions (game_id, player_id, action_type, amount, stage)
                VALUES (?, ?, 'blind', ?, 'pre_flop')
            `, [gameId, bbPlayer.player_id, game.big_blind]);

            await db.execute(`
                UPDATE game_players 
                SET current_bet = ?, chips_end = chips_start - ?
                WHERE game_id = ? AND player_id = ?
            `, [game.big_blind, game.big_blind, gameId, bbPlayer.player_id]);

            // Update pot
            const totalBlinds = game.small_blind + game.big_blind;
            await db.execute(
                'UPDATE games SET pot = pot + ? WHERE game_id = ?',
                [totalBlinds, gameId]
            );

            // Update table chip stacks
            await db.execute(`
                UPDATE table_players 
                SET chip_stack = chip_stack - ?
                WHERE table_id = ? AND player_id = ?
            `, [game.small_blind, game.table_id, sbPlayer.player_id]);

            await db.execute(`
                UPDATE table_players 
                SET chip_stack = chip_stack - ?
                WHERE table_id = ? AND player_id = ?
            `, [game.big_blind, game.table_id, bbPlayer.player_id]);

            // Set active seat to player after big blind
            const nextPlayerIndex = (bbIndex + 1) % playersResult.length;
            const nextPlayer = playersResult[nextPlayerIndex];

            await db.execute(
                'UPDATE games SET active_seat = ? WHERE game_id = ?',
                [nextPlayer.seat_number, gameId]
            );

            await db.query('COMMIT');

            res.json({
                message: 'Blinds posted successfully',
                small_blind: {
                    player_id: sbPlayer.player_id,
                    username: sbPlayer.username,
                    amount: game.small_blind
                },
                big_blind: {
                    player_id: bbPlayer.player_id,
                    username: bbPlayer.username, 
                    amount: game.big_blind
                },
                next_player_id: nextPlayer.player_id
            });

        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }

    } catch (error) {
        console.error('Error posting blinds:', error);
        res.status(500).json({ message: 'Failed to post blinds' });
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

module.exports = router;
