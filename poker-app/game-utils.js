const gameLogic = require('./gamelogic');

// ─────────────────────────────────────────
// POKER GAME UTILITIES — Frontend helpers
// ─────────────────────────────────────────

class PokerGameUtils {
    /**
     * Format game state for frontend display
     * @param {Object} gameData - Raw game data from database
     * @returns {Object} Formatted game state
     */
    formatGameState(gameData) {
        const formatted = {
            game_id: gameData.game_id,
            table_id: gameData.table_id,
            table_name: gameData.table_name,
            stage: gameData.stage,
            pot: gameData.pot,
            dealer_seat: gameData.dealer_seat,
            active_seat: gameData.active_seat,
            small_blind: gameData.small_blind,
            big_blind: gameData.big_blind,
            started_at: gameData.started_at,
            ended_at: gameData.ended_at
        };

        // Format community cards
        formatted.community_cards = {
            raw: [],
            formatted: [],
            count: 0
        };

        if (gameData.community_cards) {
            try {
                const cards = JSON.parse(gameData.community_cards);
                formatted.community_cards.raw = cards;
                formatted.community_cards.formatted = cards.map(card => gameLogic.formatCard(card));
                formatted.community_cards.count = cards.length;
            } catch (e) {
                console.warn('Invalid community cards JSON:', gameData.community_cards);
            }
        }

        // Format players
        formatted.players = (gameData.players || []).map(player => this.formatPlayer(player));
        formatted.active_player_count = formatted.players.filter(p => !p.is_folded).length;

        return formatted;
    }

