function pokerGame() {
  return {
    // ── Stages ─────────────────────────────────────────
    stages: ['pre_flop', 'flop', 'turn', 'river', 'showdown'],

    // ── UI state ───────────────────────────────────────
    loading: true,
    error: null,
    user: null,
    game: null,
    tableId: null,
    gameId: null,
    myPlayerId: null,
    pollingInterval: null,
    
    // Action state
    showRaise: false,
    raiseAmount: 0,
    actionInProgress: false,
    timerPct: 100,
    myHandLabel: '', // Could be used for hand strength display

    // ── Computed ───────────────────────────────────────
    get myPlayer() {
      if (!this.game?.players || !this.myPlayerId) return null;
      return this.game.players.find(p => p.player_id === this.myPlayerId) || null;
    },

    get isMyTurn() {
      return this.game?.active_player_id === this.myPlayerId && 
             this.game?.stage !== 'showdown' && 
             this.myPlayer && !this.myPlayer.is_folded;
    },

    get actionDisabled() {
      return this.actionInProgress || !this.game || this.game.stage === 'showdown';
    },

    get toCall() {
      if (!this.game?.players || !this.myPlayer) return 0;
      const maxBet = Math.max(...this.game.players.map(p => p.current_bet || 0));
      return Math.max(0, maxBet - (this.myPlayer.current_bet || 0));
    },

    get minRaise() {
      const bigBlind = this.game?.big_blind || 20;
      return this.toCall + bigBlind;
    },

    get canRaise() {
      if (!this.myPlayer) return false;
      const stack = this.myPlayer.chips_end || this.myPlayer.chips_start || 0;
      return stack > this.toCall;
    },

    get activePlayerName() {
      if (!this.game?.players || !this.game?.active_player_id) return '';
      const player = this.game.players.find(p => p.player_id === this.game.active_player_id);
      return player?.username || '';
    },

    get communityDisplay() {
      const cards = this.game?.community_cards || [];
      // Show 5 card slots total, face-down for unrevealed cards
      const displayCards = [];
      for (let i = 0; i < 5; i++) {
        if (i < cards.length && cards[i]) {
          displayCards.push({ faceDown: false, ...this.parseCard(cards[i]) });
        } else {
          displayCards.push({ faceDown: true });
        }
      }
      return displayCards;
    },

    // ── Helpers ────────────────────────────────────────
    initials(name) {
      return name ? name.slice(0, 2).toUpperCase() : '??';
    },

    // Parse a single card code like "Ah", "Kd", "10c", "Ts"
    parseCard(code) {
      if (!code) return { faceDown: true };
      const suits = { h: '♥', d: '♦', c: '♣', s: '♠' };
      const redSuits = new Set(['h', 'd']);
      const suitChar = code[code.length - 1].toLowerCase();
      const rank = code.slice(0, -1).toUpperCase().replace('T', '10');
      return {
        raw: code,
        rank,
        suit: suits[suitChar] || suitChar,
        color: redSuits.has(suitChar) ? 'red' : 'black',
        faceDown: false,
      };
    },

    // Parse an array of card codes (from hole_cards JSON column)
    parseCards(cards) {
      if (!cards || !cards.length) return [];
      return cards.map(c => this.parseCard(c));
    },

    toggleRaise() {
      this.showRaise = !this.showRaise;
      if (this.showRaise) {
        this.raiseAmount = this.minRaise;
      }
    },

    // ── API Methods ────────────────────────────────────
    async act(type) {
      if (this.actionInProgress || !this.gameId) return;

      this.actionInProgress = true;
      try {
        const payload = {
          game_id: this.gameId,
          player_id: this.myPlayerId,
          action_type: type === 'check' ? 'check' : type,
          amount: type === 'raise' ? this.raiseAmount : type === 'call' ? this.toCall : 0,
          stage: this.game.stage
        };

        console.log('Sending action:', payload);

        const response = await authenticatedFetch('/api/actions', {
          method: 'POST',
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          throw new Error(`Action failed: ${response.status} ${response.statusText}`);
        }

        // Reset UI state
        this.showRaise = false;
        
        // Refresh game state immediately
        await this.fetchGameState();

      } catch (error) {
        console.error('Action error:', error);
        this.error = error.message;
      } finally {
        this.actionInProgress = false;
      }
    },

    async fetchGameState() {
      if (!this.gameId) return;

      try {
        // Fetch both game state and table info
        const [gameRes, tableRes] = await Promise.all([
          authenticatedFetch(`/api/games/${this.gameId}`),
          authenticatedFetch(`/api/tables/${this.tableId}`)
        ]);

        if (!gameRes.ok || !tableRes.ok) {
          throw new Error('Failed to fetch game state');
        }

        const [gameData, tableData] = await Promise.all([
          gameRes.json(),
          tableRes.json()
        ]);

        // Merge data into expected format
        this.game = {
          ...gameData,
          tableName: tableData.name,
          smallBlind: tableData.small_blind,
          bigBlind: tableData.big_blind,
          small_blind: tableData.small_blind,
          big_blind: tableData.big_blind,
          players: gameData.players || [],
          community_cards: gameData.community_cards || [],
          active_player_id: gameData.active_seat ? this.findPlayerBySeat(gameData.active_seat) : null
        };

        this.error = null;

      } catch (error) {
        console.error('Failed to fetch game state:', error);
        this.error = error.message;
      }
    },

    findPlayerBySeat(seatNumber) {
      if (!this.game?.players || !seatNumber) return null;
      const player = this.game.players.find(p => p.seat_number === seatNumber);
      return player?.player_id || null;
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

    startPolling() {
      // Poll every 2 seconds for game state updates
      this.pollingInterval = setInterval(async () => {
        if (!this.loading && this.gameId) {
          await this.fetchGameState();
        }
      }, 2000);
    },

    stopPolling() {
      if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = null;
      }
    },

    async reloadGame() {
      this.loading = true;
      this.error = null;
      await this.init();
    },

    // ── Init ───────────────────────────────────────────
    async init() {
      try {
        // Check authentication
        if (!isAuthenticated()) {
          window.location.href = 'login.html';
          return;
        }

        // Load user info
        await this.loadUserInfo();

        // Get table and game IDs from URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        this.tableId = urlParams.get('tableId');
        this.gameId = urlParams.get('gameId');

        if (!this.tableId) {
          throw new Error('No table ID provided');
        }

        // If no gameId provided, try to find active game on table
        if (!this.gameId) {
          const tableRes = await authenticatedFetch(`/api/tables/${this.tableId}`);
          if (!tableRes.ok) {
            throw new Error('Failed to fetch table info');
          }
          // You might need to add an endpoint to get active game for a table
          // For now, we'll show error if no gameId
          throw new Error('No active game found');
        }

        // Load initial game state
        await this.fetchGameState();

        // Start polling for updates
        this.startPolling();

        // Add beforeunload handler to handle leaving
        this.setupBeforeUnload();

      } catch (error) {
        console.error('Initialization error:', error);
        this.error = error.message;
      } finally {
        this.loading = false;
      }
    },

    setupBeforeUnload() {
      // Only leave table if navigating away from game, not to home
      window.addEventListener('beforeunload', (event) => {
        // This will be fired when navigating away, closing tab, etc
        if (this.tableId && getAuthToken()) {
          // Use POST instead of DELETE for beacon
          const formData = new FormData();
          formData.append('auth', 'Bearer ' + getAuthToken());
          navigator.sendBeacon('/api/tables/' + this.tableId + '/leave', formData);
        }
      });

      // Also handle navigation within the app
      window.addEventListener('unload', () => {
        if (this.tableId && getAuthToken()) {
          const formData = new FormData();
          formData.append('auth', 'Bearer ' + getAuthToken());
          navigator.sendBeacon('/api/tables/' + this.tableId + '/leave', formData);
        }
      });
    },

    // Cleanup when component is destroyed
    destroy() {
      this.stopPolling();
    }
  };
}
