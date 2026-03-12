// ─────────────────────────────────────────
// BETTING ROUND MANAGER — Prevents infinite loops
// ─────────────────────────────────────────

class BettingRound {
    constructor(players, smallBlind, bigBlind, isPreflop = false) {
        this.players = players; // Array of player objects
        this.smallBlind = smallBlind;
        this.bigBlind = bigBlind;
        this.isPreflop = isPreflop;
        
        // Betting state
        this.highestBet = 0;
        this.minRaise = bigBlind;
        this.lastAggressor = null;
        this.currentPlayerIndex = 0;
        
        // Initialize betting round
        this.initializeBetting();
    }

    /**
     * Initialize betting round - different logic for preflop vs postflop
     */
    initializeBetting() {
        // Reset all players for new betting round
        for (const player of this.players) {
            player.bet = 0;
            player.acted = false;
        }

        if (this.isPreflop) {
            this.setupPreflop();
        } else {
            this.setupPostflop();
        }
    }

    /**
     * Setup preflop betting - blinds and action order
     */
    setupPreflop() {
        const activePlayers = this.getActivePlayers();
        
        if (activePlayers.length < 2) {
            throw new Error('Need at least 2 active players');
        }

        let sbIndex, bbIndex;

        if (activePlayers.length === 2) {
            // Heads up: Dealer = SB, acts first preflop
            const dealerIndex = activePlayers.findIndex(p => p.isDealer);
            sbIndex = dealerIndex;
            bbIndex = (dealerIndex + 1) % activePlayers.length;
            
            // Action starts with SB (dealer) in heads up preflop
            this.currentPlayerIndex = this.players.indexOf(activePlayers[sbIndex]);
        } else {
            // 3+ players: SB after dealer, BB after SB
            const dealerIndex = activePlayers.findIndex(p => p.isDealer);
            sbIndex = (dealerIndex + 1) % activePlayers.length;
            bbIndex = (dealerIndex + 2) % activePlayers.length;
            
            // Action starts left of BB (UTG)
            const utgIndex = (dealerIndex + 3) % activePlayers.length;
            this.currentPlayerIndex = this.players.indexOf(activePlayers[utgIndex]);
        }

        // Post blinds
        const sbPlayer = activePlayers[sbIndex];
        const bbPlayer = activePlayers[bbIndex];

        this.postBlind(sbPlayer, this.smallBlind, 'small_blind');
        this.postBlind(bbPlayer, this.bigBlind, 'big_blind');

        // Set betting parameters
        this.highestBet = this.bigBlind;
        this.minRaise = this.bigBlind;
        this.lastAggressor = bbPlayer.player_id; // BB is initial aggressor
    }

    /**
     * Setup postflop betting
     */
    setupPostflop() {
        const activePlayers = this.getActivePlayers();
        
        if (activePlayers.length < 2) {
            throw new Error('Need at least 2 active players');
        }

        // Reset betting state
        this.highestBet = 0;
        this.minRaise = this.bigBlind;
        this.lastAggressor = null;

        if (activePlayers.length === 2) {
            // Heads up: BB acts first postflop
            const bbIndex = activePlayers.findIndex(p => !p.isDealer);
            this.currentPlayerIndex = this.players.indexOf(activePlayers[bbIndex]);
        } else {
            // 3+ players: First active player left of dealer
            const dealerIndex = activePlayers.findIndex(p => p.isDealer);
            let firstActiveIndex = (dealerIndex + 1) % activePlayers.length;
            
            // Find first non-folded, non-all-in player
            let attempts = 0;
            while (attempts < activePlayers.length) {
                const player = activePlayers[firstActiveIndex];
                if (!player.folded && !player.allIn) {
                    break;
                }
                firstActiveIndex = (firstActiveIndex + 1) % activePlayers.length;
                attempts++;
            }

            this.currentPlayerIndex = this.players.indexOf(activePlayers[firstActiveIndex]);
        }
    }

    /**
     * Post a blind bet
     */
    postBlind(player, amount, blindType) {
        const actualAmount = Math.min(amount, player.stack);
        
        player.stack -= actualAmount;
        player.bet = actualAmount;
        player.acted = true; // Blinds count as having acted
        
        if (player.stack === 0) {
            player.allIn = true;
        }

        // Store blind action for history
        player.lastAction = {
            type: blindType,
            amount: actualAmount
        };
    }

