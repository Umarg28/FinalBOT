/**
 * BETABOT Dashboard WebSocket Client
 * Handles real-time updates and DOM rendering
 */

class DashboardClient {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectDelay = 1000;
    this.lastData = null;
    this.selectedHistoryBot = 'main';  // Currently selected bot for history
    this.selectedViewBot = 'main';     // Currently selected bot for main dashboard view
    this.selectedPeriod = '1d';        // Currently selected time period for PnL
    this.selectedHistoryFilter = 'all'; // Market type filter for history
    this.allBotsHistory = [];          // Store all bots' history
    this.allBots = [];                 // Store all bot summaries
    this.externalBotsMarkets = [];     // Store external bots' market data
    this.pendingResets = new Set();    // Track pending resets

    // Value change tracking for animations
    this.previousValues = {};

    // Price tracking for arrows
    this.previousPrices = new Map(); // marketKey -> { priceUp, priceDown }

    // Bind methods
    this.connect = this.connect.bind(this);
    this.handleMessage = this.handleMessage.bind(this);

    // Theme setup before rendering content
    this.applyStoredTheme();
    this.initThemeToggle();

    // Start connection
    this.connect();

    // Initialize history bot selector
    this.initHistoryBotSelector();

    // Initialize bot card click handlers
    this.initBotCardSelector();

    // Initialize header bot switch
    this.initBotSwitch();

    // Initialize period selector
    this.initPeriodSelector();

    // Initialize settings menu
    this.initSettingsMenu();

    // Initialize history filter
    this.initHistoryFilter();

    // Ping interval for keepalive
    setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  /**
   * Apply stored theme preferences or system defaults
   */
  applyStoredTheme() {
    const savedTheme = localStorage.getItem('betabot-theme');
    let theme = savedTheme;
    if (!theme) {
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      theme = prefersDark ? 'dark' : 'light';
    }
    this.setTheme(theme, false);

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.checked = theme === 'dark';
    }

