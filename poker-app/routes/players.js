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

router.get('/', authenticateToken, async (req, res) => {
    try {
        const { player_id } = req.query;
        if (!player_id) {
            return res.status(400).json({ message: 'player_id query parameter is required' });
        }

        const query = `
            SELECT chip_balance, table_id, seat_number, status, game_id, hole_cards, is_folded, is_all_in, current_bet
            FROM players
            WHERE player_id = ?
        `;


        const [players] = await db.execute(query, [player_id]);
        if (players.length === 0) {
            return res.status(404).json({ message: 'Player not found' });
        }

        res.json(players[0]);
    } catch (error) {
        console.error('Error fetching player info:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Update player info
router.put('/:playerId', authenticateToken, async (req, res) => {
    try {
        const playerId = req.params.playerId;
        const { chip_balance, table_id, seat_number, status, game_id, hole_cards, is_folded, is_all_in, current_bet } = req.body;

        if (playerId === undefined) {
            return res.status(400).json({ message: 'playerId parameter is required' });
        }

        const params = [];
        const values = [];

        if (chip_balance !== undefined) {
            params.push('chip_balance = ?');
            values.push(chip_balance);
        }
        if (table_id !== undefined) {
            params.push('table_id = ?');
            values.push(table_id);
        }
        if (seat_number !== undefined) {
            params.push('seat_number = ?');
            values.push(seat_number);
        }
        if (status !== undefined) {
            params.push('status = ?');
            values.push(status);
        }
        if (game_id !== undefined) {
            params.push('game_id = ?');
            values.push(game_id);
        }
        if (hole_cards !== undefined) {
            params.push('hole_cards = ?');
            values.push(JSON.stringify(hole_cards));
        }
        if (is_folded !== undefined) {
            params.push('is_folded = ?');
            values.push(is_folded);
        }
        if (is_all_in !== undefined) {
            params.push('is_all_in = ?');
            values.push(is_all_in);
        }
        if (current_bet !== undefined) {
            params.push('current_bet = ?');
            values.push(current_bet);
        }

        const [result] = await db.execute(
            `UPDATE players SET ${params.join(', ')} WHERE player_id = ?`,
            [...values, playerId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Player not found' });
        }
    } catch (err) {
        console.error('Error updating player info:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;