#!/bin/bash
# Multi-Bot Dashboard Runner
# Runs all bots in quiet mode and shows a unified dashboard

set -e

echo "🤖 BETABOT Multi-Bot Dashboard"
echo "=============================="
echo ""

# Build first
echo "📦 Building..."
npm run build > /dev/null 2>&1
echo "✅ Build complete"
echo ""

# Find all config files
CONFIG_FILES=$(ls inventory-rebalance-config*.yaml 2>/dev/null | sort)

if [ -z "$CONFIG_FILES" ]; then
  echo "❌ No config files found matching inventory-rebalance-config*.yaml"
  exit 1
fi

# Count configs
CONFIG_COUNT=$(echo "$CONFIG_FILES" | wc -l | tr -d ' ')
echo "📋 Found $CONFIG_COUNT config file(s)"
echo ""

# Create logs directory
mkdir -p logs/bots

# Array to store PIDs
PIDS=()
BOT_IDS=()

# Counter for sequential bot numbering
BOT_COUNTER=3

# Function to get bot ID
get_bot_id() {
  local filename=$(basename "$1" .yaml)
  if [ "$filename" = "inventory-rebalance-config" ]; then
    echo "main"
  else
    echo "$BOT_COUNTER"
  fi
}

# Start each bot in background with suppressed output
echo "🚀 Starting bots..."
echo ""

for config in $CONFIG_FILES; do
  BOT_ID=$(get_bot_id "$config")

  if [ "$BOT_ID" = "main" ]; then
    BOT_NAME="BETABOT"
    PORT=3010
  else
    BOT_NAME="Bot $BOT_ID"
    PORT=$((3010 + BOT_ID))
  fi

  # Start bot with output redirected to log file
  LOG_FILE="logs/bots/${BOT_ID}.log"

  BOT_ID="$BOT_ID" \
  BOT_NAME="$BOT_NAME" \
  CONFIG_FILE="$config" \
  QUIET_MODE=true \
  node dist/src/index.js > "$LOG_FILE" 2>&1 &

  PID=$!
  PIDS+=($PID)
  BOT_IDS+=($BOT_ID)

  echo "  ✅ $BOT_NAME (ID: $BOT_ID, Port: $PORT, PID: $PID)"

  # Increment counter for next non-main bot
  if [ "$BOT_ID" != "main" ]; then
    ((BOT_COUNTER++))
  fi

  # Small delay between starts
  sleep 1
done

echo ""
echo "=============================="
echo "✅ All ${#PIDS[@]} bot(s) started"
echo ""
echo "📊 Logs: logs/bots/<bot_id>.log"
echo "🌐 Dashboard: http://localhost:3010"
echo ""
echo "Press Ctrl+C to stop all bots"
echo "=============================="
echo ""

# Function to show dashboard
show_dashboard() {
  while true; do
    clear
    echo "╔══════════════════════════════════════════════════════════════════════════════╗"
    echo "║                        BETABOT MULTI-BOT DASHBOARD                           ║"
    echo "╠══════════════════════════════════════════════════════════════════════════════╣"
    printf "║ %-76s ║\n" "Time: $(date '+%Y-%m-%d %H:%M:%S')    Bots: ${#PIDS[@]}"
    echo "╠════════╦═══════════════╦══════════╦════════╦═══════════════════════════════════╣"
    echo "║   ID   ║     NAME      ║  STATUS  ║  PORT  ║            LAST LOG              ║"
    echo "╠════════╬═══════════════╬══════════╬════════╬═══════════════════════════════════╣"

    for i in "${!PIDS[@]}"; do
      PID=${PIDS[$i]}
      BOT_ID=${BOT_IDS[$i]}

      if [ "$BOT_ID" = "main" ]; then
        BOT_NAME="BETABOT"
        PORT=3010
      else
        BOT_NAME="Bot $BOT_ID"
        PORT=$((3010 + BOT_ID))
      fi

      # Check if process is running
      if kill -0 $PID 2>/dev/null; then
        STATUS="✅ RUN  "
      else
        STATUS="❌ DEAD "
      fi

      # Get last log line
      LOG_FILE="logs/bots/${BOT_ID}.log"
      if [ -f "$LOG_FILE" ]; then
        LAST_LOG=$(tail -1 "$LOG_FILE" 2>/dev/null | cut -c1-35 || echo "No log")
      else
        LAST_LOG="No log file"
      fi

      printf "║ %-6s ║ %-13s ║ %s ║ %-6s ║ %-33s ║\n" "$BOT_ID" "$BOT_NAME" "$STATUS" "$PORT" "$LAST_LOG"
    done

    echo "╠════════╩═══════════════╩══════════╩════════╩═══════════════════════════════════╣"
    echo "║  Press Ctrl+C to stop all bots                                                ║"
    echo "╚══════════════════════════════════════════════════════════════════════════════╝"

    sleep 2
  done
}

# Cleanup function
cleanup() {
  echo ""
  echo "🛑 Stopping all bots..."
  for PID in "${PIDS[@]}"; do
    kill $PID 2>/dev/null || true
  done
  echo "✅ All bots stopped"
  exit 0
}

# Set trap for cleanup
trap cleanup SIGINT SIGTERM

# Show dashboard
show_dashboard
