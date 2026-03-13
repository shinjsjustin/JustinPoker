const db = require('../db/db');
const jwt = require('jsonwebtoken');
const express = require('express');
const router = express.Router();

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

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
// GAME MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────

// GET /games - Fetch a game by game_id or table_id
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { game_id, table_id } = req.query;

        if (!game_id && !table_id) {
            return res.status(400).json({ message: 'game_id or table_id is required' });
        }

        let query;
        let values;

        if (game_id) {
            query = `
                SELECT game_id, table_id, pot, community_cards, stage, dealer_seat, active_seat
                FROM games
                WHERE game_id = ?
            `;
            values = [game_id];
        } else {
            // Get the most recent active game for the table
            query = `
                SELECT game_id, table_id, pot, community_cards, stage, dealer_seat, active_seat
                FROM games
                WHERE table_id = ? AND stage != 'game_over'
                ORDER BY started_at DESC
                LIMIT 1
            `;
            values = [table_id];
        }

        const [result] = await db.execute(query, values);

        if (result.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        res.json(result[0]);
    } catch (error) {
        console.error('Error fetching game:', error);
        res.status(500).json({ message: 'Failed to fetch game' });
    }
});

// POST /games - Create a new game with default values
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { table_id, dealer_seat } = req.body;

        if (!table_id) {
            return res.status(400).json({ message: 'table_id is required' });
        }

        const query = `
            INSERT INTO games (table_id, pot, stage, dealer_seat)
            VALUES (?, 0, 'waiting', ?)
        `;

        const [result] = await db.execute(query, [table_id, dealer_seat || 0]);

        res.status(201).json({
            message: 'Game created successfully',
            game_id: result.insertId
        });
    } catch (error) {
        console.error('Error creating game:', error);
        res.status(500).json({ message: 'Failed to create game' });
    }
});

