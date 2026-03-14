function tableLobby() {
    return {
        loading: true,
        error: null,
        user: null,
        table: null,
        tableId: null,
        myPlayerId: null,
        actionInProgress: false,
        pollingInterval: null,
        activeGame: null,

        get isSeated() {
            if (!this.table?.players || !this.myPlayerId) return false;
            return this.table.players.some(p => p.player_id === this.myPlayerId);
        },

        get seats() {
            const seats = [];
            const maxSeats = this.table?.max_players || 9;

            for (let i = 1; i <= maxSeats; i++) {
                const player = this.table?.players?.find(p => p.seat_number === i);
                seats.push({
                    number: i,
                    player: player || null
                });
            }
            return seats;
        },

        async loadUserInfo() {
            try {
                const userData = getUserData();
                if (userData) {
                    this.user = userData;
                    this.myPlayerId = userData.player_id;
                }
            } catch (error) {
                console.error('Failed to load user info:', error);
            }
        },

        async fetchTableData() {
            if (!this.tableId) return;

            try {
                const response = await authenticatedFetch(`/api/tables/${this.tableId}`);
                if (!response.ok) {
                    throw new Error('Failed to fetch table data');
                }

                this.table = await response.json();

                // Check for active game
                try {
                    const gameResponse = await authenticatedFetch(`/api/games/tables/${this.tableId}/active-game`);
                    if (gameResponse.ok) {
                        this.activeGame = await gameResponse.json();
                    } else {
                        this.activeGame = null;
                    }
                } catch (gameError) {
                    this.activeGame = null;
                }

                this.error = null;
            } catch (error) {
                console.error('Error fetching table data:', error);
                this.error = error.message;
            }
        },

        async joinTable() {
            this.actionInProgress = true;
            try {
                const chipAmount = prompt('How many chips would you like to buy in with?', '1000');
                if (!chipAmount || isNaN(chipAmount) || chipAmount <= 0) {
                    this.actionInProgress = false;
                    return;
                }

                const response = await authenticatedFetch(`/api/tables/${this.tableId}/join`, {
                    method: 'POST',
                    body: JSON.stringify({ chip_stack: parseInt(chipAmount) })
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.message);
                }

                // Refresh table data
                await this.fetchTableData();

                // Update user balance
                await this.loadUserInfo();

            } catch (error) {
                console.error('Join table error:', error);
                alert(`Failed to join table: ${error.message}`);
            } finally {
                this.actionInProgress = false;
            }
        },

        async startGame() {
            this.actionInProgress = true;
            try {
                // Find a dealer seat (just use first seated player for now)
                const firstPlayer = this.table.players[0];
                const dealerSeat = firstPlayer?.seat_number || 1;

                const response = await authenticatedFetch('/api/games', {
                    method: 'POST',
                    body: JSON.stringify({
                        table_id: this.tableId,
                        dealer_seat: dealerSeat
                    })
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.message);
                }

                const gameData = await response.json();

                // Navigate to game
                window.location.href = `game.html?tableId=${this.tableId}&gameId=${gameData.game_id}`;

            } catch (error) {
                console.error('Start game error:', error);
                alert(`Failed to start game: ${error.message}`);
            } finally {
                this.actionInProgress = false;
            }
        },

        async addChips() {
            this.actionInProgress = true;
            try {
                const chipAmount = prompt('How many additional chips would you like to buy?', '500');
                if (!chipAmount || isNaN(chipAmount) || chipAmount <= 0) {
                    this.actionInProgress = false;
                    return;
                }

                const response = await authenticatedFetch(`/api/tables/${this.tableId}/chip-stack`, {
                    method: 'PUT',
                    body: JSON.stringify({ additional_chips: parseInt(chipAmount) })
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.message);
                }

                // Refresh table and user data
                await this.fetchTableData();
                await this.loadUserInfo();

            } catch (error) {
                console.error('Add chips error:', error);
                alert(`Failed to add chips: ${error.message}`);
            } finally {
                this.actionInProgress = false;
            }
        },

        async leaveTable() {
            if (!confirm('Are you sure you want to leave the table? Your chips will be returned to your balance.')) {
                return;
            }

            this.actionInProgress = true;
            try {
                const response = await authenticatedFetch(`/api/tables/${this.tableId}/leave`, {
                    method: 'DELETE'
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.message);
                }

                // Go back to home page
                window.location.href = 'home.html';

            } catch (error) {
                console.error('Leave table error:', error);
                alert(`Failed to leave table: ${error.message}`);
            } finally {
                this.actionInProgress = false;
            }
        },

        async joinActiveGame() {
            if (this.activeGame) {
                window.location.href = `game.html?tableId=${this.tableId}&gameId=${this.activeGame.game_id}`;
            }
        },

        startPolling() {
            // Poll every 3 seconds for table updates
            this.pollingInterval = setInterval(async () => {
                if (!this.loading) {
                    await this.fetchTableData();
                }
            }, 3000);
        },

        stopPolling() {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
            }
        },

        async init() {
            try {
                // Check authentication
                if (!isAuthenticated()) {
                    window.location.href = 'login.html';
                    return;
                }

                // Load user info
                await this.loadUserInfo();

                // Get table ID from URL parameter
                const urlParams = new URLSearchParams(window.location.search);
                this.tableId = urlParams.get('tableId');

                if (!this.tableId) {
                    throw new Error('No table ID provided');
                }

                // Load table data
                await this.fetchTableData();

                // Start polling for updates
                this.startPolling();

            } catch (error) {
                console.error('Initialization error:', error);
                this.error = error.message;
            } finally {
                this.loading = false;
            }
        },

        // Cleanup when leaving page
        destroy() {
            this.stopPolling();
        }
    };
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (window.tableLobbyInstance) {
        window.tableLobbyInstance.destroy();
    }
});