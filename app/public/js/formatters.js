/**
 * Formatting utilities for BETABOT Dashboard
 */

const Formatters = {
  /**
   * Format a number as currency
   */
  currency(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return '$0.00';
    const sign = value >= 0 ? '' : '-';
    const absValue = Math.abs(value);
    return `${sign}$${absValue.toFixed(decimals)}`;
  },

  /**
   * Format a number as currency with sign
   */
  currencyWithSign(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return '$0.00';
    const sign = value >= 0 ? '+' : '';
    return `${sign}$${value.toFixed(decimals)}`;
  },

  /**
   * Format a percentage
   */
  percent(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return '0.00%';
    return `${value.toFixed(decimals)}%`;
  },

  /**
   * Format a percentage with sign
   */
  percentWithSign(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return '0.00%';
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(decimals)}%`;
  },

  /**
   * Format a price (0-1 range)
   */
  price(value, decimals = 4) {
    if (value === null || value === undefined || isNaN(value)) return '--';
    return `$${value.toFixed(decimals)}`;
  },

  /**
   * Format shares/quantity
   */
  shares(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return '0';
    return value.toFixed(decimals);
  },

  /**
   * Format a number with commas
   */
  number(value, decimals = 0) {
    if (value === null || value === undefined || isNaN(value)) return '0';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  },

  /**
   * Get PnL class based on value
   */
  pnlClass(value) {
    if (value === null || value === undefined || isNaN(value) || value === 0) {
      return 'neutral';
    }
    return value > 0 ? 'positive' : 'negative';
  },

  /**
   * Format time remaining string
   */
  timeRemaining(ms) {
    if (!ms || ms <= 0) return 'Expired';
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  },

  /**
   * Format timestamp to locale time
   */
  time(timestamp) {
    if (!timestamp) return '--';
    return new Date(timestamp).toLocaleTimeString();
  },

  /**
   * Shorten market name for mobile
   */
  shortenMarketName(name, maxLength = 50) {
    if (!name) return '';
    if (name.length <= maxLength) return name;
    return name.substring(0, maxLength - 3) + '...';
  },
};

// Make available globally
window.Formatters = Formatters;