    /**
     * Format player data for frontend
     * @param {Object} playerData - Raw player data
     * @returns {Object} Formatted player data
     */
    formatPlayer(playerData) {
        const formatted = {
            player_id: playerData.player_id,
            username: playerData.username,
            seat_number: playerData.seat_number,
            chips_start: playerData.chips_start,
            chips_current: playerData.table_chip_stack || playerData.chip_stack || playerData.chips_end || playerData.chips_start,
            current_bet: playerData.current_bet || 0,
            is_folded: Boolean(playerData.is_folded),
            is_all_in: Boolean(playerData.is_all_in),
            is_active: playerData.status === 'active'
        };

        // Format hole cards
        formatted.hole_cards = {
            raw: [],
            formatted: [],
            visible: false
        };

        if (playerData.hole_cards) {
            try {
                let cards = playerData.hole_cards;
                
                // Handle both string and array formats
                if (typeof cards === 'string') {
                    // Try to parse as JSON first
                    try {
                        cards = JSON.parse(cards);
                    } catch (jsonError) {
                        // If that fails, try to handle array literal format like "[ 'As', 'Kh' ]"
                        const cleanedString = cards
                            .replace(/'/g, '"')  // Replace single quotes with double quotes
                            .replace(/\s+/g, ' ') // Normalize whitespace
                            .trim();
                        cards = JSON.parse(cleanedString);
                    }
                }

                if (Array.isArray(cards)) {
                    formatted.hole_cards.raw = cards;
                    formatted.hole_cards.formatted = cards.map(card => gameLogic.formatCard(card));
                    // Cards are visible in showdown or if it's the player's own cards
                    formatted.hole_cards.visible = playerData.cards_visible || false;
                }
            } catch (e) {
                console.warn('Invalid hole cards for player', playerData.player_id, ':', playerData.hole_cards);
            }
        }

        return formatted;
    }

    /**
     * Get available actions for a player
     * @param {Object} gameState - Current game state
     * @param {number} playerId - Player ID
     * @returns {Array} Available actions
     */
    getAvailableActions(gameState, playerId) {
        const actions = [];
        const player = gameState.players.find(p => p.player_id === playerId);

        if (!player || player.is_folded || player.is_all_in) {
            return actions;
        }

        // Check if it's the player's turn
        const isPlayerTurn = gameState.active_seat === player.seat_number;
        if (!isPlayerTurn) {
            return actions;
        }

        // Get highest current bet
        const activePlayers = gameState.players.filter(p => !p.is_folded);
        const highestBet = Math.max(...activePlayers.map(p => p.current_bet), 0);
        const amountToCall = highestBet - player.current_bet;

        // Always available
        actions.push({ type: 'fold', label: 'Fold', amount: 0 });

        // Check or Call
        if (amountToCall === 0) {
            actions.push({ type: 'check', label: 'Check', amount: 0 });
        } else if (amountToCall > 0) {
            const callAmount = Math.min(amountToCall, player.chips_current);
            actions.push({
                type: 'call',
                label: `Call ${callAmount}`,
                amount: callAmount
            });
        }

        // Raise
        const chipsAfterCall = player.chips_current - amountToCall;
        if (chipsAfterCall > 0) {
            const minRaise = highestBet + (gameState.big_blind || 20);
            actions.push({
                type: 'raise',
                label: 'Raise',
                amount: minRaise,
                min: minRaise,
                max: player.chips_current
            });
        }

        // All-in
        if (player.chips_current > 0) {
            actions.push({
                type: 'all_in',
                label: `All-in (${player.chips_current})`,
                amount: player.chips_current
            });
        }

        return actions;
    }

    /**
     * Calculate pot odds for a player
     * @param {number} potSize
     * @param {number} amountToCall
     * @returns {Object}
     */
    calculatePotOdds(potSize, amountToCall) {
        if (amountToCall <= 0) {
            return {
                ratio: 'N/A',
                percentage: 0,
                description: 'No bet to call'
            };
        }

        const totalPotAfterCall = potSize + amountToCall;
        const odds = totalPotAfterCall / amountToCall;
        const percentage = (amountToCall / totalPotAfterCall) * 100;

        return {
            ratio: `${odds.toFixed(1)}:1`,
            percentage: percentage.toFixed(1),
            description: `Getting ${odds.toFixed(1)} to 1 odds`,
            pot_size: potSize,
            call_amount: amountToCall,
            pot_after_call: totalPotAfterCall
        };
    }

    /**
     * Format action history for display
     */
    formatActionHistory(actions) {
        return actions.map(action => {
            const formatted = {
                action_id: action.action_id,
                player_id: action.player_id,
                username: action.username,
                seat_number: action.seat_number,
                action_type: action.action_type,
                amount: action.amount,
                stage: action.stage,
                acted_at: action.acted_at
            };

            switch (action.action_type) {
                case 'fold':
                    formatted.description = `${action.username} folded`;
                    break;
                case 'check':
                    formatted.description = `${action.username} checked`;
                    break;
                case 'call':
                    formatted.description = `${action.username} called ${action.amount}`;
                    break;
                case 'raise':
                    formatted.description = `${action.username} raised to ${action.amount}`;
                    break;
                case 'all_in':
                    formatted.description = `${action.username} went all-in with ${action.amount}`;
                    break;
                case 'blind':
                    const blindType = action.amount === 10 ? 'small blind' : 'big blind';
                    formatted.description = `${action.username} posted ${blindType} (${action.amount})`;
                    break;
                default:
                    formatted.description = `${action.username} ${action.action_type} ${action.amount || ''}`;
            }

            return formatted;
        });
    }

    /**
     * Get stage progression information
     */
    getStageInfo(currentStage) {
        const stages = {
            pre_flop: {
                name: 'Pre-Flop',
                description: 'Players have hole cards, community cards not dealt yet',
                community_cards_count: 0,
                next_stage: 'flop'
            },
            flop: {
                name: 'Flop',
                description: 'First 3 community cards dealt',
                community_cards_count: 3,
                next_stage: 'turn'
            },
            turn: {
                name: 'Turn',
                description: '4th community card dealt',
                community_cards_count: 4,
                next_stage: 'river'
            },
            river: {
                name: 'River',
                description: '5th and final community card dealt',
                community_cards_count: 5,
                next_stage: 'showdown'
            },
            showdown: {
                name: 'Showdown',
                description: 'Players reveal cards, winner determined',
                community_cards_count: 5,
                next_stage: null
            }
        };

        return stages[currentStage] || {
            name: 'Unknown',
            description: 'Unknown stage',
            community_cards_count: 0,
            next_stage: null
        };
    }
}

// Export singleton instance
module.exports = new PokerGameUtils();