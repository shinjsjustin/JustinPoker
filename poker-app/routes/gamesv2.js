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

// Create new gamestate
router.post('/', authenticateToken, async (req, res) => {
    try{
        const {table_id, max_players, dealer_seat, hot_seat, small_blind, big_blind, aggrounds, pot, stage, current_bet, bets, community_cards} = req.body;

        const [result] = await db.execute(
            `INSERT INTO games (table_id, max_players, dealer_seat, hot_seat, small_blind, big_blind, aggrounds, pot, stage, current_bet, bets, community_cards) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [table_id, max_players, dealer_seat, hot_seat, small_blind, big_blind, aggrounds, pot, stage, current_bet, JSON.stringify(bets), JSON.stringify(community_cards)]
        );

        res.status(201).json({ game_id: result.insertId });
    }catch (err) {
        console.error('Error creating game:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Fetch gamestate
router.get('/:gameId', authenticateToken, async (req, res) => {
    const gameId = req.params.gameId;
    try {
        const [rows] = await db.execute('SELECT * FROM games WHERE game_id = ?', [gameId]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }
        const game = rows[0];
        game.bets = JSON.parse(game.bets);
        game.community_cards = JSON.parse(game.community_cards);
        res.json(game);
    } catch (err) {
        console.error('Error fetching game:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Update gamestate
router.put('/:gameId', authenticateToken, async (req, res) => {
    try{
        const { game_id, dealer_seat, hot_seat, aggrounds, pot, stage, current_bet, bets, community_cards } = req.body;
        
        if (game_id === undefined) {
            return res.status(400).json({ message: 'game_id is required' });
        }
        
        const params = [];
        const values = [];

        if (dealer_seat !== undefined) {
            params.push('dealer_seat = ?');
            values.push(dealer_seat);
        }
        if (hot_seat !== undefined) {
            params.push('hot_seat = ?');
            values.push(hot_seat);
        }
        if (aggrounds !== undefined) {
            params.push('aggrounds = ?');
            values.push(aggrounds);
        }
        if (pot !== undefined) {
            params.push('pot = ?');
            values.push(pot);
        }
        if (stage !== undefined) {
            params.push('stage = ?');
            values.push(stage);
        }
        if (current_bet !== undefined) {
            params.push('current_bet = ?');
            values.push(current_bet);
        }
        if (bets !== undefined) {
            params.push('bets = ?');
            values.push(JSON.stringify(bets));
        }
        if (community_cards !== undefined) {
            params.push('community_cards = ?');
            values.push(JSON.stringify(community_cards));
        }
        if (params.length === 0) {
            return res.status(400).json({ message: 'No fields to update' });
        }

        const [result] = await db.execute(
            `UPDATE games SET ${params.join(', ')} WHERE game_id = ?`,
            [...values, game_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

    }catch (err) {
        console.error('Error updating game:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.delete('/:gameId', authenticateToken, async (req, res) => {
    const gameId = req.params.gameId;
    try {
        const [result] = await db.execute('DELETE FROM games WHERE game_id = ?', [gameId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }
        res.json({ message: 'Game deleted successfully' });
    } catch (err) {
        console.error('Error deleting game:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = { router, authenticateToken };