// PUT /games - Update game by game_id or table_id
// Can update: pot, community_cards, stage, active_seat, dealer_seat
router.put('/', authenticateToken, async (req, res) => {
    try {
        const { game_id, table_id, pot, community_cards, stage, active_seat, dealer_seat } = req.body;

        if (!game_id && !table_id) {
            return res.status(400).json({ message: 'game_id or table_id is required' });
        }

        // Build dynamic update query based on provided fields
        const updates = [];
        const values = [];

        if (pot !== undefined) {
            updates.push('pot = ?');
            values.push(pot);
        }
        if (community_cards !== undefined) {
            updates.push('community_cards = ?');
            values.push(JSON.stringify(community_cards));
        }
        if (stage !== undefined) {
            updates.push('stage = ?');
            values.push(stage);
        }
        if (active_seat !== undefined) {
            updates.push('active_seat = ?');
            values.push(active_seat);
        }
        if (dealer_seat !== undefined) {
            updates.push('dealer_seat = ?');
            values.push(dealer_seat);
        }

        if (updates.length === 0) {
            return res.status(400).json({ message: 'No fields to update' });
        }

        let query;
        if (game_id) {
            query = `UPDATE games SET ${updates.join(', ')} WHERE game_id = ?`;
            values.push(game_id);
        } else {
            // Update the most recent active game for the table
            query = `UPDATE games SET ${updates.join(', ')} WHERE table_id = ? AND stage != 'game_over' ORDER BY started_at DESC LIMIT 1`;
            values.push(table_id);
        }

        const [result] = await db.execute(query, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        res.json({ message: 'Game updated successfully' });
    } catch (error) {
        console.error('Error updating game:', error);
        res.status(500).json({ message: 'Failed to update game' });
    }
});

// DELETE /games - Delete a game by game_id or table_id
router.delete('/', authenticateToken, async (req, res) => {
    try {
        const { game_id, table_id } = req.body;

        if (!game_id && !table_id) {
            return res.status(400).json({ message: 'game_id or table_id is required' });
        }

        let query;
        let values;

        if (game_id) {
            // First clear game info from players in this game
            await db.execute(
                'UPDATE players SET game_id = NULL, hole_cards = NULL, is_folded = NULL, is_all_in = NULL, current_bet = NULL WHERE game_id = ?', 
                [game_id]
            );
            // Then delete the game
            query = 'DELETE FROM games WHERE game_id = ?';
            values = [game_id];
        } else {
            // Get all game_ids for this table to clear player game info
            const [games] = await db.execute('SELECT game_id FROM games WHERE table_id = ?', [table_id]);
            for (const game of games) {
                await db.execute(
                    'UPDATE players SET game_id = NULL, hole_cards = NULL, is_folded = NULL, is_all_in = NULL, current_bet = NULL WHERE game_id = ?', 
                    [game.game_id]
                );
            }
            // Then delete all games for this table
            query = 'DELETE FROM games WHERE table_id = ?';
            values = [table_id];
        }

        const [result] = await db.execute(query, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        res.json({ 
            message: 'Game(s) deleted successfully',
            deleted_count: result.affectedRows
        });
    } catch (error) {
        console.error('Error deleting game:', error);
        res.status(500).json({ message: 'Failed to delete game' });
    }
});

// ─────────────────────────────────────────
// GAME PLAYERS ENDPOINTS
// ─────────────────────────────────────────

// GET /games/players - Fetch game player(s) by game_id and/or player_id
router.get('/players', authenticateToken, async (req, res) => {
    try {
        const { game_id, player_id } = req.query;

        if (!game_id && !player_id) {
            return res.status(400).json({ message: 'game_id or player_id is required' });
        }

        // Build dynamic WHERE clause based on provided filters
        const conditions = [];
        const values = [];

        if (game_id) {
            conditions.push('game_id = ?');
            values.push(game_id);
        }
        if (player_id) {
            conditions.push('player_id = ?');
            values.push(player_id);
        }

        const query = `
            SELECT player_id, game_id, hole_cards, is_folded, is_all_in, current_bet, chip_balance
            FROM players
            WHERE ${conditions.join(' AND ')} AND game_id IS NOT NULL
        `;

        const [result] = await db.execute(query, values);

        if (result.length === 0) {
            return res.status(404).json({ message: 'Game player(s) not found' });
        }

        // Return single object if only one result, otherwise array
        res.json(result.length === 1 ? result[0] : result);
    } catch (error) {
        console.error('Error fetching game player:', error);
        res.status(500).json({ message: 'Failed to fetch game player' });
    }
});

// POST /games/players - Add a player to a game
router.post('/players', authenticateToken, async (req, res) => {
    try {
        const { game_id, player_id, hole_cards } = req.body;

        if (!game_id || !player_id) {
            return res.status(400).json({ message: 'game_id and player_id are required' });
        }

        // Check if player is already in a game
        const [existingPlayer] = await db.execute(
            'SELECT game_id FROM players WHERE player_id = ?',
            [player_id]
        );

        if (existingPlayer.length > 0 && existingPlayer[0].game_id !== null) {
            return res.status(409).json({ message: 'Player is already in a game' });
        }

        const query = `
            UPDATE players 
            SET game_id = ?, hole_cards = ?, is_folded = FALSE, is_all_in = FALSE, current_bet = 0
            WHERE player_id = ?
        `;

        const [result] = await db.execute(query, [
            game_id,
            hole_cards ? JSON.stringify(hole_cards) : null,
            player_id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Player not found' });
        }

        res.status(201).json({
            message: 'Player added to game successfully'
        });
    } catch (error) {
        console.error('Error adding player to game:', error);
        res.status(500).json({ message: 'Failed to add player to game' });
    }
});

// PUT /games/players - Update a game player's state
// Can update: is_folded, is_all_in, current_bet, hole_cards
router.put('/players', authenticateToken, async (req, res) => {
    try {
        const { game_id, player_id, is_folded, is_all_in, current_bet, hole_cards } = req.body;

        if (!game_id || !player_id) {
            return res.status(400).json({ message: 'game_id and player_id are required' });
        }

        // Build dynamic update query based on provided fields
        const updates = [];
        const values = [];

        if (is_folded !== undefined) {
            updates.push('is_folded = ?');
            values.push(is_folded);
        }
        if (is_all_in !== undefined) {
            updates.push('is_all_in = ?');
            values.push(is_all_in);
        }
        if (current_bet !== undefined) {
            updates.push('current_bet = ?');
            values.push(current_bet);
        }
        if (hole_cards !== undefined) {
            updates.push('hole_cards = ?');
            values.push(JSON.stringify(hole_cards));
        }

        if (updates.length === 0) {
            return res.status(400).json({ message: 'No fields to update' });
        }

        const query = `UPDATE players SET ${updates.join(', ')} WHERE game_id = ? AND player_id = ?`;
        values.push(game_id, player_id);

        const [result] = await db.execute(query, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Game player not found' });
        }

        res.json({ message: 'Game player updated successfully' });
    } catch (error) {
        console.error('Error updating game player:', error);
        res.status(500).json({ message: 'Failed to update game player' });
    }
});

module.exports = router;
