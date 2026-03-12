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
// GAME STATE ENDPOINTS
// ─────────────────────────────────────────

// GET /games/:gameId - Get full game state
router.get('/:gameId', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;

        // Get game info
        const [gameResult] = await db.execute(`
            SELECT g.*, t.name as table_name, t.small_blind, t.big_blind
            FROM games g
            JOIN tables t ON g.table_id = t.table_id
            WHERE g.game_id = ?
        `, [gameId]);

        if (gameResult.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        const game = gameResult[0];

        // Get all players in this game with their current state
        const [playersResult] = await db.execute(`
            SELECT 
                gp.*,
                p.username,
                tp.seat_number,
                tp.chip_stack as table_chip_stack
            FROM game_players gp
            JOIN players p ON gp.player_id = p.player_id
            JOIN table_players tp ON tp.table_id = ? AND tp.player_id = gp.player_id
            WHERE gp.game_id = ?
            ORDER BY tp.seat_number
        `, [game.table_id, gameId]);

        // Get most recent action to determine whose turn it is
        const [lastActionResult] = await db.execute(`
            SELECT player_id, action_type
            FROM actions 
            WHERE game_id = ? 
            ORDER BY acted_at DESC 
            LIMIT 1
        `, [gameId]);

        // Parse community cards JSON
        let communityCards = [];
        if (game.community_cards) {
            try {
                communityCards = JSON.parse(game.community_cards);
            } catch (e) {
                console.warn('Invalid community_cards JSON:', game.community_cards);
            }
        }

        // Parse hole cards for each player
        const players = playersResult.map(player => {
            let holeCards = [];
            if (player.hole_cards) {
                try {
                    // Handle both proper JSON string and array literal string
                    if (typeof player.hole_cards === 'string') {
                        // First try to parse as JSON
                        try {
                            holeCards = JSON.parse(player.hole_cards);
                        } catch (jsonError) {
                            // If that fails, try to handle array literal format
                            const cleanedString = player.hole_cards
                                .replace(/'/g, '"')  // Replace single quotes with double quotes
                                .replace(/\s+/g, ' ') // Normalize whitespace
                                .trim();
                            holeCards = JSON.parse(cleanedString);
                        }
                    } else if (Array.isArray(player.hole_cards)) {
                        holeCards = player.hole_cards;
                    }
                } catch (e) {
                    console.warn('Invalid hole_cards for player', player.player_id, ':', player.hole_cards);
                }
            }

            return {
                player_id: player.player_id,
                username: player.username,
                seat_number: player.seat_number,
                hole_cards: holeCards,
                chips_start: player.chips_start,
                chips_end: player.chips_end,
                current_bet: player.current_bet,
                is_folded: player.is_folded,
                is_all_in: player.is_all_in
            };
        });

        const response = {
            game_id: game.game_id,
            table_id: game.table_id,
            table_name: game.table_name,
            small_blind: game.small_blind,
            big_blind: game.big_blind,
            pot: game.pot,
            stage: game.stage,
            dealer_seat: game.dealer_seat,
            active_seat: game.active_seat,
            active_player_id: game.active_seat ? 
                players.find(p => p.seat_number === game.active_seat)?.player_id : null,
            community_cards: communityCards,
            players: players,
            started_at: game.started_at,
            ended_at: game.ended_at
        };

        res.json(response);

    } catch (error) {
        console.error('Error fetching game:', error);
        res.status(500).json({ message: 'Failed to fetch game state' });
    }
});

// GET /tables/:tableId/active-game - Find active game for a table
router.get('/tables/:tableId/active-game', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;

        const [gameResult] = await db.execute(`
            SELECT game_id, stage, started_at
            FROM games 
            WHERE table_id = ? AND ended_at IS NULL
            ORDER BY started_at DESC
            LIMIT 1
        `, [tableId]);

        if (gameResult.length === 0) {
            return res.status(404).json({ message: 'No active game found' });
        }

        res.json(gameResult[0]);

    } catch (error) {
        console.error('Error finding active game:', error);
        res.status(500).json({ message: 'Failed to find active game' });
    }
});

