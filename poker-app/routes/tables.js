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
// TABLE MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────

// GET /tables - Get all tables with player counts
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT t.*, 
                   COUNT(tp.player_id) as current_players
            FROM tables t
            LEFT JOIN table_players tp ON t.table_id = tp.table_id 
                AND tp.status IN ('active', 'sitting_out')
            GROUP BY t.table_id
            ORDER BY t.created_at DESC
        `;
        
        const [tables] = await db.execute(query);
        res.json(tables);
    } catch (error) {
        console.error('Error fetching tables:', error);
        res.status(500).json({ message: 'Failed to fetch tables' });
    }
});

// GET /tables/current - Get player's current table
router.get('/current', authenticateToken, async (req, res) => {
    try {
        const playerId = req.user.playerId;
        
        const [result] = await db.execute(`
            SELECT t.table_id, t.name, tp.seat_number, tp.chip_stack, tp.status
            FROM table_players tp
            JOIN tables t ON tp.table_id = t.table_id
            WHERE tp.player_id = ? AND tp.status IN ('active', 'sitting_out')
            LIMIT 1
        `, [playerId]);
        
        if (result.length === 0) {
            return res.status(404).json({ message: 'Player not seated at any table' });
        }
        
        res.json(result[0]);
    } catch (error) {
        console.error('Error fetching current table:', error);
        res.status(500).json({ message: 'Failed to fetch current table' });
    }
});

// GET /tables/:tableId - Get specific table with players
router.get('/:tableId', async (req, res) => {
    try {
        const { tableId } = req.params;
        
        // Get table info
        const [tableResult] = await db.execute(
            'SELECT * FROM tables WHERE table_id = ?', 
            [tableId]
        );
        
        if (tableResult.length === 0) {
            return res.status(404).json({ message: 'Table not found' });
        }
        
        // Get players at table
        const [playersResult] = await db.execute(`
            SELECT tp.*, p.username, p.chip_balance
            FROM table_players tp
            JOIN players p ON tp.player_id = p.player_id
            WHERE tp.table_id = ? AND tp.status != 'left'
            ORDER BY tp.seat_number
        `, [tableId]);
        
        const table = {
            ...tableResult[0],
            players: playersResult,
            current_players: playersResult.length
        };
        
        res.json(table);
    } catch (error) {
        console.error('Error fetching table:', error);
        res.status(500).json({ message: 'Failed to fetch table' });
    }
});

// POST /tables - Create new table
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { name, max_players = 9, small_blind = 10, big_blind = 20 } = req.body;
        
        // Validate input
        if (!name || name.trim().length === 0) {
            return res.status(400).json({ message: 'Table name is required' });
        }
        
        if (max_players < 2 || max_players > 10) {
            return res.status(400).json({ message: 'Max players must be between 2 and 10' });
        }
        
        if (small_blind <= 0 || big_blind <= small_blind) {
            return res.status(400).json({ message: 'Invalid blind structure' });
        }
        
        // Check if table name already exists
        const [existingTable] = await db.execute(
            'SELECT table_id FROM tables WHERE name = ?', 
            [name.trim()]
        );
        
        if (existingTable.length > 0) {
            return res.status(409).json({ message: 'Table name already exists' });
        }
        
        const [result] = await db.execute(`
            INSERT INTO tables (name, max_players, small_blind, big_blind, status)
            VALUES (?, ?, ?, ?, 'waiting')
        `, [name.trim(), max_players, small_blind, big_blind]);
        
        res.status(201).json({
            message: 'Table created successfully',
            table_id: result.insertId
        });
    } catch (error) {
        console.error('Error creating table:', error);
        res.status(500).json({ message: 'Failed to create table' });
    }
});

// PUT /tables/:tableId - Update table settings
router.put('/:tableId', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const { name, max_players, small_blind, big_blind, status } = req.body;
        
        // Check if table exists
        const [tableResult] = await db.execute(
            'SELECT * FROM tables WHERE table_id = ?', 
            [tableId]
        );
        
        if (tableResult.length === 0) {
            return res.status(404).json({ message: 'Table not found' });
        }
        
        let updateFields = [];
        let values = [];
        
        if (name) {
            updateFields.push('name = ?');
            values.push(name.trim());
        }
        if (max_players) {
            if (max_players < 2 || max_players > 10) {
                return res.status(400).json({ message: 'Max players must be between 2 and 10' });
            }
            updateFields.push('max_players = ?');
            values.push(max_players);
        }
        if (small_blind) {
            updateFields.push('small_blind = ?');
            values.push(small_blind);
        }
        if (big_blind) {
            updateFields.push('big_blind = ?');
            values.push(big_blind);
        }
        if (status) {
            if (!['waiting', 'active', 'closed'].includes(status)) {
                return res.status(400).json({ message: 'Invalid status' });
            }
            updateFields.push('status = ?');
            values.push(status);
        }
        
        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields to update' });
        }
        
        values.push(tableId);
        
        await db.execute(`
            UPDATE tables SET ${updateFields.join(', ')} 
            WHERE table_id = ?
        `, values);
        
        res.json({ message: 'Table updated successfully' });
    } catch (error) {
        console.error('Error updating table:', error);
        res.status(500).json({ message: 'Failed to update table' });
    }
});

// ─────────────────────────────────────────
// TABLE SEATING ENDPOINTS
// ─────────────────────────────────────────

// POST /tables/:tableId/join - Join a table (automatic seat assignment)
router.post('/:tableId/join', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const { chip_stack = 1000 } = req.body;
        const playerId = req.user.playerId;
        
        // Start transaction
        await db.query('START TRANSACTION');
        
        try {
            // Check if table exists and get info
            const [tableResult] = await db.execute(
                'SELECT * FROM tables WHERE table_id = ? AND status != "closed"', 
                [tableId]
            );
            
            if (tableResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Table not found or closed' });
            }
            
            const table = tableResult[0];
            
            // Check if player is already at this table
            const [existingPlayer] = await db.execute(
                'SELECT * FROM table_players WHERE table_id = ? AND player_id = ? AND status != "left"', 
                [tableId, playerId]
            );
            
            if (existingPlayer.length > 0) {
                await db.query('ROLLBACK');
                return res.status(409).json({ message: 'Already seated at this table' });
            }
            
            // Get current player count
            const [playerCount] = await db.execute(`
                SELECT COUNT(*) as count 
                FROM table_players 
                WHERE table_id = ? AND status IN ('active', 'sitting_out')
            `, [tableId]);
            
            if (playerCount[0].count >= table.max_players) {
                await db.query('ROLLBACK');
                return res.status(409).json({ message: 'Table is full' });
            }
            
            // Find next available seat
            const [occupiedSeats] = await db.execute(`
                SELECT seat_number 
                FROM table_players 
                WHERE table_id = ? AND status != 'left'
                ORDER BY seat_number
            `, [tableId]);
            
            let nextSeat = 1;
            const occupied = occupiedSeats.map(row => row.seat_number);
            
            while (occupied.includes(nextSeat) && nextSeat <= table.max_players) {
                nextSeat++;
            }
            
            if (nextSeat > table.max_players) {
                await db.query('ROLLBACK');
                return res.status(409).json({ message: 'No available seats' });
            }
            
            // Check player has enough chips
            const [playerResult] = await db.execute(
                'SELECT chip_balance FROM players WHERE player_id = ?', 
                [playerId]
            );
            
            if (playerResult[0].chip_balance < chip_stack) {
                await db.query('ROLLBACK');
                return res.status(400).json({ message: 'Insufficient chip balance' });
            }
            
            // Add player to table
            await db.execute(`
                INSERT INTO table_players (table_id, player_id, seat_number, chip_stack, status)
                VALUES (?, ?, ?, ?, 'active')
            `, [tableId, playerId, nextSeat, chip_stack]);
            
            // Update player's chip balance
            await db.execute(
                'UPDATE players SET chip_balance = chip_balance - ? WHERE player_id = ?', 
                [chip_stack, playerId]
            );
            
            // Update table status if this is the first player
            if (playerCount[0].count === 0) {
                await db.execute(
                    'UPDATE tables SET status = "waiting" WHERE table_id = ?', 
                    [tableId]
                );
            }
            
            await db.query('COMMIT');
            
            res.json({
                message: 'Successfully joined table',
                seat_number: nextSeat,
                chip_stack: chip_stack
            });
            
        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }
        
    } catch (error) {
        console.error('Error joining table:', error);
        res.status(500).json({ message: 'Failed to join table' });
    }
});

// DELETE /tables/:tableId/leave - Leave a table
router.delete('/:tableId/leave', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const playerId = req.user.playerId;
        
        await leaveTableHelper(tableId, playerId);
        res.json({ 
            message: 'Successfully left table'
        });
        
    } catch (error) {
        console.error('Error leaving table:', error);
        res.status(500).json({ message: 'Failed to leave table' });
    }
});

// POST /tables/:tableId/leave - Alternative endpoint for beacon requests
router.post('/:tableId/leave', async (req, res) => {
    try {
        const { tableId } = req.params;
        
        // Handle both regular requests and beacon requests
        let token;
        if (req.body && req.body.auth) {
            // Beacon request with FormData
            token = req.body.auth.replace('Bearer ', '');
        } else if (req.headers.authorization) {
            // Regular request with Authorization header
            token = req.headers.authorization.split(' ')[1];
        }
        
        if (!token) {
            return res.status(401).json({ message: 'Access token required' });
        }
        
        // Verify token manually for this endpoint
        let user;
        try {
            user = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(403).json({ message: 'Invalid or expired token' });
        }
        
        await leaveTableHelper(tableId, user.playerId);
        res.json({ 
            message: 'Successfully left table'
        });
        
    } catch (error) {
        console.error('Error leaving table:', error);
        res.status(500).json({ message: 'Failed to leave table' });
    }
});

// Helper function to leave a table
async function leaveTableHelper(tableId, playerId) {
    // Start transaction
    await db.query('START TRANSACTION');
    
    try {
        // Check if player is at this table
        const [playerResult] = await db.execute(
            'SELECT * FROM table_players WHERE table_id = ? AND player_id = ? AND status != "left"', 
            [tableId, playerId]
        );
        
        if (playerResult.length === 0) {
            await db.query('ROLLBACK');
            throw new Error('Not seated at this table');
        }
        
        const player = playerResult[0];
        
        // Check if player is in an active game
        const [activeGame] = await db.execute(`
            SELECT g.game_id 
            FROM games g 
            JOIN game_players gp ON g.game_id = gp.game_id 
            WHERE g.table_id = ? AND gp.player_id = ? AND g.ended_at IS NULL
        `, [tableId, playerId]);
        
        if (activeGame.length > 0) {
            await db.query('ROLLBACK');
            throw new Error('Cannot leave table during active game');
        }
        
        // Update player status to 'left'
        await db.execute(
            'UPDATE table_players SET status = "left" WHERE table_player_id = ?', 
            [player.table_player_id]
        );
        
        // Return chips to player
        await db.execute(
            'UPDATE players SET chip_balance = chip_balance + ? WHERE player_id = ?', 
            [player.chip_stack, playerId]
        );
        
        // Check if table is now empty and update status
        const [remainingPlayers] = await db.execute(`
            SELECT COUNT(*) as count 
            FROM table_players 
            WHERE table_id = ? AND status IN ('active', 'sitting_out')
        `, [tableId]);
        
        if (remainingPlayers[0].count === 0) {
            await db.execute(
                'UPDATE tables SET status = "waiting" WHERE table_id = ?', 
                [tableId]
            );
        }
        
        await db.query('COMMIT');
        
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }
}

// GET /tables/:tableId/players - Get all players at table
router.get('/:tableId/players', async (req, res) => {
    try {
        const { tableId } = req.params;
        
        const [players] = await db.execute(`
            SELECT 
                tp.seat_number,
                tp.chip_stack,
                tp.status,
                tp.joined_at,
                p.username,
                p.player_id
            FROM table_players tp
            JOIN players p ON tp.player_id = p.player_id
            WHERE tp.table_id = ? AND tp.status != 'left'
            ORDER BY tp.seat_number
        `, [tableId]);
        
        res.json(players);
    } catch (error) {
        console.error('Error fetching table players:', error);
        res.status(500).json({ message: 'Failed to fetch table players' });
    }
});

// POST /tables/:tableId/sit-out - Sit out from table
router.post('/:tableId/sit-out', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const playerId = req.user.playerId;

        const [result] = await db.execute(
            'UPDATE table_players SET status = "sitting_out" WHERE table_id = ? AND player_id = ? AND status = "active"',
            [tableId, playerId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Player not actively seated at table' });
        }
        
        res.json({ message: 'Successfully sitting out' });
    } catch (error) {
        console.error('Error sitting out:', error);
        res.status(500).json({ message: 'Failed to sit out' });
    }
});

// POST /tables/:tableId/sit-in - Sit back in at table
router.post('/:tableId/sit-in', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const playerId = req.user.playerId;
        
        const [result] = await db.execute(
            'UPDATE table_players SET status = "active" WHERE table_id = ? AND player_id = ? AND status = "sitting_out"', 
            [tableId, playerId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Player not sitting out at table' });
        }
        
        res.json({ message: 'Successfully sitting back in' });
    } catch (error) {
        console.error('Error sitting back in:', error);
        res.status(500).json({ message: 'Failed to sit back in' });
    }
});

// PUT /tables/:tableId/chip-stack - Update chip stack (buy more chips)
router.put('/:tableId/chip-stack', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const { additional_chips } = req.body;
        const playerId = req.user.playerId;
        
        if (!additional_chips || additional_chips <= 0) {
            return res.status(400).json({ message: 'Invalid chip amount' });
        }
        
        // Start transaction
        await db.query('START TRANSACTION');
        
        try {
            // Check if player is at table
            const [playerResult] = await db.execute(
                'SELECT * FROM table_players WHERE table_id = ? AND player_id = ? AND status != "left"', 
                [tableId, playerId]
            );
            
            if (playerResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Not seated at this table' });
            }
            
            // Check player balance
            const [balanceResult] = await db.execute(
                'SELECT chip_balance FROM players WHERE player_id = ?', 
                [playerId]
            );
            
            if (balanceResult[0].chip_balance < additional_chips) {
                await db.query('ROLLBACK');
                return res.status(400).json({ message: 'Insufficient chip balance' });
            }
            
            // Update chip stack and balance
            await db.execute(
                'UPDATE table_players SET chip_stack = chip_stack + ? WHERE table_id = ? AND player_id = ?', 
                [additional_chips, tableId, playerId]
            );
            
            await db.execute(
                'UPDATE players SET chip_balance = chip_balance - ? WHERE player_id = ?', 
                [additional_chips, playerId]
            );
            
            await db.query('COMMIT');
            
            res.json({
                message: 'Chip stack updated successfully',
                chips_added: additional_chips
            });
            
        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }
        
    } catch (error) {
        console.error('Error updating chip stack:', error);
        res.status(500).json({ message: 'Failed to update chip stack' });
    }
});

module.exports = router;
