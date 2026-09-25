#!/usr/bin/env bash
set -euo pipefail

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
APP_HOME="$DATA_HOME/edge-natural-tts"
RUNTIME_DIR="$APP_HOME/runtime/linux-piper"
MANIFEST_PATH="$CONFIG_HOME/microsoft-edge/NativeMessagingHosts/com.sguzman.edge_tts.linux_piper.json"

rm -f -- "$MANIFEST_PATH"
rm -rf -- "$RUNTIME_DIR"

echo "Removed Linux Piper runtime and Native Messaging registration."
echo "Preserved voice models at: $APP_HOME/voices"
