const db = require('../db/db');
const jwt = require('jsonwebtoken');
const express = require('express');
const gameLogic = require('../gamelogic');
const gameUtils = require('../game-utils');
const { PokerEngine } = require('../engine');
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
// POKER ENGINE INTEGRATION HELPERS
// ─────────────────────────────────────────

function resolveEngine(activeGames, gameId) {
    return activeGames.get(gameId) || activeGames.get(parseInt(gameId));
}

async function createPokerEngine(gameId, players, options, io) {
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

    return engine;
}

async function persistGameState(gameId, engine) {
    try {
        const gameState = engine.getGameState();
        
        console.log(`\n💾 PERSISTING GAME STATE:`);
        console.log(`├─ Game ID: ${gameId}`);
        console.log(`├─ Stage: ${gameState.stage}`);
        console.log(`├─ Pot: ${gameState.pot_structure.totalPot}`);
        console.log(`├─ Players: ${gameState.players.length}`);
        console.log(`├─ Community Cards Raw: ${JSON.stringify(gameState.community_cards)}`);
        console.log(`└─ Community Cards Count: ${gameState.community_cards ? gameState.community_cards.length : 'undefined'}`);
        
        // Ensure community cards is always an array - handle MySQL JSON field quirks
        let communityCards = [];
        if (gameState.community_cards !== null && gameState.community_cards !== undefined) {
            if (Array.isArray(gameState.community_cards)) {
                communityCards = gameState.community_cards;
            } else {
                console.log(`⚠️ Community cards not an array, got: ${typeof gameState.community_cards}`);
                communityCards = [];
            }
        }
        
        const communityCardsJson = JSON.stringify(communityCards);
        console.log(`🔍 JSON to store in DB: "${communityCardsJson}"`);
        
        await db.execute(
            'UPDATE games SET pot = ?, community_cards = ?, stage = ?, ended_at = ? WHERE game_id = ?',
            [
                gameState.pot_structure ? gameState.pot_structure.totalPot : 0,
                communityCardsJson,
                gameState.stage,
                gameState.stage === 'waiting' || gameState.stage === 'game_over' ? new Date() : null,
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
            const [tableResult] = await db.execute(
                'SELECT table_id FROM games WHERE game_id = ?',
                [gameId]
            );
            
            if (tableResult.length > 0) {
                await db.execute(
                    'UPDATE table_players SET chip_stack = ? WHERE player_id = ? AND table_id = ?',
                    [player.stack, player.player_id, tableResult[0].table_id]
                );
            }
        }
        console.log('✅ Game state persisted successfully');
    } catch (error) {
        console.error('❌ Error persisting game state:', error.message);
        console.error('Stack trace:', error.stack);
    }
}

/**
 * Attempt to recover a lost game engine from database state
 */
async function attemptGameRecovery(gameId, activeGames, io) {
    try {
        console.log(`🔧 GAME RECOVERY ATTEMPT for game ${gameId}`);
        
        // Get game info from database
        const [gameResult] = await db.execute(`
            SELECT g.*, t.small_blind, t.big_blind
            FROM games g
            JOIN tables t ON g.table_id = t.table_id
            WHERE g.game_id = ? AND g.ended_at IS NULL
        `, [gameId]);
 
        if (gameResult.length === 0) {
            console.log(`❌ Recovery failed: Game ${gameId} not found or already ended`);
            return { success: false };
        }

        const game = gameResult[0];
        
        // Only recover games that are actively running (not waiting or game_over)
        if (!['pre_flop', 'flop', 'turn', 'river', 'showdown'].includes(game.stage)) {
            console.log(`❌ Recovery skipped: Game ${gameId} not in active stage (${game.stage})`);
            return { success: false };
        }

        // Get players for this game
        const [playersResult] = await db.execute(`
            SELECT 
                tp.player_id,
                p.username,
                tp.seat_number,
                gp.chips_end as current_chips,
                gp.current_bet,
                gp.is_folded,
                gp.is_all_in
            FROM game_players gp
            JOIN players p ON gp.player_id = p.player_id
            JOIN table_players tp ON tp.table_id = ? AND tp.player_id = gp.player_id
            WHERE gp.game_id = ?
            ORDER BY tp.seat_number
        `, [game.table_id, gameId]);

        if (playersResult.length < 2) {
            console.log(`❌ Recovery failed: Not enough players found for game ${gameId}`);
            return { success: false };
        }

        // Prepare players for engine
        const enginePlayers = playersResult.map(player => ({
            player_id: player.player_id,
            username: player.username,
            chips: player.current_chips || 1000,
            seat_number: player.seat_number
        }));

        console.log(`🔧 Recreating engine with ${enginePlayers.length} players`);

        // Create new poker engine
        const engine = await createPokerEngine(gameId, enginePlayers, {
            smallBlind: game.small_blind,
            bigBlind: game.big_blind
        }, io);

        // Store the recovered engine
        activeGames.set(parseInt(gameId), engine);
        console.log(`✅ Game ${gameId} engine recovered and stored`);

        return { success: true, engine: engine };

    } catch (error) {
        console.error(`❌ Game recovery failed for game ${gameId}:`, error.message);
        return { success: false, error: error.message };
    }
}

// ─────────────────────────────────────────
// GAME STATE ENDPOINTS
// ─────────────────────────────────────────

// GET /games/:gameId - Get full game state
router.get('/:gameId', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        
        console.log(`\n🔍 GET GAME STATE REQUEST:`);
        console.log(`├─ Game ID: ${gameId} (type: ${typeof gameId})`);
        console.log(`├─ User ID: ${req.user.playerId}`);
        console.log(`├─ Active games count: ${req.activeGames ? req.activeGames.size : 'undefined'}`);
        
        // Try to get from active engines first - handle both string and number gameId
        let engine = resolveEngine(req.activeGames, gameId);
        if (!engine && typeof gameId === 'string') {
            // Try parsing as number
            const numericGameId = parseInt(gameId);
            if (!isNaN(numericGameId)) {
                engine = req.activeGames.get(numericGameId);
                if (engine) {
                    console.log(`✅ Found active engine using numeric gameId: ${numericGameId}`);
                }
            }
        }
        
        if (engine) {
            console.log(`✅ Found active engine for game ${gameId}`);
            // Game is active - return current engine state
            const gameState = engine.getGameState();
            const isPlayerInGame = gameState.players.some(p => p.player_id === req.user.playerId);
            
            console.log(`├─ Player in game: ${isPlayerInGame}`);
            console.log(`├─ Game stage: ${gameState.stage}`);
            console.log(`├─ Total players: ${gameState.players.length}`);
            
            // Debug betting round and turn info
            if (gameState.betting_round) {
                console.log(`├─ Current player turn: ${gameState.betting_round.current_player}`);
                console.log(`├─ Available actions: ${gameState.betting_round.available_actions?.map(a => a.type).join(', ') || 'none'}`);
                console.log(`├─ Highest bet: ${gameState.betting_round.highest_bet}`);
                console.log(`└─ Is requesting player's turn: ${gameState.betting_round.current_player === req.user.playerId}`);
            } else {
                console.log(`└─ No betting round active (might be between rounds or game over)`);
            }
            
            if (isPlayerInGame) {
                try {
                    const privatePlayerInfo = engine.getPrivatePlayerInfo(req.user.playerId);
                    res.json({
                        ...gameState,
                        currentPlayer: privatePlayerInfo
                    });
                } catch (e) {
                    // Player not found in engine, return public state
                    console.log(`⚠️ Player not found in engine, returning public state`);
                    res.json(gameState);
                }
            } else {
                res.json(gameState);
            }
            return;
        }
        
        console.log(`❌ No active engine found for game ${gameId}, falling back to database`);
        console.log(`🔧 Attempting to recover game engine from database...`);
        
        // Try to recover the game engine if it was lost from memory
        const recoveryResult = await attemptGameRecovery(gameId, req.activeGames, req.io);
        if (recoveryResult.success) {
            console.log(`✅ Successfully recovered game engine for game ${gameId}`);
            const gameState = recoveryResult.engine.getGameState();
            const isPlayerInGame = gameState.players.some(p => p.player_id === req.user.playerId);
            
            if (isPlayerInGame) {
                try {
                    const privatePlayerInfo = recoveryResult.engine.getPrivatePlayerInfo(req.user.playerId);
                    res.json({
                        ...gameState,
                        currentPlayer: privatePlayerInfo
                    });
                    return;
                } catch (e) {
                    res.json(gameState);
                    return;
                }
            } else {
                res.json(gameState);
                return;
            }
        }
        
        console.log(`❌ Game recovery failed, using database state`);
        
        if (req.activeGames && req.activeGames.size > 0) {
            console.log(`🔍 Available active game IDs: [${Array.from(req.activeGames.keys()).join(', ')}]`);
            console.log(`🔍 Available active game types: [${Array.from(req.activeGames.keys()).map(k => typeof k).join(', ')}]`);
        }

        // Game not in memory - fetch from database (completed games)
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

        // Get players for this completed game
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

        // Format for legacy compatibility
        let communityCards = [];
        if (game.community_cards !== null && game.community_cards !== undefined) {
            try {
                console.log(`🔍 Parsing community cards JSON: "${game.community_cards}" (type: ${typeof game.community_cards})`);
                
                // Handle different data types that might come from MySQL JSON field
                if (typeof game.community_cards === 'string') {
                    // If it's an empty string, default to empty array
                    if (game.community_cards.trim() === '') {
                        console.log('⚠️ Empty string detected, using empty array');
                        communityCards = [];
                    } else {
                        communityCards = JSON.parse(game.community_cards);
                    }
                } else if (Array.isArray(game.community_cards)) {
                    // Already parsed as array (some MySQL drivers do this automatically)
                    communityCards = game.community_cards;
                } else if (typeof game.community_cards === 'object') {
                    // Handle object case (MySQL JSON might return as object)
                    communityCards = Array.isArray(game.community_cards) ? game.community_cards : [];
                } else {
                    console.log('⚠️ Unexpected community cards type, using empty array');
                    communityCards = [];
                }
                
                console.log(`✅ Successfully parsed community cards:`, communityCards);
            } catch (e) {
                console.error('❌ Invalid community cards JSON:', game.community_cards);
                console.error('JSON Parse Error:', e.message);
                console.error('Raw value type:', typeof game.community_cards);
                console.error('Raw value length:', game.community_cards?.length);
                console.log('🔧 Falling back to empty array');
                communityCards = [];
            }
        } else {
            console.log('ℹ️ No community cards in database - using empty array');
        }

        const players = playersResult.map(player => {
            let holeCards = [];
            if (player.hole_cards) {
                try {
                    holeCards = JSON.parse(player.hole_cards);
                } catch (e) {
                    console.warn('Invalid hole cards JSON for player', player.player_id);
                }
            }

            return {
                player_id: player.player_id,
                username: player.username,
                seat_number: player.seat_number,
                chips_start: player.chips_start,
                chips_end: player.chips_end,
                current_bet: player.current_bet || 0,
                is_folded: Boolean(player.is_folded),
                is_all_in: Boolean(player.is_all_in),
                hole_cards: holeCards
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
            community_cards: communityCards,
            players: players,
            started_at: game.started_at,
            ended_at: game.ended_at,
            is_active: false // This is a completed game
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

// POST /games - Start a new game on a table using poker engine
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { table_id, dealer_seat } = req.body;
        
        console.log('🎮 GAME CREATION INITIATED');
        console.log(`├─ Table ID: ${table_id}`);
        console.log(`├─ Dealer Seat: ${dealer_seat}`);
        console.log(`└─ Requested by User: ${req.user.playerId}`);

        if (!table_id || dealer_seat === undefined) {
            console.log('❌ Game creation failed: Missing required parameters');
            return res.status(400).json({ 
                message: 'table_id and dealer_seat are required' 
            });
        }

        // Start transaction
        await db.query('START TRANSACTION');
        console.log('🔄 Database transaction started');

        try {
            // Get table info
            const [tableResult] = await db.execute(
                'SELECT * FROM tables WHERE table_id = ?',
                [table_id]
            );

            if (tableResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Table not found' });
            }

            const table = tableResult[0];

            // Get all active players at the table
            const [playersResult] = await db.execute(`
                SELECT tp.*, p.username
                FROM table_players tp
                JOIN players p ON tp.player_id = p.player_id
                WHERE tp.table_id = ? AND tp.status = 'active'
                ORDER BY tp.seat_number
            `, [table_id]);

            console.log(`👥 Found ${playersResult.length} active players at table ${table_id}:`);
            playersResult.forEach(player => {
                console.log(`   ├─ ${player.username} (Seat ${player.seat_number}, Chips: ${player.chip_stack})`);
            });

            if (playersResult.length < 2) {
                console.log('❌ Game creation failed: Not enough players (minimum 2 required)');
                await db.query('ROLLBACK');
                return res.status(400).json({ message: 'Need at least 2 players to start a game' });
            }

            // Create game record
            const [gameInsert] = await db.execute(`
                INSERT INTO games (table_id, dealer_seat, stage) 
                VALUES (?, ?, 'waiting')
            `, [table_id, dealer_seat]);

            const gameId = gameInsert.insertId;
            console.log(`🆔 Game created successfully with ID: ${gameId}`)
            console.log(`🎯 Game stage initialized: waiting`);

            // Create game_players records
            console.log('💺 Registering players in game:');
            for (const player of playersResult) {
                await db.execute(`
                    INSERT INTO game_players (game_id, player_id, chips_start, chips_end) 
                    VALUES (?, ?, ?, ?)
                `, [gameId, player.player_id, player.chip_stack, player.chip_stack]);
                console.log(`   ├─ ${player.username} registered with ${player.chip_stack} chips`);
            }

            // Prepare players for engine
            const enginePlayers = playersResult.map(player => ({
                player_id: player.player_id,
                username: player.username,
                chips: player.chip_stack,
                seat_number: player.seat_number
            }));

            // Create poker engine
            console.log('🎰 Initializing poker engine:'); 
            console.log(`   ├─ Small Blind: ${table.small_blind}`);
            console.log(`   └─ Big Blind: ${table.big_blind}`);
            
            const engine = await createPokerEngine(gameId, enginePlayers, {
                smallBlind: table.small_blind,
                bigBlind: table.big_blind
            }, req.io);

            // Store engine in activeGames
            req.activeGames.set(gameId, engine);
            console.log('💾 Engine stored in active games');
            console.log(`🔍 Stored with gameId: ${gameId} (type: ${typeof gameId})`);
            console.log(`🔍 Active games now contains: [${Array.from(req.activeGames.keys()).join(', ')}]`);

            await db.query('COMMIT');
            console.log('✅ Transaction committed successfully');

            // Automatically start the first hand
            console.log('🚀 Auto-starting first hand...');
            try {
                const gameState = engine.startHand();
                
                console.log('🃏 Hand auto-started by engine:');
                console.log(`├─ Stage: ${gameState.stage}`);
                console.log(`├─ Hand Number: ${gameState.hand_number || 'undefined - checking engine...'}`);
                console.log(`├─ Total Players: ${gameState.players.length}`);
                console.log(`└─ Pot: ${gameState.pot_structure ? gameState.pot_structure.totalPot : 'undefined pot structure'}`);
                
                // Debug the engine state
                console.log(`🔍 Engine internal state:`);
                console.log(`   ├─ Engine handNumber: ${engine.handNumber}`);
                console.log(`   ├─ Engine stage: ${engine.stage}`);
                console.log(`   └─ Engine gameId: ${engine.gameId}`);
                
                // Update database with initial hand state
                await db.execute(
                    'UPDATE games SET stage = ?, started_at = CURRENT_TIMESTAMP WHERE game_id = ?',
                    [gameState.stage, gameId]
                );
                
                // Persist the game state
                await persistGameState(gameId, engine);
                
                // Broadcast to all players
                req.io.to(`game_${gameId}`).emit('handStarted', gameState);
                
                console.log('🎉 Game creation and first hand started successfully');
                console.log(`📞 Game is now active and ready for player actions`);
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                
                res.json({
                    message: 'Game created and first hand started successfully',
                    game_id: gameId,
                    gameState: gameState,
                    hand_started: true
                });
                
            } catch (handStartError) {
                console.error('❌ Failed to auto-start hand:', handStartError.message);
                console.log('💾 Game created but hand start failed - use POST /api/games/${gameId}/start');
                
                res.json({
                    message: 'Game created successfully, but hand failed to start automatically',
                    game_id: gameId,
                    gameState: engine.getGameState(),
                    ready_to_start: true,
                    next_step: `POST /api/games/${gameId}/start`,
                    error: handStartError.message
                });
            }

        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }

    } catch (error) {
        console.error('❌ GAME CREATION FAILED:', error.message);
        console.error('Stack trace:', error.stack);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        res.status(500).json({ message: 'Failed to start game' });
    }
});

// POST /games/:gameId/start - Start the hand using poker engine
router.post('/:gameId/start', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        
        console.log('🏁 HAND START INITIATED');
        console.log(`├─ Game ID: ${gameId}`);
        console.log(`└─ Requested by User: ${req.user.playerId}`);
        
        const engine = resolveEngine(req.activeGames, gameId);
        if (!engine) {
            console.log('❌ Hand start failed: Game not found in active games');
            return res.status(404).json({ message: 'Game not found' });
        }
        
        console.log('✅ Engine found, starting hand...');

        try {
            const gameState = engine.startHand();
            
            console.log('🃏 Hand started by engine:');
            console.log(`├─ Stage: ${gameState.stage}`);
            console.log(`├─ Hand Number: ${gameState.hand_number}`);
            console.log(`├─ Total Players: ${gameState.players.length}`);
            console.log(`└─ Pot: ${gameState.pot_structure.totalPot}`);
            
            // Update database with initial hand state
            await db.execute(
                'UPDATE games SET stage = ?, started_at = CURRENT_TIMESTAMP WHERE game_id = ?',
                [gameState.stage, gameId]
            );
            console.log('💾 Database updated with initial hand state');

            // Persist the game state
            await persistGameState(gameId, engine);
            console.log('💾 Game state persisted to database');

            // Broadcast to all players
            req.io.to(`game_${gameId}`).emit('handStarted', gameState);
            console.log('📡 Hand start broadcasted to all players');

            console.log('🎉 Hand started successfully');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            
            res.json({
                success: true,
                message: 'Hand started successfully',
                gameState: gameState
            });

        } catch (engineError) {
            console.error('❌ Engine error during hand start:', engineError.message);
            console.error('Engine error stack:', engineError.stack);
            res.status(400).json({ 
                success: false, 
                message: engineError.message 
            });
        }

    } catch (error) {
        console.error('❌ HAND START FAILED:', error.message);
        console.error('Stack trace:', error.stack);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        res.status(500).json({ message: 'Failed to start hand' });
    }
});

