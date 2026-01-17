#!/bin/bash
# Run all bots from different config files in parallel

echo "🤖 Starting all bots..."

# Find all config files
CONFIG_FILES=$(ls inventory-rebalance-config*.yaml 2>/dev/null)

if [ -z "$CONFIG_FILES" ]; then
  echo "❌ No config files found matching inventory-rebalance-config*.yaml"
  exit 1
fi

# Array to store PIDs
PIDS=()

# Counter for sequential bot numbering (starts at 3)
BOT_COUNTER=3

# Function to get bot ID (sequential: 3, 4, 5, 6...)
get_bot_id() {
  local filename=$(basename "$1" .yaml)
  if [ "$filename" = "inventory-rebalance-config" ]; then
    echo "main"
  else
    # Return sequential number starting from 3
    echo "$BOT_COUNTER"
  fi
}

# Function to get bot name from ID
get_bot_name() {
  local bot_id="$1"
  if [ "$bot_id" = "main" ]; then
    echo "BETABOT"
  else
    echo "Bot $bot_id"
  fi
}

# Start each bot
for config in $CONFIG_FILES; do
  BOT_ID=$(get_bot_id "$config")
  BOT_NAME=$(get_bot_name "$BOT_ID")

  echo "📦 Starting $BOT_NAME (ID: $BOT_ID) with config: $config"

  # Run bot in background
  BOT_ID="$BOT_ID" BOT_NAME="$BOT_NAME" CONFIG_FILE="$config" node dist/src/index.js &
  PIDS+=($!)

  # Increment counter for next non-main bot
  if [ "$BOT_ID" != "main" ]; then
    ((BOT_COUNTER++))
  fi

  # Small delay between starts to avoid port conflicts
  sleep 2
done

echo ""
echo "✅ Started ${#PIDS[@]} bot(s)"
echo "   PIDs: ${PIDS[*]}"
echo ""
echo "Press Ctrl+C to stop all bots"

# Wait for all processes and handle Ctrl+C
trap 'echo "🛑 Stopping all bots..."; kill ${PIDS[*]} 2>/dev/null; exit 0' SIGINT SIGTERM

# Wait for all background processes
wait