    /**
     * Handle a player action
     */
    handleAction(playerId, action, amount = 0) {
        const player = this.getPlayerById(playerId);
        
        if (!player) {
            throw new Error(`Player ${playerId} not found`);
        }

        if (player.player_id !== this.getCurrentPlayer().player_id) {
            throw new Error(`Not ${player.username}'s turn`);
        }

        if (player.folded || player.allIn) {
            throw new Error(`Player ${player.username} cannot act - folded or all-in`);
        }

        const result = this.processAction(player, action, amount);
        
        // Move to next player if betting round continues
        if (!this.isBettingComplete()) {
            this.nextPlayer();
        }

        return {
            success: true,
            player: player,
            action: result,
            bettingComplete: this.isBettingComplete(),
            currentPlayer: this.getCurrentPlayer()
        };
    }

    /**
     * Process specific action type
     */
    processAction(player, action, amount) {
        switch (action.toLowerCase()) {
            case 'fold':
                return this.processFold(player);
            
            case 'check':
                return this.processCheck(player);
            
            case 'call':
                return this.processCall(player);
            
            case 'bet':
                return this.processBet(player, amount);
            
            case 'raise':
                return this.processRaise(player, amount);
            
            case 'all_in':
                return this.processAllIn(player);
            
            default:
                throw new Error(`Invalid action: ${action}`);
        }
    }

    /**
     * Process fold action
     */
    processFold(player) {
        player.folded = true;
        player.acted = true;
        
        player.lastAction = {
            type: 'fold',
            amount: 0
        };

        return { type: 'fold', amount: 0 };
    }

    /**
     * Process check action
     */
    processCheck(player) {
        if (player.bet !== this.highestBet) {
            throw new Error('Cannot check - must call or raise');
        }

        player.acted = true;
        
        player.lastAction = {
            type: 'check',
            amount: 0
        };

        return { type: 'check', amount: 0 };
    }

    /**
     * Process call action
     */
    processCall(player) {
        const callAmount = Math.min(
            this.highestBet - player.bet,
            player.stack
        );

        player.stack -= callAmount;
        player.bet += callAmount;
        player.acted = true;

        if (player.stack === 0) {
            player.allIn = true;
        }

        player.lastAction = {
            type: 'call',
            amount: callAmount
        };

        return { type: 'call', amount: callAmount };
    }

    /**
     * Process bet action (only if no bet yet)
     */
    processBet(player, amount) {
        if (this.highestBet > 0) {
            throw new Error('Cannot bet - must call or raise');
        }

        if (amount > player.stack) {
            throw new Error('Bet amount exceeds stack');
        }

        if (amount < this.minRaise) {
            throw new Error(`Minimum bet is ${this.minRaise}`);
        }

        player.stack -= amount;
        player.bet += amount;
        player.acted = true;

        this.highestBet = amount;
        this.minRaise = amount;
        this.lastAggressor = player.player_id;
        this.resetOtherPlayersActed(player.player_id);

        if (player.stack === 0) {
            player.allIn = true;
        }

        player.lastAction = {
            type: 'bet',
            amount: amount
        };

        return { type: 'bet', amount: amount };
    }

    /**
     * Process raise action
     */
    processRaise(player, amount) {
        const minRaiseAmount = this.highestBet + this.minRaise;
        
        if (amount < minRaiseAmount && amount < player.stack) {
            throw new Error(`Minimum raise is ${minRaiseAmount}`);
        }

        if (amount > this.highestBet + player.stack) {
            throw new Error('Raise amount exceeds stack');
        }

        const raiseAmount = amount - player.bet;
        
        player.stack -= raiseAmount;
        player.bet = amount;
        player.acted = true;

        // Update betting parameters
        this.minRaise = amount - this.highestBet;
        this.highestBet = amount;
        this.lastAggressor = player.player_id;
        this.resetOtherPlayersActed(player.player_id);

        if (player.stack === 0) {
            player.allIn = true;
        }

        player.lastAction = {
            type: 'raise',
            amount: amount
        };

        return { type: 'raise', amount: amount };
    }