// ─────────────────────────────────────────
// GAME MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────

// POST /games - Start a new game on a table
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { table_id, dealer_seat } = req.body;

        if (!table_id || !dealer_seat) {
            return res.status(400).json({ 
                message: 'table_id and dealer_seat are required' 
            });
        }

        // Start transaction
        await db.query('START TRANSACTION');

        try {
            // Check if table exists and has players
            const [tableResult] = await db.execute(
                'SELECT * FROM tables WHERE table_id = ?',
                [table_id]
            );

            if (tableResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Table not found' });
            }

            // Get active players at table
            const [playersResult] = await db.execute(`
                SELECT tp.*, p.username
                FROM table_players tp
                JOIN players p ON tp.player_id = p.player_id
                WHERE tp.table_id = ? AND tp.status = 'active'
                ORDER BY tp.seat_number
            `, [table_id]);

            if (playersResult.length < 2) {
                await db.query('ROLLBACK');
                return res.status(400).json({ 
                    message: 'Need at least 2 players to start a game' 
                });
            }

            // Check if there's already an active game
            const [existingGame] = await db.execute(
                'SELECT game_id FROM games WHERE table_id = ? AND ended_at IS NULL',
                [table_id]
            );

            if (existingGame.length > 0) {
                await db.query('ROLLBACK');
                return res.status(409).json({ 
                    message: 'Game already in progress on this table' 
                });
            }

            // Deal cards using game logic
            const gameState = gameLogic.dealHoldemGame(playersResult);
            
            // Create new game
            const [gameResult] = await db.execute(`
                INSERT INTO games (table_id, pot, stage, dealer_seat, active_seat)
                VALUES (?, 0, 'pre_flop', ?, ?)
            `, [table_id, dealer_seat, router.getNextSeat(playersResult, dealer_seat)]);

            const gameId = gameResult.insertId;

            // Add all active players to the game with hole cards
            for (const player of playersResult) {
                const holeCards = gameState.playerCards[player.player_id];
                // Ensure we're storing proper JSON
                const holeCardsJson = JSON.stringify(holeCards);
                
                await db.execute(`
                    INSERT INTO game_players (game_id, player_id, hole_cards, chips_start, current_bet, is_folded, is_all_in)
                    VALUES (?, ?, ?, ?, 0, FALSE, FALSE)
                `, [gameId, player.player_id, holeCardsJson, player.chip_stack]);
            }

            // Update table status to active
            await db.execute(
                'UPDATE tables SET status = "active" WHERE table_id = ?',
                [table_id]
            );

            await db.query('COMMIT');

            res.status(201).json({
                message: 'Game started successfully',
                game_id: gameId,
                table_id: table_id,
                player_count: playersResult.length
            });

        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }

    } catch (error) {
        console.error('Error starting game:', error);
        res.status(500).json({ message: 'Failed to start game' });
    }
});