    if (!savedTheme && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (event) => {
        const newTheme = event.matches ? 'dark' : 'light';
        this.setTheme(newTheme, false);
        const themeToggle = document.getElementById('theme-toggle');
        if (themeToggle) {
          themeToggle.checked = newTheme === 'dark';
        }
      };

      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener('change', handler);
      } else if (mediaQuery.addListener) {
        mediaQuery.addListener(handler);
      }
    }
  }

  /**
   * Initialize theme toggle interactions
   */
  initThemeToggle() {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;

    toggle.addEventListener('change', () => {
      const theme = toggle.checked ? 'dark' : 'light';
      this.setTheme(theme);
    });
  }

  /**
   * Set theme attribute and optionally persist
   */
  setTheme(theme, persist = true) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) {
      localStorage.setItem('betabot-theme', theme);
    }
  }

  /**
   * Initialize history bot selector click handlers
   */
  initHistoryBotSelector() {
    const selector = document.getElementById('history-bot-selector');
    if (!selector) return;

    selector.addEventListener('click', (e) => {
      const pill = e.target.closest('.bot-pill');
      if (!pill) return;

      const botId = pill.dataset.bot;
      this.selectedHistoryBot = botId;

      // Update active state
      selector.querySelectorAll('.bot-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      // Re-render history with selected bot
      this.renderPnLHistoryForBot(this.selectedHistoryBot);
    });
  }

  /**
   * Initialize bot card click handlers for main view switching
   */
  initBotCardSelector() {
    const botsGrid = document.getElementById('bots-grid');
    if (!botsGrid) return;

    botsGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.bot-card');
      if (!card) return;

      const botId = card.dataset.botId;
      if (!botId) return;

      this.selectedViewBot = botId;

      // Update active state on all bot cards
      botsGrid.querySelectorAll('.bot-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      // Re-render dashboard with selected bot's data
      if (this.lastData) {
        this.updateDashboardForBot(this.selectedViewBot);
      }
    });
  }

  /**
   * Initialize header bot switch interactions
   */
  initBotSwitch() {
    const switchEl = document.getElementById('bot-switch');
    if (!switchEl) return;

    switchEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-bot]');
      if (!btn) return;

      const botId = btn.dataset.bot;
      if (!botId || botId === this.selectedViewBot) return;

      this.selectedViewBot = botId;
      this.updateBotSwitchActive(botId);
      this.updateSelectedBotIndicator(botId);

      if (this.lastData) {
        this.updateDashboardForBot(botId);
      }
    });
  }

  /**
   * Initialize period selector click handlers
   */
  initPeriodSelector() {
    const selector = document.getElementById('period-selector');
    if (!selector) return;

    selector.addEventListener('click', (e) => {
      const btn = e.target.closest('.period-btn');
      if (!btn) return;

      const period = btn.dataset.period;
      this.selectedPeriod = period;

      // Update active state
      selector.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Re-calculate period stats
      this.updatePeriodStats();
    });
  }

  /**
   * Calculate and update period stats based on selected period
   */
  updatePeriodStats() {
    const F = window.Formatters;

    // Get history for current view bot
    let history = [];
    if (this.selectedViewBot === 'main') {
      const mainHistory = this.allBotsHistory.find(b => b.botId === 'main');
      if (mainHistory) history = mainHistory.history || [];
    } else {
      const botHistory = this.allBotsHistory.find(b => b.botId === this.selectedViewBot);
      if (botHistory) history = botHistory.history || [];
    }

    // Filter history by time period
    const now = Date.now();
    const filteredHistory = this.filterHistoryByPeriod(history, this.selectedPeriod, now);

    // Calculate stats
    const totalPnl = filteredHistory.reduce((sum, h) => sum + (h.totalPnl || 0), 0);
    const totalTrades = filteredHistory.length;

    // Calculate percentage based on invested amount
    const totalInvested = filteredHistory.reduce((sum, h) => sum + (h.totalInvested || h.invested || 0), 0);
    const pnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    // Update UI
    const pnlEl = document.getElementById('period-pnl');
    const pnlPercentEl = document.getElementById('period-pnl-percent');
    const tradesEl = document.getElementById('period-trades');

    if (pnlEl) {
      pnlEl.textContent = F.currencyWithSign(totalPnl);
      pnlEl.className = `period-pnl ${F.pnlClass(totalPnl)}`;
    }
    if (pnlPercentEl) {
      pnlPercentEl.textContent = `(${F.percentWithSign(pnlPercent)})`;
      pnlPercentEl.className = `period-pnl-percent ${F.pnlClass(pnlPercent)}`;
    }
    if (tradesEl) {
      tradesEl.textContent = `${totalTrades} trades`;
    }
  }

  /**
   * Initialize history filter click handlers
   */
  initHistoryFilter() {
    const filters = document.getElementById('history-filters');
    if (!filters) return;

    filters.addEventListener('click', (e) => {
      const pill = e.target.closest('.filter-pill');
      if (!pill) return;

      const filter = pill.dataset.filter;
      this.selectedHistoryFilter = filter;

      // Update active state
      filters.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      // Re-render history with filter
      this.renderPnLHistoryForBot(this.selectedHistoryBot);
    });
  }

  /**
   * Initialize settings menu
   */
  initSettingsMenu() {
    const settingsBtn = document.getElementById('settings-btn');
    const dropdown = document.getElementById('settings-dropdown');
    const resetMainBtn = document.getElementById('reset-main-btn');
    const resetExternalBtn = document.getElementById('reset-external-btn');
    const resetAllBtn = document.getElementById('reset-all-btn');

    if (!settingsBtn || !dropdown) return;

    // Toggle dropdown
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      dropdown.classList.remove('open');
    });

    // Reset handlers
    if (resetMainBtn) {
      resetMainBtn.addEventListener('click', () => {
        this.scheduleReset('main');
        dropdown.classList.remove('open');
      });
    }

    if (resetExternalBtn) {
      resetExternalBtn.addEventListener('click', () => {
        this.scheduleReset('external');
        dropdown.classList.remove('open');
      });
    }

    if (resetAllBtn) {
      resetAllBtn.addEventListener('click', () => {
        this.scheduleReset('all');
        dropdown.classList.remove('open');
      });
    }
  }

  /**
   * Schedule a stats reset for the next market
   */
  scheduleReset(target) {
    // Send reset request to server
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'schedule_reset',
        target: target, // 'main', 'external', or 'all'
      }));
    }

    // Track pending reset locally
    this.pendingResets.add(target);
    this.updateResetStatus();
  }

  /**
   * Update reset status indicator
   */
  updateResetStatus() {
    const statusEl = document.getElementById('reset-status');
    if (!statusEl) return;

    if (this.pendingResets.size === 0) {
      statusEl.classList.remove('visible');
      statusEl.textContent = '';
      return;
    }

    statusEl.classList.add('visible');

    if (this.pendingResets.has('all')) {
      statusEl.textContent = 'Reset scheduled (all)';
    } else if (this.pendingResets.has('main') && this.pendingResets.has('external')) {
      statusEl.textContent = 'Reset scheduled (all)';
    } else if (this.pendingResets.has('main')) {
      statusEl.textContent = 'Reset scheduled (main)';
    } else if (this.pendingResets.has('external')) {
      statusEl.textContent = 'Reset scheduled (external)';
    }
  }

  /**
   * Clear pending reset (called when reset is confirmed)
   */
  clearPendingReset(target) {
    if (target === 'all') {
      this.pendingResets.clear();
    } else {
      this.pendingResets.delete(target);
    }
    this.updateResetStatus();
  }

  /**
   * Filter history entries by time period
   */
  filterHistoryByPeriod(history, period, now) {
    if (period === 'all') {
      return history;
    }

    let cutoffTime;
    switch (period) {
      case '1d':
        cutoffTime = now - (24 * 60 * 60 * 1000);
        break;
      case '1w':
        cutoffTime = now - (7 * 24 * 60 * 60 * 1000);
        break;
      case '1m':
        cutoffTime = now - (30 * 24 * 60 * 60 * 1000);
        break;
      default:
        return history;
    }

    return history.filter(h => h.timestamp >= cutoffTime);
  }

  /**
   * Connect to WebSocket server
   */
  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[Dashboard] Connected to server');
      this.reconnectAttempts = 0;
      this.updateConnectionStatus(true);
    };

    this.ws.onclose = () => {
      console.log('[Dashboard] Disconnected from server');
      this.updateConnectionStatus(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[Dashboard] WebSocket error:', err);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (e) {
        console.error('[Dashboard] Failed to parse message:', e);
      }
    };
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Dashboard] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * this.reconnectAttempts, 10000);

    console.log(`[Dashboard] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(this.connect, delay);
  }

  /**
   * Update connection status UI
   */
  updateConnectionStatus(connected) {
    const el = document.getElementById('connection');
    const statusText = el.querySelector('.status-text');

    if (connected) {
      el.className = 'connection connected';
      statusText.textContent = 'Connected';
    } else {
      el.className = 'connection disconnected';
      statusText.textContent = 'Disconnected';
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  handleMessage(msg) {
    switch (msg.type) {
      case 'dashboard_update':
        this.lastData = msg.data;
        this.updateDashboard(msg.data);
        this.updateLastUpdateTime(msg.timestamp);
        break;
      case 'trade':
        this.showTradeNotification(msg.data);
        break;
      case 'pong':
        // Keepalive response, ignore
        break;
      case 'reset_status':
        // Sync pending resets from server
        this.pendingResets = new Set(msg.pending || []);
        this.updateResetStatus();
        break;
    }
  }

  /**
   * Update the entire dashboard
   */
  updateDashboard(data) {
    // Store bots data for later use
    this.allBots = data.bots || [];
    this.allBotsHistory = data.allBotsHistory || [];
    this.externalBotsMarkets = data.externalBotsMarkets || [];

    // Update mode (always show)
    this.updateMode(data.mode);

    // Render bots selector
    this.renderBots(this.allBots);

    // Update dashboard based on selected bot (this also updates quick stats)
    this.updateDashboardForBot(this.selectedViewBot);

    // Update history bot selector and render history
    this.updateHistoryBotSelector(this.allBotsHistory);
    this.renderPnLHistoryForBot(this.selectedHistoryBot);

    // Update period stats
    this.updatePeriodStats();
  }

  /**
   * Calculate quick stats from history array
   */
  calculateQuickStatsFromHistory(history) {
    if (!history || history.length === 0) {
      return {
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
      };
    }

    const wins = history.filter(h => h.totalPnl > 0);
    const losses = history.filter(h => h.totalPnl < 0);

    const winRate = (wins.length / history.length) * 100;

    const totalWinAmount = wins.reduce((sum, h) => sum + h.totalPnl, 0);
    const totalLossAmount = Math.abs(losses.reduce((sum, h) => sum + h.totalPnl, 0));

    const avgWin = wins.length > 0 ? totalWinAmount / wins.length : 0;
    const avgLoss = losses.length > 0 ? totalLossAmount / losses.length : 0;

    // Profit factor = total wins / total losses (avoid division by zero)
    const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? Infinity : 0;

    return {
      winRate,
      avgWin,
      avgLoss,
      profitFactor: isFinite(profitFactor) ? profitFactor : 99.99, // Cap display at 99.99
    };
  }

  /**
   * Update quick stats bar
   */
  updateQuickStats(stats) {
    const F = window.Formatters;

    // Win Rate
    const winRateEl = document.getElementById('qs-winrate');
    if (winRateEl) {
      winRateEl.textContent = `${stats.winRate.toFixed(1)}%`;
      winRateEl.className = `qs-value ${stats.winRate >= 50 ? 'good' : 'bad'}`;
    }

    // Avg Win
    const avgWinEl = document.getElementById('qs-avgwin');
    if (avgWinEl) {
      avgWinEl.textContent = F.currency(stats.avgWin);
      avgWinEl.className = 'qs-value positive';
    }

    // Avg Loss
    const avgLossEl = document.getElementById('qs-avgloss');
    if (avgLossEl) {
      avgLossEl.textContent = F.currency(stats.avgLoss);
      avgLossEl.className = 'qs-value negative';
    }

    // Profit Factor
    const pfEl = document.getElementById('qs-pf');
    if (pfEl) {
      pfEl.textContent = stats.profitFactor.toFixed(2);
      pfEl.className = `qs-value ${stats.profitFactor >= 1 ? 'good' : 'bad'}`;
    }
  }

  /**
   * Update dashboard view for a specific bot
   */
  updateDashboardForBot(botId) {
    const data = this.lastData;
    if (!data) return;

    // Find the selected bot
    const selectedBot = this.allBots.find(b => b.botId === botId);

    if (botId === 'main' || !selectedBot) {
      // Main bot - use original data
      this.updatePortfolio(data.portfolio);
      this.updateMarketTypeSummary(data.portfolio);
      this.renderMarkets('current-markets', data.currentMarkets);
      this.renderMarkets('upcoming-markets', data.upcomingMarkets);
      this.updateSelectedBotIndicator('main');
      
      // Update quick stats with main bot's stats from server
      if (data.quickStats) {
        this.updateQuickStats(data.quickStats);
      }
    } else {
      // External bot - show its data with full details
      const currentMarkets = this.getExternalBotMarkets(botId);
      const upcomingMarkets = this.getExternalBotUpcomingMarkets(botId);

      // Calculate invested/value from market data if available
      let totalInvested = 0;
      let totalValue = 0;
      for (const m of currentMarkets) {
        totalInvested += (m.investedUp || 0) + (m.investedDown || 0);
        totalValue += (m.currentValueUp || 0) + (m.currentValueDown || 0);
      }
      for (const m of upcomingMarkets) {
        totalInvested += (m.investedUp || 0) + (m.investedDown || 0);
        totalValue += (m.currentValueUp || 0) + (m.currentValueDown || 0);
      }

      const externalPortfolio = {
        balance: selectedBot.balance,
        totalInvested: totalInvested,
        totalValue: totalValue,
        totalPnL: selectedBot.totalPnL,
        totalPnLPercent: selectedBot.totalPnLPercent,
        totalTrades: selectedBot.totalTrades,
        pnl15m: selectedBot.pnl15m || 0,
        pnl15mPercent: selectedBot.pnl15mPercent || 0,
        trades15m: selectedBot.trades15m || 0,
        pnl1h: selectedBot.pnl1h || 0,
        pnl1hPercent: selectedBot.pnl1hPercent || 0,
        trades1h: selectedBot.trades1h || 0,
      };

      this.updatePortfolio(externalPortfolio);
      this.updateMarketTypeSummary(externalPortfolio);

      // Render current markets (with full detail if available)
      if (currentMarkets.length > 0) {
        this.renderMarkets('current-markets', currentMarkets);
      } else {
        this.renderMarketsUnavailable('current-markets', selectedBot.botName);
      }

      // Render upcoming markets (with full detail if available)
      if (upcomingMarkets.length > 0) {
        this.renderMarkets('upcoming-markets', upcomingMarkets);
      } else {
        this.renderMarketsUnavailable('upcoming-markets', selectedBot.botName);
      }

      this.updateSelectedBotIndicator(botId);
      
      // Calculate and update quick stats from this bot's history
      const botHistory = this.allBotsHistory.find(b => b.botId === botId);
      if (botHistory && botHistory.history) {
        const quickStats = this.calculateQuickStatsFromHistory(botHistory.history);
        this.updateQuickStats(quickStats);
      } else {
        // No history available, show zeros
        this.updateQuickStats({
          winRate: 0,
          avgWin: 0,
          avgLoss: 0,
          profitFactor: 0,
        });
      }
    }
  }

  /**
   * Get external bot's current market data if available
   */
  getExternalBotMarkets(botId) {
    const botMarkets = this.externalBotsMarkets.find(b => b.botId === botId);
    if (!botMarkets || !botMarkets.markets || botMarkets.markets.length === 0) {
      return [];
    }

    // Pass through full market data (now matches MarketData structure)
    return botMarkets.markets.map(m => ({
      marketKey: m.marketKey || m.marketName,
      marketName: m.marketName,
      category: m.category || '',
      endDate: m.endDate || null,
      timeRemaining: m.timeRemaining || '--',
      isExpired: m.isExpired || false,
      priceUp: m.priceUp || 0,
      priceDown: m.priceDown || 0,
      sharesUp: m.sharesUp || 0,
      sharesDown: m.sharesDown || 0,
      investedUp: m.investedUp || 0,
      investedDown: m.investedDown || 0,
      totalCostUp: m.totalCostUp || 0,
      totalCostDown: m.totalCostDown || 0,
      currentValueUp: m.currentValueUp || 0,
      currentValueDown: m.currentValueDown || 0,
      pnlUp: m.pnlUp || 0,
      pnlDown: m.pnlDown || 0,
      pnlUpPercent: m.pnlUpPercent || 0,
      pnlDownPercent: m.pnlDownPercent || 0,
      totalPnL: m.totalPnL || 0,
      totalPnLPercent: m.totalPnLPercent || 0,
      tradesUp: m.tradesUp || 0,
      tradesDown: m.tradesDown || 0,
      upPercent: m.upPercent || 50,
      downPercent: m.downPercent || 50,
    }));
  }

  /**
   * Get external bot's upcoming market data if available
   */
  getExternalBotUpcomingMarkets(botId) {
    const botMarkets = this.externalBotsMarkets.find(b => b.botId === botId);
    if (!botMarkets || !botMarkets.upcomingMarkets || botMarkets.upcomingMarkets.length === 0) {
      return [];
    }

    return botMarkets.upcomingMarkets.map(m => ({
      marketKey: m.marketKey || m.marketName,
      marketName: m.marketName,
      category: m.category || '',
      endDate: m.endDate || null,
      timeRemaining: m.timeRemaining || '--',
      isExpired: false,
      priceUp: m.priceUp || 0,
      priceDown: m.priceDown || 0,
      sharesUp: m.sharesUp || 0,
      sharesDown: m.sharesDown || 0,
      investedUp: m.investedUp || 0,
      investedDown: m.investedDown || 0,
      totalCostUp: m.totalCostUp || 0,
      totalCostDown: m.totalCostDown || 0,
      currentValueUp: 0,
      currentValueDown: 0,
      pnlUp: 0,
      pnlDown: 0,
      pnlUpPercent: 0,
      pnlDownPercent: 0,
      totalPnL: m.totalPnL || 0,
      totalPnLPercent: m.totalPnLPercent || 0,
      tradesUp: m.tradesUp || 0,
      tradesDown: m.tradesDown || 0,
      upPercent: 50,
      downPercent: 50,
    }));
  }

  /**
   * Render message when markets aren't available for external bot
   * Shows a detailed card with recent history in a similar format to active markets
   */
  renderMarketsUnavailable(containerId, botName) {
    const container = document.getElementById(containerId);
    const F = window.Formatters;

    // Show the bot's PnL history as "completed market cards" if available
    const botHistory = this.allBotsHistory.find(b => b.botName.includes(botName.replace(' (Main)', '')));
    if (botHistory && botHistory.history && botHistory.history.length > 0) {
      // Show recent history as detailed market cards matching main bot style
      const recentHistory = botHistory.history.slice(0, 4);
      container.innerHTML = recentHistory.map(entry => {
        const outcome = entry.outcome || (entry.priceUp > entry.priceDown ? 'UP' : 'DOWN');
        const totalShares = (entry.sharesUp || 0) + (entry.sharesDown || 0);
        const upPercent = totalShares > 0 ? ((entry.sharesUp || 0) / totalShares) * 100 : 50;
        const downPercent = totalShares > 0 ? ((entry.sharesDown || 0) / totalShares) * 100 : 50;

        return `
          <div class="market-card completed" data-key="${entry.conditionId || entry.marketName}">
            <div class="market-header">
              <span class="market-name">${F.shortenMarketName(entry.marketName, 45)}</span>
              <span class="market-time completed">
                <span class="outcome-badge ${outcome.toLowerCase()}">${outcome}</span>
              </span>
            </div>

            <div class="prices-row">
              <div class="price-box up ${outcome === 'UP' ? 'winner' : ''}">
                <div class="price-label">UP Final</div>
                <div class="price-value">${F.price(entry.priceUp || 0)}</div>
              </div>
              <div class="price-box down ${outcome === 'DOWN' ? 'winner' : ''}">
                <div class="price-label">DOWN Final</div>
                <div class="price-value">${F.price(entry.priceDown || 0)}</div>
              </div>
            </div>

            ${totalShares > 0 ? `
              <div class="position-row">
                <div class="position-box">
                  <div class="position-label">UP Position</div>
                  <div class="position-shares">${F.shares(entry.sharesUp || 0)} shares</div>
                </div>
                <div class="position-box">
                  <div class="position-label">DOWN Position</div>
                  <div class="position-shares">${F.shares(entry.sharesDown || 0)} shares</div>
                </div>
              </div>

            ` : ''}

            <div class="market-summary">
              <span class="summary-time">${new Date(entry.timestamp).toLocaleString()}</span>
              <span class="summary-pnl ${F.pnlClass(entry.totalPnl)}">${F.currencyWithSign(entry.totalPnl)} (${F.percentWithSign(entry.pnlPercent)})</span>
            </div>
          </div>
        `;
      }).join('');
    } else {
      container.innerHTML = `
        <div class="market-card empty">
          <p>No market data for ${botName}</p>
          <p class="hint">External bot should send currentMarkets data for live view</p>
          <p class="hint">Check History tab for completed markets</p>
        </div>
      `;
    }
  }

  /**
   * Update visual indicator for selected bot
   */
  updateSelectedBotIndicator(botId) {
    const botsGrid = document.getElementById('bots-grid');
    if (!botsGrid) return;

    botsGrid.querySelectorAll('.bot-card').forEach(card => {
      if (card.dataset.botId === botId) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });
  }

  /**
   * Render header bot switch buttons
   */
  renderHeaderBotSwitch(bots) {
    const switchEl = document.getElementById('bot-switch');
    if (!switchEl) return;

    if (!bots || bots.length <= 1) {
      switchEl.style.display = bots && bots.length ? 'inline-flex' : 'none';
      switchEl.innerHTML = bots && bots.length ? `
        <button data-bot="${bots[0].botId}" class="active">${bots[0].botName.replace(/\s*\(.*\)$/i, '')}</button>
      ` : '';
      return;
    }

    switchEl.style.display = 'inline-flex';

    const html = bots.map(bot => {
      const label = bot.botName.replace(/\s*\(.*\)$/i, '');
      return `
        <button data-bot="${bot.botId}" class="${bot.botId === this.selectedViewBot ? 'active' : ''}">
          ${label}
        </button>
      `;
    }).join('');

    switchEl.innerHTML = html;
    this.updateBotSwitchActive(this.selectedViewBot);
  }

  /**
   * Update header bot switch active state
   */
  updateBotSwitchActive(botId) {
    const switchEl = document.getElementById('bot-switch');
    if (!switchEl) return;

    switchEl.querySelectorAll('button[data-bot]').forEach(btn => {
      if (btn.dataset.bot === botId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  /**
   * Update history bot selector pills based on available bots
   */
  updateHistoryBotSelector(allBotsHistory) {
    const selector = document.getElementById('history-bot-selector');
    if (!selector) return;

    // Build pills: one per bot
    let html = '';

    for (const botHistory of allBotsHistory) {
      const isActive = this.selectedHistoryBot === botHistory.botId ? 'active' : '';
      const shortName = botHistory.botName.replace(' (Main)', '').replace('BETABOT', 'BETABOT');
      html += `<button class="bot-pill ${isActive}" data-bot="${botHistory.botId}">${shortName}</button>`;
    }

    selector.innerHTML = html;
  }

  /**
   * Render PnL history for selected bot
   */
  renderPnLHistoryForBot(botId) {
    let history = [];

    // Find specific bot's history
    const botHistory = this.allBotsHistory.find(b => b.botId === botId);
    if (botHistory) {
      history = botHistory.history;
    }

    // Apply market type filter
    if (this.selectedHistoryFilter !== 'all') {
      history = this.filterHistoryByMarketType(history, this.selectedHistoryFilter);
    }

    this.renderPnLHistory(history);
  }

  /**
   * Filter history by market type (15m or 1h)
   */
  filterHistoryByMarketType(history, marketType) {
    return history.filter(entry => {
      const name = entry.marketName.toLowerCase();
      if (marketType === '15m') {
        return name.includes('15m') || name.includes('15-min') || name.includes('15 min');
      } else if (marketType === '1h') {
        return name.includes('1h') || name.includes('1-hour') || name.includes('1 hour') || name.includes('hourly');
      }
      return true;
    });
  }

  /**
   * Update mode indicator
   */
  updateMode(mode) {
    const el = document.getElementById('mode');
    el.textContent = `${mode} MODE`;

    // Update color based on mode
    if (mode === 'PAPER') {
      el.style.background = '#a371f7';
    } else if (mode === 'WATCH') {
      el.style.background = '#58a6ff';
    } else {
      el.style.background = '#3fb950';
    }
  }

  /**
   * Apply flash animation to element if value changed
   */
  applyValueAnimation(elementId, newValue, key) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const prevValue = this.previousValues[key];
    if (prevValue !== undefined && prevValue !== newValue) {
      // Remove existing animation class
      el.classList.remove('value-flash-positive', 'value-flash-negative');
      // Force reflow
      void el.offsetWidth;
      // Add appropriate animation class
      if (newValue > prevValue) {
        el.classList.add('value-flash-positive');
      } else if (newValue < prevValue) {
        el.classList.add('value-flash-negative');
      }
    }
    this.previousValues[key] = newValue;
  }


  /**
   * Update portfolio summary
   */
  updatePortfolio(portfolio) {
    const F = window.Formatters;

    // Wallet Total = Balance + Current Value of positions (visual only)
    const walletTotal = portfolio.balance + portfolio.totalValue;
    const walletTotalEl = document.getElementById('wallet-total');
    if (walletTotalEl) {
      this.applyValueAnimation('wallet-total', walletTotal, 'walletTotal');
      walletTotalEl.textContent = F.currency(walletTotal);
      // Color based on whether above or below starting balance
      const startingBalance = portfolio.startingBalance || 10000;
      if (walletTotal > startingBalance) {
        walletTotalEl.className = 'value positive';
      } else if (walletTotal < startingBalance) {
        walletTotalEl.className = 'value negative';
      } else {
        walletTotalEl.className = 'value';
      }
    }

    document.getElementById('balance').textContent = F.currency(portfolio.balance);
    document.getElementById('invested').textContent = F.currency(portfolio.totalInvested);
    document.getElementById('value').textContent = F.currency(portfolio.totalValue);

    const pnlEl = document.getElementById('total-pnl');
    this.applyValueAnimation('total-pnl', portfolio.totalPnL, 'totalPnL');
    pnlEl.textContent = F.currencyWithSign(portfolio.totalPnL);
    pnlEl.className = `value pnl ${F.pnlClass(portfolio.totalPnL)}`;

    const pctEl = document.getElementById('pnl-percent');
    pctEl.textContent = F.percentWithSign(portfolio.totalPnLPercent);
    pctEl.className = `value pnl ${F.pnlClass(portfolio.totalPnLPercent)}`;

    document.getElementById('total-trades').textContent = portfolio.totalTrades;

    // Header quick metrics
    const headerBalance = document.getElementById('header-balance');
    if (headerBalance) headerBalance.textContent = F.currency(portfolio.balance);
    const headerPnl = document.getElementById('header-pnl');
    if (headerPnl) headerPnl.textContent = `${F.currencyWithSign(portfolio.totalPnL)} (${F.percentWithSign(portfolio.totalPnLPercent)})`;
  }

  /**
   * Update market type summary (15m vs 1h)
   */
  updateMarketTypeSummary(portfolio) {
    const F = window.Formatters;

    // 15-minute markets
    const pnl15mEl = document.getElementById('pnl-15m');
    pnl15mEl.textContent = `${F.currencyWithSign(portfolio.pnl15m)} (${F.percentWithSign(portfolio.pnl15mPercent)})`;
    pnl15mEl.className = `type-pnl ${F.pnlClass(portfolio.pnl15m)}`;
    document.getElementById('trades-15m').textContent = `${portfolio.trades15m} trades`;

    // 1-hour markets
    const pnl1hEl = document.getElementById('pnl-1h');
    pnl1hEl.textContent = `${F.currencyWithSign(portfolio.pnl1h)} (${F.percentWithSign(portfolio.pnl1hPercent)})`;
    pnl1hEl.className = `type-pnl ${F.pnlClass(portfolio.pnl1h)}`;
    document.getElementById('trades-1h').textContent = `${portfolio.trades1h} trades`;
  }

  /**
   * Render market cards
   */
  renderMarkets(containerId, markets) {
    const container = document.getElementById(containerId);

    if (containerId === 'current-markets') {
      const headerMarketCount = document.getElementById('header-market-count');
      if (headerMarketCount) {
        headerMarketCount.textContent = markets && markets.length
          ? `${markets.length} Active`
          : '0 Active';
      }
    }

    if (!markets || markets.length === 0) {
      container.innerHTML = `
        <div class="market-card empty">
          <p>No markets available</p>
        </div>
      `;
      return;
    }

    container.innerHTML = markets.map(m => this.renderMarketCard(m)).join('');
  }

  /**
   * Get price arrow HTML based on price change
   */
  getPriceArrow(marketKey, side, currentPrice) {
    const prevPrices = this.previousPrices.get(marketKey);
    if (!prevPrices || currentPrice === null || currentPrice === undefined) {
      return '<span class="price-arrow no-change"></span>';
    }

    const prevPrice = side === 'up' ? prevPrices.priceUp : prevPrices.priceDown;
    if (prevPrice === null || prevPrice === undefined) {
      return '<span class="price-arrow no-change"></span>';
    }

    const diff = currentPrice - prevPrice;
    if (Math.abs(diff) < 0.0001) {
      return '<span class="price-arrow no-change"></span>';
    }

    if (diff > 0) {
      return '<span class="price-arrow trending-up">↑</span>';
    } else {
      return '<span class="price-arrow trending-down">↓</span>';
    }
  }

  /**
   * Store current prices for next comparison
   */
  storePrices(market) {
    this.previousPrices.set(market.marketKey, {
      priceUp: market.priceUp,
      priceDown: market.priceDown,
    });
  }

  /**
   * Determine CSS class for side outcome
   */
  getOutcomeClass(market, side) {
    if (!market || !market.leadingSide || market.leadingSide === 'UNKNOWN') {
      return '';
    }
    if (market.leadingSide === 'TIE') {
      return 'tie';
    }
    return market.leadingSide === side ? 'leading' : 'lagging';
  }

  /**
   * Determine status label for side outcome
   */
  getOutcomeLabel(market, side) {
    if (!market || !market.leadingSide || market.leadingSide === 'UNKNOWN') {
      return '';
    }
    if (market.leadingSide === 'TIE') {
      return 'Neck & Neck';
    }
    return market.leadingSide === side ? 'Winning' : 'Losing';
  }

  /**
   * Render winning badge for header
   */
  renderWinningBadge(market) {
    if (!market || !market.leadingSide || market.leadingSide === 'UNKNOWN') {
      return '';
    }

    if (market.leadingSide === 'TIE') {
      return '<span class="market-winning-badge tie">Neck &amp; neck</span>';
    }

    const cls = market.leadingSide === 'UP' ? 'up' : 'down';
    const label = market.leadingSide === 'UP' ? 'UP leading' : 'DOWN leading';
    const diffText =
      market.leadingConfidence && market.leadingConfidence >= 0.5
        ? ` · Δ${market.leadingConfidence.toFixed(1)} pts`
        : '';

    return `<span class="market-winning-badge ${cls}">${label}${diffText}</span>`;
  }

  /**
   * Render a single market card
   */
  renderMarketCard(market) {
    const F = window.Formatters;
    const totalInvested = market.investedUp + market.investedDown;
    const totalTrades = (market.tradesUp || 0) + (market.tradesDown || 0);
    const totalShares = market.sharesUp + market.sharesDown;
    const upPercent = totalShares > 0 ? (market.sharesUp / totalShares) * 100 : 50;
    const downPercent = totalShares > 0 ? (market.sharesDown / totalShares) * 100 : 50;

    // Get price arrows before storing new prices
    const upArrow = this.getPriceArrow(market.marketKey, 'up', market.priceUp);
    const downArrow = this.getPriceArrow(market.marketKey, 'down', market.priceDown);

    // Store current prices for next update
    this.storePrices(market);

    const winningBadge = this.renderWinningBadge(market);
    const upOutcomeClass = this.getOutcomeClass(market, 'UP');
    const downOutcomeClass = this.getOutcomeClass(market, 'DOWN');
    const upOutcomeLabel = this.getOutcomeLabel(market, 'UP');
    const downOutcomeLabel = this.getOutcomeLabel(market, 'DOWN');

    return `
      <div class="market-card" data-key="${market.marketKey}">
        <div class="market-header">
          <div class="market-name">${F.shortenMarketName(market.marketName, 45)}</div>
          <div class="market-meta">
            ${winningBadge}
            <span class="market-time ${market.isExpired ? 'expired' : ''}">${market.timeRemaining || '--'}</span>
          </div>
        </div>

        <div class="prices-row">
          <div class="price-box up ${upOutcomeClass}">
            <div class="price-label">UP Price</div>
            <div class="price-value">${F.price(market.priceUp)}${upArrow}</div>
            ${upOutcomeLabel ? `<div class="price-status ${upOutcomeClass}">${upOutcomeLabel}</div>` : ''}
          </div>
          <div class="price-box down ${downOutcomeClass}">
            <div class="price-label">DOWN Price</div>
            <div class="price-value">${F.price(market.priceDown)}${downArrow}</div>
            ${downOutcomeLabel ? `<div class="price-status ${downOutcomeClass}">${downOutcomeLabel}</div>` : ''}
          </div>
        </div>

        ${totalShares > 0 ? `
        <div class="market-shares-bar">
          <div class="market-shares-bar-up" style="width: ${upPercent}%"></div>
          <div class="market-shares-bar-down" style="width: ${downPercent}%"></div>
        </div>
        ` : ''}

        <div class="position-row">
          <div class="position-box ${upOutcomeClass}">
            <div class="position-label">UP Position</div>
            ${upOutcomeLabel ? `<div class="position-status ${upOutcomeClass}">${upOutcomeLabel}</div>` : ''}
            <div class="position-shares">${F.shares(market.sharesUp)} shares</div>
            <div class="position-invested">${F.currency(market.investedUp)} invested</div>
            <div class="position-trades">${market.tradesUp || 0} trades</div>
            <div class="position-pnl ${F.pnlClass(market.pnlUp)}">${F.currencyWithSign(market.pnlUp)}</div>
          </div>
          <div class="position-box ${downOutcomeClass}">
            <div class="position-label">DOWN Position</div>
            ${downOutcomeLabel ? `<div class="position-status ${downOutcomeClass}">${downOutcomeLabel}</div>` : ''}
            <div class="position-shares">${F.shares(market.sharesDown)} shares</div>
            <div class="position-invested">${F.currency(market.investedDown)} invested</div>
            <div class="position-trades">${market.tradesDown || 0} trades</div>
            <div class="position-pnl ${F.pnlClass(market.pnlDown)}">${F.currencyWithSign(market.pnlDown)}</div>
          </div>
        </div>

        <div class="market-summary">
          <span class="summary-invested">${F.currency(totalInvested)} invested</span>
          <span class="summary-pnl ${F.pnlClass(market.totalPnL)}">${F.currencyWithSign(market.totalPnL)} (${F.percentWithSign(market.totalPnLPercent)})</span>
          <span class="summary-trades">${totalTrades} total trades</span>
        </div>
      </div>
    `;
  }

  /**
   * Update last update timestamp
   */
  updateLastUpdateTime(timestamp) {
    const el = document.getElementById('last-update');
    el.textContent = `Last update: ${new Date(timestamp).toLocaleTimeString()}`;
  }

  /**
   * Show trade notification (for future use)
   */
  showTradeNotification(trade) {
    console.log('[Dashboard] Trade notification:', trade);
    // Could add a toast notification here
  }

  /**
   * Render PnL history list
   */
  renderPnLHistory(history) {
    const F = window.Formatters;
    const container = document.getElementById('pnl-history');
    const countEl = document.getElementById('history-count');
    const winrateEl = document.getElementById('history-winrate');
    const totalPnlEl = document.getElementById('history-total-pnl');

    // Calculate stats
    const totalMarkets = history.length;
    const wins = history.filter(h => h.totalPnl > 0).length;
    const winRate = totalMarkets > 0 ? (wins / totalMarkets) * 100 : 0;
    const totalPnl = history.reduce((sum, h) => sum + h.totalPnl, 0);

    // Update summary stats
    countEl.textContent = totalMarkets;
    winrateEl.textContent = `${winRate.toFixed(1)}%`;
    winrateEl.className = `stat-value ${winRate >= 50 ? 'positive' : 'negative'}`;
    totalPnlEl.textContent = F.currencyWithSign(totalPnl);
    totalPnlEl.className = `stat-value ${F.pnlClass(totalPnl)}`;

    // Render history list
    if (!history || history.length === 0) {
      container.innerHTML = `
        <div class="history-empty">
          <p>No completed markets yet</p>
        </div>
      `;
      return;
    }

    container.innerHTML = history.map(entry => this.renderHistoryItem(entry)).join('');
  }

  /**
   * Render a single history item
   */
  renderHistoryItem(entry) {
    const F = window.Formatters;
    const outcome = entry.outcome || (entry.priceUp > entry.priceDown ? 'UP' : 'DOWN');
    const time = new Date(entry.timestamp).toLocaleString();
    const totalShares = entry.sharesUp + entry.sharesDown;

    return `
      <div class="history-item">
        <div class="history-outcome ${outcome.toLowerCase()}">${outcome}</div>
        <div class="history-details">
          <div class="history-market">${F.shortenMarketName(entry.marketName, 40)}</div>
          <div class="history-meta">
            <span>${time}</span>
            <span>${F.shares(totalShares)} shares</span>
          </div>
        </div>
        <div class="history-pnl">
          <div class="history-pnl-value ${F.pnlClass(entry.totalPnl)}">${F.currencyWithSign(entry.totalPnl)}</div>
          <div class="history-pnl-percent">${F.percentWithSign(entry.pnlPercent)}</div>
        </div>
      </div>
    `;
  }

  /**
   * Render bots section and comparison view
   */
  renderBots(bots) {
    const F = window.Formatters;

    // Bots grid in header area (compact view)
    const botsSection = document.getElementById('bots-section');
    const botsGrid = document.getElementById('bots-grid');
    const botsCount = document.getElementById('bots-count');

    // Show bots section if more than 1 bot
    if (bots.length > 1) {
      botsSection.style.display = 'block';
      botsCount.textContent = `${bots.length} bots`;
      botsGrid.innerHTML = bots.map(bot => this.renderBotCard(bot)).join('');
    } else {
      botsSection.style.display = 'none';
    }

    // Header bot switch
    this.renderHeaderBotSwitch(bots);

    // Comparison view in tab - market-by-market comparison
    const comparisonTotals = document.getElementById('comparison-totals');
    const comparisonMarkets = document.getElementById('comparison-markets');
    const totalBotsEl = document.getElementById('total-bots');

    totalBotsEl.textContent = `${bots.length} bot${bots.length !== 1 ? 's' : ''}`;

    if (bots.length === 0) {
      if (comparisonTotals) comparisonTotals.innerHTML = '';
      if (comparisonMarkets) comparisonMarkets.innerHTML = `<div class="history-empty"><p>No bots connected</p></div>`;
      return;
    }

    // Render bot total summary cards
    if (comparisonTotals) {
      comparisonTotals.innerHTML = bots.map(bot => this.renderBotTotalCard(bot)).join('');
    }

    // Render market-by-market comparison
    if (comparisonMarkets) {
      this.renderMarketComparison(bots);
    }
  }

  /**
   * Render compact bot total card for comparison header
   */
  renderBotTotalCard(bot) {
    const F = window.Formatters;
    const isMain = bot.botId === 'main';

    return `
      <div class="bot-total-card ${isMain ? 'main' : 'external'}">
        <div class="bot-total-header">
          <span class="bot-total-name">${bot.botName}</span>
          <span class="bot-total-badge">${isMain ? 'PRIMARY' : 'EXTERNAL'}</span>
        </div>
        <div class="bot-total-pnl ${F.pnlClass(bot.totalPnL)}">
          ${F.currencyWithSign(bot.totalPnL)}
        </div>
        <div class="bot-total-stats">
          <span>${bot.totalTrades} trades</span>
          <span class="${bot.winRate >= 50 ? 'positive' : 'negative'}">${bot.winRate.toFixed(0)}% win</span>
        </div>
      </div>
    `;
  }

  /**
   * Render market-by-market comparison
   */
  renderMarketComparison(bots) {
    const F = window.Formatters;
    const container = document.getElementById('comparison-markets');

    // Build a map of markets with results from each bot
    const marketMap = new Map();

    for (const botHistory of this.allBotsHistory) {
      const bot = bots.find(b => b.botId === botHistory.botId);
      if (!bot) continue;

      for (const entry of botHistory.history || []) {
        // Normalize market name for matching (remove time variations)
        const marketKey = this.normalizeMarketName(entry.marketName);

        if (!marketMap.has(marketKey)) {
          marketMap.set(marketKey, {
            marketName: entry.marketName,
            outcome: entry.outcome || (entry.priceUp > entry.priceDown ? 'UP' : 'DOWN'),
            timestamp: entry.timestamp,
            priceUp: entry.priceUp,
            priceDown: entry.priceDown,
            botResults: {},
          });
        }

        const market = marketMap.get(marketKey);
        // Update timestamp to most recent
        if (entry.timestamp > market.timestamp) {
          market.timestamp = entry.timestamp;
        }

        market.botResults[botHistory.botId] = {
          botName: bot.botName,
          totalPnl: entry.totalPnl,
          pnlPercent: entry.pnlPercent,
          sharesUp: entry.sharesUp || 0,
          sharesDown: entry.sharesDown || 0,
        };
      }
    }

    // Convert to array and sort by timestamp (most recent first)
    const markets = Array.from(marketMap.values())
      .sort((a, b) => b.timestamp - a.timestamp);

    if (markets.length === 0) {
      container.innerHTML = `
        <div class="history-empty">
          <p>No completed markets to compare</p>
          <p class="hint">Markets will appear here once both bots have completed trades</p>
        </div>
      `;
      return;
    }

    // Render market comparison cards
    container.innerHTML = markets.map(market => this.renderMarketComparisonCard(market, bots)).join('');
  }

  /**
   * Normalize market name for comparison matching
   */
  normalizeMarketName(name) {
    // Remove specific time window info to match same market across bots
    // e.g., "BTC UpDown 15m 12:00-12:15" -> "BTC UpDown 15m"
    return name
      .replace(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}.*$/i, '')
      .replace(/\s+$/, '')
      .trim();
  }

  /**
   * Render a single market comparison card
   */
  renderMarketComparisonCard(market, bots) {
    const F = window.Formatters;
    const time = new Date(market.timestamp).toLocaleString();
    const outcome = market.outcome || 'UNKNOWN';

    // Calculate which bot won this market
    let bestPnl = -Infinity;
    let bestBot = null;
    for (const [botId, result] of Object.entries(market.botResults)) {
      if (result.totalPnl > bestPnl) {
        bestPnl = result.totalPnl;
        bestBot = botId;
      }
    }

    // Build bot results HTML
    const botResultsHtml = bots.map(bot => {
      const result = market.botResults[bot.botId];
      if (!result) {
        return `
          <div class="compare-bot-result no-data">
            <div class="compare-bot-name">${bot.botName}</div>
            <div class="compare-bot-pnl">--</div>
          </div>
        `;
      }

      const isWinner = bot.botId === bestBot && bestPnl > 0;
      const totalShares = result.sharesUp + result.sharesDown;

      return `
        <div class="compare-bot-result ${isWinner ? 'winner' : ''} ${F.pnlClass(result.totalPnl)}">
          <div class="compare-bot-name">${bot.botName}</div>
          <div class="compare-bot-pnl ${F.pnlClass(result.totalPnl)}">
            ${F.currencyWithSign(result.totalPnl)}
          </div>
          <div class="compare-bot-percent">${F.percentWithSign(result.pnlPercent)}</div>
          ${totalShares > 0 ? `<div class="compare-bot-shares">${F.shares(totalShares)} shares</div>` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="market-compare-card">
        <div class="market-compare-header">
          <div class="market-compare-outcome ${outcome.toLowerCase()}">${outcome}</div>
          <div class="market-compare-info">
            <div class="market-compare-name">${F.shortenMarketName(market.marketName, 50)}</div>
            <div class="market-compare-time">${time}</div>
          </div>
        </div>
        <div class="market-compare-results">
          ${botResultsHtml}
        </div>
      </div>
    `;
  }

  /**
   * Render compact bot card (header section)
   */
  renderBotCard(bot) {
    const F = window.Formatters;
    const isSelected = this.selectedViewBot === bot.botId;
    return `
      <div class="bot-card ${isSelected ? 'active' : ''}" data-bot-id="${bot.botId}">
        <div class="bot-name">${bot.botName}</div>
        <div class="bot-pnl ${F.pnlClass(bot.totalPnL)}">${F.currencyWithSign(bot.totalPnL)}</div>
        <div class="bot-stats">${bot.winRate.toFixed(1)}% win | ${bot.totalTrades} trades</div>
      </div>
    `;
  }

  /**
   * Request manual refresh
   */
  refresh() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'refresh' }));
    }
  }
}

/**
 * Tab switching functionality
 */
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = `tab-${tab.dataset.tab}`;

      // Update active tab
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Update active content
      tabContents.forEach(content => {
        if (content.id === targetId) {
          content.classList.add('active');
        } else {
          content.classList.remove('active');
        }
      });
    });
  });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  window.dashboardClient = new DashboardClient();
  initTabs();
});