    /**
     * Process all-in action
     */
    processAllIn(player) {
        const allInAmount = player.bet + player.stack;
        
        player.bet = allInAmount;
        player.stack = 0;
        player.allIn = true;
        player.acted = true;

        // If this is a raise (all-in amount > highest bet), update aggressor
        if (allInAmount > this.highestBet) {
            this.minRaise = allInAmount - this.highestBet;
            this.highestBet = allInAmount;
            this.lastAggressor = player.player_id;
            this.resetOtherPlayersActed(player.player_id);
        }

        player.lastAction = {
            type: 'all_in',
            amount: allInAmount
        };

        return { type: 'all_in', amount: allInAmount };
    }

    /**
     * Reset acted status for all players except the specified one
     */
    resetOtherPlayersActed(exceptPlayerId) {
        for (const player of this.players) {
            if (player.player_id !== exceptPlayerId && !player.folded && !player.allIn) {
                player.acted = false;
            }
        }
    }

    /**
     * Move to next active player
     */
    nextPlayer() {
        const activePlayers = this.getActivePlayers();
        let attempts = 0;
        
        do {
            this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
            attempts++;
            
            if (attempts > this.players.length) {
                throw new Error('Could not find next active player');
            }
        } while (
            this.players[this.currentPlayerIndex].folded ||
            this.players[this.currentPlayerIndex].allIn
        );
    }

    /**
     * Check if betting round is complete
     * KEY LOGIC: Prevents infinite loops
     */
    isBettingComplete() {
        const activePlayers = this.getActivePlayers();
        
        // If only one player left, betting is complete
        if (activePlayers.length <= 1) {
            return true;
        }

        // Check if all active players have either:
        // 1. Matched the highest bet AND acted
        // 2. Are all-in
        // 3. Have folded
        for (const player of this.players) {
            if (player.folded) continue;
            if (player.allIn) continue;

            // Player must have matched highest bet and acted
            if (player.bet !== this.highestBet || !player.acted) {
                return false;
            }
        }

        // Additional check: If there's a last aggressor, 
        // action must have returned to them
        if (this.lastAggressor) {
            const aggressor = this.getPlayerById(this.lastAggressor);
            
            // If aggressor is still active and hasn't acted since their aggression
            if (aggressor && !aggressor.folded && !aggressor.allIn) {
                // Check if action has completed a full cycle back to them
                return aggressor.acted;
            }
        }

        return true;
    }

    /**
     * Get all active (non-folded) players
     */
    getActivePlayers() {
        return this.players.filter(player => !player.folded);
    }

    /**
     * Get current player whose turn it is
     */
    getCurrentPlayer() {
        return this.players[this.currentPlayerIndex];
    }

    /**
     * Get player by ID
     */
    getPlayerById(playerId) {
        return this.players.find(p => p.player_id === playerId);
    }

    /**
     * Get available actions for current player
     */
    getAvailableActions() {
        const player = this.getCurrentPlayer();
        const actions = [];

        if (player.folded || player.allIn) {
            return actions;
        }

        // Always can fold
        actions.push({ type: 'fold', amount: 0 });

        const callAmount = this.highestBet - player.bet;

        // Check or call
        if (callAmount === 0) {
            actions.push({ type: 'check', amount: 0 });
        } else {
            const actualCallAmount = Math.min(callAmount, player.stack);
            actions.push({ 
                type: 'call', 
                amount: actualCallAmount,
                description: `Call ${actualCallAmount}`
            });
        }

        // Bet or raise
        if (this.highestBet === 0) {
            // No bet yet - can bet
            actions.push({
                type: 'bet',
                minAmount: this.minRaise,
                maxAmount: player.stack
            });
        } else if (player.stack > callAmount) {
            // Can raise
            const minRaiseAmount = this.highestBet + this.minRaise;
            actions.push({
                type: 'raise',
                minAmount: Math.min(minRaiseAmount, player.bet + player.stack),
                maxAmount: player.bet + player.stack
            });
        }

        // All-in (if player has chips)
        if (player.stack > 0) {
            actions.push({
                type: 'all_in',
                amount: player.bet + player.stack
            });
        }

        return actions;
    }

    /**
     * Get betting round summary
     */
    getSummary() {
        return {
            highestBet: this.highestBet,
            minRaise: this.minRaise,
            lastAggressor: this.lastAggressor,
            currentPlayer: this.getCurrentPlayer().player_id,
            isComplete: this.isBettingComplete(),
            totalPot: this.players.reduce((sum, p) => sum + p.bet, 0),
            activePlayers: this.getActivePlayers().length,
            availableActions: this.getAvailableActions()
        };
    }
}

module.exports = BettingRound;