// PUT /games/:gameId/stage - Advance game stage (flop, turn, river, showdown)
router.put('/:gameId/stage', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const { stage } = req.body;

        const validStages = ['pre_flop', 'flop', 'turn', 'river', 'showdown'];
        if (!validStages.includes(stage)) {
            return res.status(400).json({ message: 'Invalid stage' });
        }

        // Get current game state
        const [currentGameResult] = await db.execute(
            'SELECT * FROM games WHERE game_id = ?',
            [gameId]
        );

        if (currentGameResult.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        const currentGame = currentGameResult[0];
        let communityCards = [];
        
        // Parse existing community cards
        if (currentGame.community_cards) {
            try {
                communityCards = JSON.parse(currentGame.community_cards);
            } catch (e) {
                console.warn('Invalid community_cards JSON:', currentGame.community_cards);
            }
        }

        // Deal community cards using game logic
        let newCommunityCards = communityCards;
        if (['flop', 'turn', 'river'].includes(stage)) {
            // For now, create a dummy deck - in production you'd store the deck state
            const deck = gameLogic.createShuffledDeck();
            const cardResult = gameLogic.dealCommunityCards(deck, communityCards, stage);
            newCommunityCards = cardResult.communityCards;
        }

        await db.execute(
            'UPDATE games SET stage = ?, community_cards = ? WHERE game_id = ?',
            [stage, JSON.stringify(newCommunityCards), gameId]
        );

        res.json({ 
            message: 'Game stage updated successfully',
            stage: stage,
            community_cards: newCommunityCards
        });

    } catch (error) {
        console.error('Error updating game stage:', error);
        res.status(500).json({ message: 'Failed to update game stage' });
    }
});

// PUT /games/:gameId/end - End a game
router.put('/:gameId/end', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;

        // Start transaction
        await db.query('START TRANSACTION');

        try {
            // Get game info with community cards
            const [gameResult] = await db.execute(`
                SELECT g.*, t.name as table_name
                FROM games g
                JOIN tables t ON g.table_id = t.table_id
                WHERE g.game_id = ?
            `, [gameId]);

            if (gameResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Game not found' });
            }

            const game = gameResult[0];

            // Get all players in the game
            const [gamePlayers] = await db.execute(`
                SELECT 
                    gp.*,
                    p.username,
                    tp.seat_number
                FROM game_players gp
                JOIN players p ON gp.player_id = p.player_id
                JOIN table_players tp ON tp.table_id = ? AND tp.player_id = gp.player_id
                WHERE gp.game_id = ?
            `, [game.table_id, gameId]);

            let winners = [];
            let potDistribution = [];

            // If we have community cards, determine winners using game logic
            if (game.community_cards && game.stage === 'showdown') {
                try {
                    const communityCards = JSON.parse(game.community_cards);
                    
                    if (communityCards.length === 5) {
                        // Determine winners using pokersolver
                        winners = gameLogic.determineWinners(gamePlayers, communityCards);
                        potDistribution = gameLogic.distributePot(game.pot, winners);
                        
                        console.log('Winners determined:', winners);
                        console.log('Pot distribution:', potDistribution);
                    }
                } catch (error) {
                    console.error('Error determining winners:', error);
                    // Fall back to manual winner determination if needed
                }
            }

            // Update final chip counts based on pot distribution
            for (const player of gamePlayers) {
                let finalChips = player.chips_start; // Default to starting chips if no winnings
                
                // Find if this player won anything
                const winnings = potDistribution.find(w => w.player_id === player.player_id);
                if (winnings) {
                    finalChips = (player.chips_end || player.chips_start) + winnings.amount;
                } else {
                    // Player didn't win, keep their current chip count
                    finalChips = player.chips_end || player.chips_start;
                }

                // Update game_players with final chip count
                await db.execute(`
                    UPDATE game_players 
                    SET chips_end = ? 
                    WHERE game_id = ? AND player_id = ?
                `, [finalChips, gameId, player.player_id]);

                // Update table player chip stack
                await db.execute(`
                    UPDATE table_players 
                    SET chip_stack = ? 
                    WHERE table_id = ? AND player_id = ?
                `, [finalChips, game.table_id, player.player_id]);
            }

            // End the game
            await db.execute(
                'UPDATE games SET ended_at = NOW(), stage = "showdown" WHERE game_id = ?',
                [gameId]
            );

            // Update table status back to waiting
            await db.execute(
                'UPDATE tables SET status = "waiting" WHERE table_id = ?',
                [game.table_id]
            );

            await db.query('COMMIT');

            res.json({ 
                message: 'Game ended successfully',
                winners: winners,
                pot_distribution: potDistribution,
                total_pot: game.pot
            });

        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }

    } catch (error) {
        console.error('Error ending game:', error);
        res.status(500).json({ message: 'Failed to end game' });
    }
});

