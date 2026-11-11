#!/usr/bin/env sh
# Adds "Agent Chat" to your application menu by writing ~/.local/share/applications/agent-chat.desktop.
# Run it once, by hand. Remove the app from the menu by deleting that one file.
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
target="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$target"
cat > "$target/agent-chat.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Agent Chat
Comment=Chat with your agents
Exec=$here/scripts/run.sh
Icon=$here/resources/icon.png
Terminal=false
Categories=Utility;Network;
StartupWMClass=Agent Chat
DESKTOP
echo "Wrote $target/agent-chat.desktop"
