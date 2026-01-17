#!/bin/bash
# Bot Monitor Dashboard
# Shows status of all running BETABOT instances in a clean terminal view
# Works with bots started any way (npm start, spawner, run-all-bots.sh, etc.)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color
BG_BLUE='\033[44m'
BG_GRAY='\033[100m'

# Terminal dimensions
get_width() {
  tput cols 2>/dev/null || echo 100
}

# Clear and position cursor
clear_screen() {
  printf '\033[2J\033[H'
}

# Draw a horizontal line
draw_line() {
  local char="${1:-─}"
  local width=$(get_width)
  printf '%*s\n' "$width" '' | tr ' ' "$char"
}

# Get all running bot info by scanning ports 3000-3099
# Outputs one line per bot in format: bot_id|bot_name|port|pid|config
get_bots() {
  for port in $(seq 3000 3050); do
    pid=$(lsof -i :$port -t 2>/dev/null | head -1)

    if [ -n "$pid" ]; then
      cmd=$(ps -p "$pid" -o command= 2>/dev/null)
      if echo "$cmd" | grep -q "node.*index"; then
        if [ "$port" -le 3010 ]; then
          bot_id="main"
          bot_name="BETABOT"
        else
          bot_id=$((port - 3010))
          bot_name="Bot $bot_id"
        fi

        if [ "$bot_id" = "main" ]; then
          config="inventory-rebalance-config.yaml"
        else
          config="inventory-rebalance-config-${bot_id}.yaml"
        fi

        echo "$bot_id|$bot_name|$port|$pid|$config"
      fi
    fi
  done
}

# Main dashboard loop
main() {
  local refresh_interval=2

  # Hide cursor
  printf '\033[?25l'

  # Trap to restore cursor on exit
  trap 'printf "\033[?25h"; echo ""; echo "Dashboard stopped."; exit 0' INT TERM

  while true; do
    clear_screen
    local width=$(get_width)
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    # Header
    printf "${BG_BLUE}${WHITE}"
    printf " BETABOT MULTI-BOT MONITOR"
    printf "%*s" $((width - 48)) ""
    printf " %s " "$timestamp"
    printf "${NC}\n"

    draw_line "="

    # Get bots into a temp file (POSIX compatible)
    local tmpfile="/tmp/betabot_monitor_$$"
    get_bots > "$tmpfile"
    local total_bots=$(wc -l < "$tmpfile" | tr -d ' ')

    # Summary line
    printf " ${WHITE}Total Bots:${NC} ${GREEN}%s${NC}" "$total_bots"
    printf "  |  ${WHITE}Refresh:${NC} %ss" "$refresh_interval"
    printf "  |  ${WHITE}Press Ctrl+C to exit${NC}\n"

    draw_line "-"

    # Table header
    printf "${BG_GRAY}${WHITE}"
    printf " %-8s | %-15s | %-8s | %-8s | %-8s | %-30s " "ID" "NAME" "STATUS" "PORT" "PID" "CONFIG"
    printf "${NC}\n"

    draw_line "-"

    if [ "$total_bots" -eq 0 ] 2>/dev/null || [ -z "$total_bots" ]; then
      printf "\n"
      printf " ${YELLOW}No bots running.${NC}\n"
      printf " Start a bot with: ${CYAN}npm start${NC}\n"
      printf " Or create from WEBAPP\n"
      printf "\n"
    else
      while IFS='|' read -r bot_id bot_name port pid config; do
        # Check if process is still alive
        if kill -0 "$pid" 2>/dev/null; then
          status="${GREEN}* RUN${NC}   "
        else
          status="${RED}x DEAD${NC}  "
        fi

        # Truncate config name if too long
        config_short=$(basename "$config" | cut -c1-28)

        printf " %-8s | %-15s | $status | %-8s | %-8s | %-30s\n" \
          "$bot_id" "${bot_name:0:15}" "$port" "$pid" "$config_short"
      done < "$tmpfile"
    fi

    # Cleanup temp file
    rm -f "$tmpfile"

    draw_line "-"

    # Footer with config files info
    printf " ${WHITE}Config files found:${NC}\n"
    for f in /Users/haq/BETABOT/inventory-rebalance-config*.yaml; do
      if [ -f "$f" ]; then
        fname=$(basename "$f")
        printf "   ${CYAN}%s${NC}\n" "$fname"
      fi
    done 2>/dev/null

    draw_line "-"

    # Commands hint
    printf "${BG_GRAY} Commands: ${WHITE}npm start${NC} (main) | ${WHITE}WEBAPP${NC} (create/delete bots) | ${WHITE}Ctrl+C${NC} (exit) ${NC}\n"

    sleep $refresh_interval
  done
}

# Run main
main
