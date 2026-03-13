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
        const {player_id} = req.query;
        if(!player_id) {
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

module.exports = router;