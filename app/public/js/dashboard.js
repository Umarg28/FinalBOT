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

    // Bind methods
    this.connect = this.connect.bind(this);
    this.handleMessage = this.handleMessage.bind(this);

    // Start connection
    this.connect();

    // Ping interval for keepalive
    setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
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
    }
  }

  /**
   * Update the entire dashboard
   */
  updateDashboard(data) {
    this.updateMode(data.mode);
    this.updatePortfolio(data.portfolio);
    this.updateMarketTypeSummary(data.portfolio);
    this.renderMarkets('current-markets', data.currentMarkets);
    this.renderMarkets('upcoming-markets', data.upcomingMarkets);
    this.renderPnLHistory(data.pnlHistory || []);
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
   * Update portfolio summary
   */
  updatePortfolio(portfolio) {
    const F = window.Formatters;

    document.getElementById('balance').textContent = F.currency(portfolio.balance);
    document.getElementById('invested').textContent = F.currency(portfolio.totalInvested);
    document.getElementById('value').textContent = F.currency(portfolio.totalValue);

    const pnlEl = document.getElementById('total-pnl');
    pnlEl.textContent = F.currencyWithSign(portfolio.totalPnL);
    pnlEl.className = `value pnl ${F.pnlClass(portfolio.totalPnL)}`;

    const pctEl = document.getElementById('pnl-percent');
    pctEl.textContent = F.percentWithSign(portfolio.totalPnLPercent);
    pctEl.className = `value pnl ${F.pnlClass(portfolio.totalPnLPercent)}`;

    document.getElementById('total-trades').textContent = portfolio.totalTrades;
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
   * Render a single market card
   */
  renderMarketCard(market) {
    const F = window.Formatters;
    const totalInvested = market.investedUp + market.investedDown;
    const totalTrades = market.tradesUp + market.tradesDown;

    return `
      <div class="market-card" data-key="${market.marketKey}">
        <div class="market-header">
          <span class="market-name">${F.shortenMarketName(market.marketName, 45)}</span>
          <span class="market-time ${market.isExpired ? 'expired' : ''}">${market.timeRemaining || '--'}</span>
        </div>

        <div class="prices-row">
          <div class="price-box up">
            <div class="price-label">UP Price</div>
            <div class="price-value">${F.price(market.priceUp)}</div>
          </div>
          <div class="price-box down">
            <div class="price-label">DOWN Price</div>
            <div class="price-value">${F.price(market.priceDown)}</div>
          </div>
        </div>

        <div class="position-row">
          <div class="position-box">
            <div class="position-label">UP Position</div>
            <div class="position-shares">${F.shares(market.sharesUp)} shares</div>
            <div class="position-invested">${F.currency(market.investedUp)} invested</div>
            <div class="position-pnl ${F.pnlClass(market.pnlUp)}">${F.currencyWithSign(market.pnlUp)}</div>
          </div>
          <div class="position-box">
            <div class="position-label">DOWN Position</div>
            <div class="position-shares">${F.shares(market.sharesDown)} shares</div>
            <div class="position-invested">${F.currency(market.investedDown)} invested</div>
            <div class="position-pnl ${F.pnlClass(market.pnlDown)}">${F.currencyWithSign(market.pnlDown)}</div>
          </div>
        </div>

        <div class="distribution-bar">
          <div class="bar-up" style="width: ${market.upPercent || 50}%"></div>
          <div class="bar-down" style="width: ${market.downPercent || 50}%"></div>
        </div>

        <div class="market-summary">
          <span class="summary-invested">${F.currency(totalInvested)} invested</span>
          <span class="summary-pnl ${F.pnlClass(market.totalPnL)}">${F.currencyWithSign(market.totalPnL)} (${F.percentWithSign(market.totalPnLPercent)})</span>
          <span class="summary-trades">${totalTrades} trades</span>
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