// POST /games/:gameId/action - Process player action using poker engine
router.post('/:gameId/action', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const { action_type, amount } = req.body;
        const playerId = req.user.playerId;

        console.log('🎯 PLAYER ACTION RECEIVED');
        console.log(`├─ Game ID: ${gameId}`);
        console.log(`├─ Player ID: ${playerId}`);
        console.log(`├─ Action: ${action_type}`);
        console.log(`└─ Amount: ${amount || 0}`);

        if (!action_type) {
            console.log('❌ Action rejected: Missing action_type');
            return res.status(400).json({ message: 'action_type is required' });
        }

        const engine = resolveEngine(req.activeGames, gameId);
        if (!engine) {
            console.log('❌ Action failed: Game not found in active games');
            return res.status(404).json({ message: 'Game not found or not active' });
        }

        const currentState = engine.getGameState();
        console.log(`🎮 Current game state - Stage: ${currentState.stage}, Pot: ${currentState.pot_structure.totalPot}`);

        try {
            console.log('⚙️ Processing action through poker engine...');
            const result = engine.handleAction(playerId, action_type, amount || 0);
            
            console.log(`✅ Engine processed action: ${result.success ? 'SUCCESS' : 'FAILED'}`);
            
            if (result.success) {
                console.log('💾 Recording action in database...');
                // Record action in database for history
                await db.execute(`
                    INSERT INTO actions (game_id, player_id, action_type, amount, stage)
                    VALUES (?, ?, ?, ?, ?)
                `, [gameId, playerId, action_type, amount || 0, result.game_state.stage]);
                
                console.log('💾 Persisting updated game state...');
                // Persist game state
                await persistGameState(gameId, engine);
                
                console.log('📡 Broadcasting game update to all players');
                // Broadcast update to all players
                req.io.to(`game_${gameId}`).emit('gameUpdate', result.game_state);
                
                console.log(`🎯 New game state - Stage: ${result.game_state.stage}, Pot: ${result.game_state.pot_structure.totalPot}`);
                
                res.json({
                    success: true,
                    message: 'Action processed successfully',
                    action: result.result.action,
                    gameState: result.game_state
                });

                // Check if hand is complete
                if (result.game_state.stage === 'waiting' || result.game_state.stage === 'game_over') {
                    console.log('🏁 HAND COMPLETED');
                    console.log(`├─ Game ID: ${gameId}`);
                    console.log(`├─ Final Stage: ${result.game_state.stage}`);
                    console.log(`└─ Hand Number: ${result.game_state.hand_number}`);
                    
                    // Log final pot and winners if available
                    if (result.game_state.winners && result.game_state.winners.length > 0) {
                        console.log('🏆 WINNERS:');
                        result.game_state.winners.forEach(winner => {
                            console.log(`   ├─ ${winner.username}: ${winner.winAmount} chips`);
                        });
                    }
                }

                // Clean up completed games
                if (result.game_state.stage === 'waiting' || result.game_state.stage === 'game_over') {
                    // Game completed - remove from active games after a delay
                    setTimeout(() => {
                        req.activeGames.delete(gameId);
                        console.log(`Removed completed game ${gameId} from memory`);
                    }, 30000); // Keep for 30 seconds for any final requests
                }
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

// GET /games/:gameId/actions - Get available actions for current player
router.get('/:gameId/actions', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const playerId = req.user.playerId;
        
        const engine = resolveEngine(req.activeGames, gameId);
        if (!engine) {
            return res.status(404).json({ message: 'Game not found or not active' });
        }

        const gameState = engine.getGameState();
        
        // Check if it's the player's turn
        let isPlayerTurn = false;
        let availableActions = [];
        
        if (gameState.betting_round && engine.bettingRound) {
            const currentPlayer = engine.bettingRound.getCurrentPlayer();
            isPlayerTurn = currentPlayer && currentPlayer.player_id === playerId;
            
            if (isPlayerTurn) {
                availableActions = engine.bettingRound.getAvailableActions();
            }
        }

        res.json({
            success: true,
            playerId: playerId,
            isPlayerTurn: isPlayerTurn,
            availableActions: availableActions,
            currentStage: gameState.stage,
            currentPlayer: gameState.betting_round ? gameState.betting_round.current_player : null
        });

    } catch (error) {
        console.error('Error getting available actions:', error);
        res.status(500).json({ message: 'Failed to get available actions' });
    }
});

// PUT /games/:gameId/end - End a game
router.put('/:gameId/end', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;

        // Start transaction
        await db.query('START TRANSACTION');

        try {
            // End the game in database
            await db.execute(
                'UPDATE games SET ended_at = CURRENT_TIMESTAMP WHERE game_id = ? AND ended_at IS NULL',
                [gameId]
            );

            // Get final game state if engine exists
            const engine = resolveEngine(req.activeGames, gameId);
            if (engine) {
                await persistGameState(gameId, engine);
                req.activeGames.delete(gameId);
            }

            await db.query('COMMIT');

            // Notify all players
            req.io.to(`game_${gameId}`).emit('gameEnded', {
                message: 'Game ended',
                gameId: gameId
            });

            res.json({ 
                message: 'Game ended successfully',
                game_id: gameId
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

        const engine = resolveEngine(req.activeGames, gameId);
        if (engine) {
            // Use engine for live evaluation
            const gameState = engine.getGameState();
            
            if (gameState.community_cards.length < 5) {
                return res.status(400).json({ message: 'Cannot evaluate hands without all 5 community cards' });
            }

            const activePlayers = gameState.players.filter(p => !p.folded);
            const winners = gameLogic.determineWinners(activePlayers, gameState.community_cards);

            res.json({
                game_id: gameId,
                stage: gameState.stage,
                community_cards: gameState.community_cards,
                winners: winners
            });
        } else {
            // Fallback to database for completed games
            const [gameResult] = await db.execute(`
                SELECT * FROM games WHERE game_id = ? AND ended_at IS NULL
            `, [gameId]);

            if (gameResult.length === 0) {
                return res.status(404).json({ message: 'Game not found' });
            }

            const game = gameResult[0];

            if (!game.community_cards) {
                return res.status(400).json({ message: 'No community cards dealt' });
            }

            const communityCards = JSON.parse(game.community_cards);

            if (communityCards.length < 3) {
                return res.status(400).json({ message: 'Not enough community cards dealt' });
            }

            // Get all active players from database
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
                try {
                    let holeCards = [];
                    if (player.hole_cards) {
                        holeCards = JSON.parse(player.hole_cards);
                    }

                    if (holeCards.length === 2) {
                        const evaluation = gameLogic.evaluateHand(holeCards, communityCards);
                        
                        handEvaluations.push({
                            player_id: player.player_id,
                            username: player.username,
                            seat_number: player.seat_number,
                            hole_cards: holeCards,
                            hand_rank: evaluation.hand.rank,
                            hand_name: evaluation.hand.name,
                            hand_description: evaluation.description
                        });
                    }
                } catch (e) {
                    console.warn('Failed to evaluate hand for player', player.player_id, e);
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
        }

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
        console.error('Error fetching actions:', error);
        res.status(500).json({ message: 'Failed to fetch actions' });
    }
});

// GET /games/:gameId/formatted - Get formatted game state
router.get('/:gameId/formatted', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        
        // Try engine first
        const engine = resolveEngine(req.activeGames, gameId);
        if (engine) {
            const gameState = engine.getGameState();
            const formattedState = gameUtils.formatGameState(gameState);
            res.json(formattedState);
            return;
        }

        // Fallback to database
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

        // Get players
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

        const gameData = {
            ...game,
            players: playersResult
        };

        const formattedState = gameUtils.formatGameState(gameData);
        res.json(formattedState);

    } catch (error) {
        console.error('Error fetching formatted game state:', error);
        res.status(500).json({ message: 'Failed to fetch formatted game state' });
    }
});

module.exports = router;