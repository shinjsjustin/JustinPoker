// ─────────────────────────────────────────
// POT MANAGER — Handles main pot and side pots
// ─────────────────────────────────────────

class PotManager {
    constructor() {
        this.mainPot = 0;
        this.sidePots = [];
        this.totalPot = 0;
    }

    /**
     * Calculate pots from player bets (handles all-in scenarios)
     * @param {Array} players - Array of player objects with bet amounts
     */
    calculatePots(players) {
        // Reset pots
        this.mainPot = 0;
        this.sidePots = [];
        
        const activePlayers = players.filter(p => !p.folded && p.bet > 0);
        
        if (activePlayers.length === 0) {
            this.totalPot = 0;
            return this.getPotStructure();
        }

        // Sort players by their bet amounts (ascending)
        const sortedByBet = [...activePlayers].sort((a, b) => a.bet - b.bet);
        
        let previousBetLevel = 0;
        const eligiblePlayersAtLevel = [...activePlayers];
        
        // Create side pots for different bet levels
        for (let i = 0; i < sortedByBet.length; i++) {
            const currentBetLevel = sortedByBet[i].bet;
            const betDifference = currentBetLevel - previousBetLevel;
            
            if (betDifference > 0) {
                // Calculate pot size for this level
                const potSize = betDifference * eligiblePlayersAtLevel.length;
                
                if (i === 0) {
                    // First level is main pot
                    this.mainPot = potSize;
                } else {
                    // Subsequent levels are side pots
                    this.sidePots.push({
                        amount: potSize,
                        eligiblePlayers: [...eligiblePlayersAtLevel],
                        level: i + 1,
                        description: `Side pot ${i} (${eligiblePlayersAtLevel.length} players)`
                    });
                }
            }
            
            // Remove players who are capped at this bet level
            const playersAtThisLevel = sortedByBet.filter(p => p.bet === currentBetLevel);
            for (const player of playersAtThisLevel) {
                const index = eligiblePlayersAtLevel.findIndex(p => p.player_id === player.player_id);
                if (index !== -1) {
                    eligiblePlayersAtLevel.splice(index, 1);
                }
            }
            
            previousBetLevel = currentBetLevel;
        }
        
        // Calculate total pot
        this.totalPot = this.mainPot + this.sidePots.reduce((sum, pot) => sum + pot.amount, 0);
        
        return this.getPotStructure();
    }

    /**
     * Add chips to pot from completed betting round
     * @param {Array} players - Players with their bet amounts
     */
    collectBets(players) {
        const potStructure = this.calculatePots(players);
        
        // Reset player bet amounts after collecting
        for (const player of players) {
            player.bet = 0;
        }
        
        return potStructure;
    }

    /**
     * Distribute pots to winners
     * @param {Array} winners - Array of winner objects with pot eligibility
     * @param {Object} potStructure - Current pot structure
     * @returns {Array} Array of { player_id, amount, pot_type } payouts
     */
    distributePots(winners, potStructure = null) {
        if (!potStructure) {
            potStructure = this.getPotStructure();
        }

        const distributions = [];
        
        // Distribute main pot
        if (potStructure.mainPot > 0) {
            const mainPotWinners = winners.filter(w => w.eligible_for_main_pot !== false);
            
            if (mainPotWinners.length > 0) {
                const amountPerWinner = Math.floor(potStructure.mainPot / mainPotWinners.length);
                let remainder = potStructure.mainPot % mainPotWinners.length;
                
                for (let i = 0; i < mainPotWinners.length; i++) {
                    const winner = mainPotWinners[i];
                    let amount = amountPerWinner;
                    
                    // Give remainder chips to first winners (common convention)
                    if (i < remainder) {
                        amount += 1;
                    }
                    
                    distributions.push({
                        player_id: winner.player_id,
                        username: winner.username,
                        amount: amount,
                        pot_type: 'main',
                        hand_description: winner.hand ? winner.hand.name : 'Unknown'
                    });
                }
            }
        }

        // Distribute side pots
        for (const sidePot of potStructure.sidePots) {
            const eligibleWinners = winners.filter(winner => 
                sidePot.eligiblePlayers.some(eligible => 
                    eligible.player_id === winner.player_id
                )
            );
            
            if (eligibleWinners.length > 0) {
                const amountPerWinner = Math.floor(sidePot.amount / eligibleWinners.length);
                let remainder = sidePot.amount % eligibleWinners.length;
                
                for (let i = 0; i < eligibleWinners.length; i++) {
                    const winner = eligibleWinners[i];
                    let amount = amountPerWinner;
                    
                    // Give remainder chips to first winners
                    if (i < remainder) {
                        amount += 1;
                    }
                    
                    distributions.push({
                        player_id: winner.player_id,
                        username: winner.username,
                        amount: amount,
                        pot_type: `side_${sidePot.level}`,
                        hand_description: winner.hand ? winner.hand.name : 'Unknown'
                    });
                }
            }
        }

        return distributions;
    }