// POST /games/:gameId/evaluate - Evaluate current hands (for showdown)
router.post('/:gameId/evaluate', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;

        // Get game with community cards
        const [gameResult] = await db.execute(`
            SELECT * FROM games WHERE game_id = ? AND ended_at IS NULL
        `, [gameId]);

        if (gameResult.length === 0) {
            return res.status(404).json({ message: 'Game not found or already ended' });
        }

        const game = gameResult[0];

        if (!game.community_cards) {
            return res.status(400).json({ message: 'No community cards dealt yet' });
        }

        const communityCards = JSON.parse(game.community_cards);

        if (communityCards.length < 3) {
            return res.status(400).json({ message: 'Need at least flop to evaluate hands' });
        }

        // Get all active players
        const [playersResult] = await db.execute(`
            SELECT 
                gp.*,
                p.username,
                tp.seat_number
            FROM game_players gp
            JOIN players p ON gp.player_id = p.player_id
            JOIN table_players tp ON tp.table_id = ? AND tp.player_id = gp.player_id
            WHERE gp.game_id = ? AND gp.is_folded = FALSE
            ORDER BY tp.seat_number
        `, [game.table_id, gameId]);

        // Evaluate each player's hand
        const handEvaluations = [];

        for (const player of playersResult) {
            let holeCards = player.hole_cards;
            
            if (typeof holeCards === 'string') {
                try {
                    holeCards = JSON.parse(holeCards);
                } catch (e) {
                    console.error('Failed to parse hole cards for player', player.player_id);
                    continue;
                }
            }

            try {
                const evaluation = gameLogic.evaluateHand(holeCards, communityCards);
                
                handEvaluations.push({
                    player_id: player.player_id,
                    username: player.username,
                    seat_number: player.seat_number,
                    hole_cards: holeCards,
                    hand_strength: evaluation.name,
                    hand_description: evaluation.description,
                    hand_rank: evaluation.rank,
                    best_cards: evaluation.cards
                });
            } catch (error) {
                console.error(`Error evaluating hand for player ${player.player_id}:`, error);
            }
        }

        // Sort by hand strength (lower rank number = better hand)
        handEvaluations.sort((a, b) => a.hand_rank - b.hand_rank);

        res.json({
            game_id: gameId,
            stage: game.stage,
            community_cards: communityCards,
            hand_evaluations: handEvaluations
        });

    } catch (error) {
        console.error('Error evaluating hands:', error);
        res.status(500).json({ message: 'Failed to evaluate hands' });
    }
});

// GET /games/:gameId/history - Get action history for a game 
router.get('/:gameId/history', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;

        const [actions] = await db.execute(`
            SELECT a.*, p.username
            FROM actions a
            JOIN players p ON a.player_id = p.player_id
            WHERE a.game_id = ?
            ORDER BY a.acted_at ASC
        `, [gameId]);

        res.json(actions);

    } catch (error) {
        console.error('Error fetching game history:', error);
        res.status(500).json({ message: 'Failed to fetch game history' });
    }
});