    /**
     * Get current pot structure
     */
    getPotStructure() {
        return {
            mainPot: this.mainPot,
            sidePots: [...this.sidePots],
            totalPot: this.totalPot,
            potCount: 1 + this.sidePots.length
        };
    }

    /**
     * Calculate pot odds for a player
     * @param {number} callAmount - Amount player needs to call
     * @param {number} currentPot - Current pot size
     * @returns {Object} Pot odds information
     */
    calculatePotOdds(callAmount, currentPot = null) {
        const potSize = currentPot || this.totalPot;
        
        if (callAmount <= 0) {
            return {
                ratio: 'N/A',
                percentage: 0,
                implied_odds: potSize,
                description: 'No bet to call'
            };
        }

        const potAfterCall = potSize + callAmount;
        const odds = potAfterCall / callAmount;
        const percentage = (callAmount / potAfterCall) * 100;

        return {
            ratio: `${odds.toFixed(1)}:1`,
            percentage: percentage.toFixed(1) + '%',
            pot_size: potSize,
            call_amount: callAmount,
            pot_after_call: potAfterCall,
            implied_odds: potAfterCall,
            description: `Getting ${odds.toFixed(1)} to 1 on your money`
        };
    }

    /**
     * Calculate effective stack sizes for all-in scenarios
     * @param {Array} players - Array of player objects
     * @returns {Object} Stack analysis
     */
    calculateEffectiveStacks(players) {
        const activePlayers = players.filter(p => !p.folded);
        
        if (activePlayers.length < 2) {
            return { effective_stack: 0, all_in_threshold: 0 };
        }

        // Sort by stack size
        const stackSizes = activePlayers.map(p => p.stack).sort((a, b) => a - b);
        
        return {
            effective_stack: stackSizes[1], // Second smallest stack (what matters for betting)
            shortest_stack: stackSizes[0],
            average_stack: stackSizes.reduce((sum, stack) => sum + stack, 0) / stackSizes.length,
            all_in_threshold: stackSizes[0], // Smallest stack sets all-in limit
            stack_distribution: stackSizes
        };
    }

    /**
     * Reset pots for new hand
     */
    reset() {
        this.mainPot = 0;
        this.sidePots = [];
        this.totalPot = 0;
    }

    /**
     * Get detailed pot information for display
     */
    getPotDetails() {
        const details = {
            main_pot: {
                amount: this.mainPot,
                description: `Main pot: ${this.mainPot} chips`
            },
            side_pots: this.sidePots.map(pot => ({
                amount: pot.amount,
                level: pot.level,
                eligible_players: pot.eligiblePlayers.length,
                description: `Side pot ${pot.level}: ${pot.amount} chips (${pot.eligiblePlayers.length} players eligible)`
            })),
            total_pot: this.totalPot,
            summary: this.generatePotSummary()
        };

        return details;
    }

    /**
     * Generate human-readable pot summary
     */
    generatePotSummary() {
        if (this.sidePots.length === 0) {
            return `Single pot of ${this.totalPot} chips`;
        }

        const potDescriptions = [`Main pot: ${this.mainPot}`];
        
        for (const sidePot of this.sidePots) {
            potDescriptions.push(`Side pot ${sidePot.level}: ${sidePot.amount}`);
        }

        return `Multiple pots - ${potDescriptions.join(', ')} (Total: ${this.totalPot} chips)`;
    }

    /**
     * Validate pot calculations against expected total
     * @param {number} expectedTotal - Expected total from all player bets
     * @returns {boolean} True if pot calculations are correct
     */
    validatePotCalculation(expectedTotal) {
        const calculatedTotal = this.mainPot + this.sidePots.reduce((sum, pot) => sum + pot.amount, 0);
        const difference = Math.abs(calculatedTotal - expectedTotal);
        
        // Allow for small rounding differences
        return difference <= 1;
    }
}

module.exports = PotManager;