router.get('/:gameId/formatted', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const playerId = req.user.playerId; // For determining available actions

        // Get game info
        const [gameResult] = await db.execute(`
            SELECT g.*, t.name as table_name, t.small_blind, t.big_blind
            FROM games g
            JOIN tables t ON g.table_id = t.table_id
            WHERE g.game_id = ?
        `, [gameId]);

        if (gameResult.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        const game = gameResult[0];

        // Get all players in this game
        const [playersResult] = await db.execute(`
            SELECT 
                gp.*,
                p.username,
                tp.seat_number,
                tp.chip_stack as table_chip_stack,
                tp.status
            FROM game_players gp
            JOIN players p ON gp.player_id = p.player_id
            JOIN table_players tp ON tp.table_id = ? AND tp.player_id = gp.player_id
            WHERE gp.game_id = ?
            ORDER BY tp.seat_number
        `, [game.table_id, gameId]);

        // Format game data using utilities
        const gameData = {
            ...game,
            players: playersResult
        };
        
        const formattedGame = gameUtils.formatGameState(gameData);
        
        // Add additional frontend-specific data
        formattedGame.stage_info = gameUtils.getStageInfo(game.stage);
        
        // Get available actions for the requesting player
        formattedGame.available_actions = gameUtils.getAvailableActions(formattedGame, playerId);
        
        // Calculate pot odds for the requesting player if there's a bet to call
        const requestingPlayer = formattedGame.players.find(p => p.player_id === playerId);
        if (requestingPlayer) {
            const activePlayers = formattedGame.players.filter(p => !p.is_folded);
            const highestBet = Math.max(...activePlayers.map(p => p.current_bet), 0);
            const amountToCall = highestBet - requestingPlayer.current_bet;
            
            formattedGame.pot_odds = gameUtils.calculatePotOdds(formattedGame.pot, amountToCall);
            formattedGame.requesting_player = requestingPlayer;
        }

        res.json(formattedGame);

    } catch (error) {
        console.error('Error fetching formatted game:', error);
        res.status(500).json({ message: 'Failed to fetch formatted game state' });
    }
});

// POST /games/:gameId/action - Process player action
router.post('/:gameId/action', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const { action_type, amount } = req.body;
        const playerId = req.user.playerId;

        if (!action_type) {
            return res.status(400).json({ message: 'action_type is required' });
        }

        // Start transaction
        await db.query('START TRANSACTION');

        try {
            // Get current game state
            const [gameResult] = await db.execute(`
                SELECT g.*, t.small_blind, t.big_blind 
                FROM games g 
                JOIN tables t ON g.table_id = t.table_id 
                WHERE g.game_id = ? AND g.ended_at IS NULL
            `, [gameId]);

            if (gameResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Game not found or already ended' });
            }

            const game = gameResult[0];

            // Get player info
            const [playerResult] = await db.execute(`
                SELECT gp.*, tp.seat_number, tp.chip_stack
                FROM game_players gp
                JOIN table_players tp ON tp.table_id = ? AND tp.player_id = gp.player_id
                WHERE gp.game_id = ? AND gp.player_id = ?
            `, [game.table_id, gameId, playerId]);

            if (playerResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Player not in this game' });
            }

            const player = playerResult[0];

            // Verify it's the player's turn
            if (game.active_seat !== player.seat_number) {
                await db.query('ROLLBACK');
                return res.status(400).json({ message: 'Not your turn' });
            }

            // Process the action
            const actionResult = await router.processPlayerAction({
                gameId,
                playerId,
                player,
                game,
                action_type,
                amount: amount || 0
            });

            if (!actionResult.success) {
                await db.query('ROLLBACK');
                return res.status(400).json({ message: actionResult.error });
            }

            // Record the action
            await db.execute(`
                INSERT INTO actions (game_id, player_id, action_type, amount, stage, acted_at)
                VALUES (?, ?, ?, ?, ?, NOW())
            `, [gameId, playerId, action_type, actionResult.amount, game.stage]);

            // Advance to next player or next stage
            const nextState = await router.advanceGameState(gameId, game.table_id);

            await db.query('COMMIT');

            res.json({
                message: `Action '${action_type}' processed successfully`,
                action: {
                    type: action_type,
                    amount: actionResult.amount
                },
                next_active_seat: nextState.next_active_seat,
                stage: nextState.stage,
                pot: nextState.pot
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

// Helper function to process player actions
router.processPlayerAction = async function(params) {
    const { gameId, playerId, player, game, action_type, amount } = params;

    switch (action_type) {
        case 'fold':
            await db.execute(
                'UPDATE game_players SET is_folded = TRUE WHERE game_id = ? AND player_id = ?',
                [gameId, playerId]
            );
            return { success: true, amount: 0 };

        case 'check':
            // Verify no bet to call
            const [checkBetResult] = await db.execute(`
                SELECT MAX(current_bet) as max_bet FROM game_players 
                WHERE game_id = ? AND is_folded = FALSE
            `, [gameId]);
            
            if (checkBetResult[0].max_bet > player.current_bet) {
                return { success: false, error: 'Cannot check - there is a bet to call' };
            }
            return { success: true, amount: 0 };

        case 'call':
            const [callBetResult] = await db.execute(`
                SELECT MAX(current_bet) as max_bet FROM game_players 
                WHERE game_id = ? AND is_folded = FALSE
            `, [gameId]);
            
            const callAmount = callBetResult[0].max_bet - player.current_bet;
            if (callAmount <= 0) {
                return { success: false, error: 'No bet to call' };
            }
            
            const actualCallAmount = Math.min(callAmount, player.chip_stack);
            
            // Update player bet and chips
            await db.execute(`
                UPDATE game_players 
                SET current_bet = current_bet + ?, is_all_in = (? >= chip_stack)
                WHERE game_id = ? AND player_id = ?
            `, [actualCallAmount, actualCallAmount, gameId, playerId]);
            
            await db.execute(`
                UPDATE table_players 
                SET chip_stack = chip_stack - ?
                WHERE table_id = ? AND player_id = ?
            `, [actualCallAmount, game.table_id, playerId]);
            
            // Update pot
            await db.execute(
                'UPDATE games SET pot = pot + ? WHERE game_id = ?',
                [actualCallAmount, gameId]
            );
            
            return { success: true, amount: actualCallAmount };

        case 'raise':
            if (!amount || amount <= 0) {
                return { success: false, error: 'Raise amount required' };
            }
            
            const [raiseBetResult] = await db.execute(`
                SELECT MAX(current_bet) as max_bet FROM game_players 
                WHERE game_id = ? AND is_folded = FALSE
            `, [gameId]);
            
            const currentMaxBet = raiseBetResult[0].max_bet || 0;
            const minRaise = currentMaxBet + (game.big_blind || 20);
            
            if (amount < minRaise) {
                return { success: false, error: `Minimum raise is ${minRaise}` };
            }
            
            const raiseAmount = Math.min(amount - player.current_bet, player.chip_stack);
            
            await db.execute(`
                UPDATE game_players 
                SET current_bet = ?, is_all_in = (? >= chip_stack)
                WHERE game_id = ? AND player_id = ?
            `, [amount, raiseAmount, gameId, playerId]);
            
            await db.execute(`
                UPDATE table_players 
                SET chip_stack = chip_stack - ?
                WHERE table_id = ? AND player_id = ?
            `, [raiseAmount, game.table_id, playerId]);
            
            await db.execute(
                'UPDATE games SET pot = pot + ? WHERE game_id = ?',
                [raiseAmount, gameId]
            );
            
            return { success: true, amount: raiseAmount };

        case 'all_in':
            const allInAmount = player.chip_stack;
            
            await db.execute(`
                UPDATE game_players 
                SET current_bet = current_bet + ?, is_all_in = TRUE
                WHERE game_id = ? AND player_id = ?
            `, [allInAmount, gameId, playerId]);
            
            await db.execute(`
                UPDATE table_players 
                SET chip_stack = 0
                WHERE table_id = ? AND player_id = ?
            `, [game.table_id, playerId]);
            
            await db.execute(
                'UPDATE games SET pot = pot + ? WHERE game_id = ?',
                [allInAmount, gameId]
            );
            
            return { success: true, amount: allInAmount };

        default:
            return { success: false, error: 'Invalid action type' };
    }
};

// Helper function to advance game state
router.advanceGameState = async function(gameId, tableId) {
    // Get current game state
    const [gameResult] = await db.execute(
        'SELECT * FROM games WHERE game_id = ?',
        [gameId]
    );
    const game = gameResult[0];

    // Get active players
    const [playersResult] = await db.execute(`
        SELECT gp.*, tp.seat_number
        FROM game_players gp
        JOIN table_players tp ON tp.table_id = ? AND tp.player_id = gp.player_id
        WHERE gp.game_id = ? AND (gp.is_folded = FALSE OR gp.is_all_in = TRUE)
        ORDER BY tp.seat_number
    `, [tableId, gameId]);

    // Check if betting round is complete
    const activePlayers = playersResult.filter(p => !p.is_folded && !p.is_all_in);
    const allInPlayers = playersResult.filter(p => p.is_all_in);
    
    // If only one active player remains, end the hand
    if (activePlayers.length <= 1) {
        await router.advanceToNextStage(gameId, game.stage);
        return {
            next_active_seat: null,
            stage: router.getNextStage(game.stage),
            pot: game.pot
        };
    }

    // Check if all active players have matched the highest bet
    const maxBet = Math.max(...playersResult.map(p => p.current_bet), 0);
    const bettingComplete = activePlayers.every(p => p.current_bet === maxBet);

    if (bettingComplete) {
        // Advance to next stage
        const nextStage = await router.advanceToNextStage(gameId, game.stage);
        
        // Reset all player bets for next round
        await db.execute(
            'UPDATE game_players SET current_bet = 0 WHERE game_id = ?',
            [gameId]
        );
        
        return {
            next_active_seat: router.getNextActiveSeat(playersResult, game.dealer_seat),
            stage: nextStage,
            pot: game.pot
        };
    } else {
        // Move to next player
        const nextActiveSeat = router.getNextActiveSeat(playersResult, game.active_seat);
        
        await db.execute(
            'UPDATE games SET active_seat = ? WHERE game_id = ?',
            [nextActiveSeat, gameId]
        );
        
        return {
            next_active_seat: nextActiveSeat,
            stage: game.stage,
            pot: game.pot
        };
    }
};

// Helper function to advance to next stage
router.advanceToNextStage = async function(gameId, currentStage) {
    const stageProgression = {
        'pre_flop': 'flop',
        'flop': 'turn', 
        'turn': 'river',
        'river': 'showdown'
    };
    
    const nextStage = stageProgression[currentStage];
    
    if (nextStage) {
        await db.execute(
            'UPDATE games SET stage = ? WHERE game_id = ?',
            [nextStage, gameId]
        );
    }
    
    return nextStage;
};

// Helper function to get next stage
router.getNextStage = function(currentStage) {
    const stageProgression = {
        'pre_flop': 'flop',
        'flop': 'turn',
        'turn': 'river', 
        'river': 'showdown'
    };
    return stageProgression[currentStage] || 'showdown';
};

// Helper function to get next active seat
router.getNextActiveSeat = function(players, currentSeat) {
    const activePlayers = players.filter(p => !p.is_folded && !p.is_all_in);
    if (activePlayers.length === 0) return null;
    
    const sortedSeats = activePlayers.map(p => p.seat_number).sort((a, b) => a - b);
    const currentIndex = sortedSeats.indexOf(currentSeat);
    
    if (currentIndex === -1 || currentIndex === sortedSeats.length - 1) {
        return sortedSeats[0]; // Wrap around
    }
    
    return sortedSeats[currentIndex + 1];
};

// Helper function to get next seat after dealer
router.getNextSeat = function(players, dealerSeat) {
    const sortedSeats = players.map(p => p.seat_number).sort((a, b) => a - b);
    const dealerIndex = sortedSeats.indexOf(dealerSeat);
    
    if (dealerIndex === -1 || dealerIndex === sortedSeats.length - 1) {
        return sortedSeats[0]; // Wrap around
    }
    
    return sortedSeats[dealerIndex + 1];
};

module.exports = router;
