#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./native/linux-piper/install-native-host.sh --extension-id <EDGE_EXTENSION_ID>

Installs an isolated, CPU-only Piper runtime for Edge Natural TTS.
No sudo. No system/user-site pip install. Voice models are not modified.
EOF
}

EXTENSION_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      EXTENSION_ID="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$EXTENSION_ID" ]]; then
  echo "Missing --extension-id." >&2
  usage >&2
  exit 2
fi

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "That does not look like a Chromium extension ID: $EXTENSION_ID" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_HOST="$SCRIPT_DIR/linux_piper_host.py"
[[ -f "$SOURCE_HOST" ]] || { echo "Missing host source: $SOURCE_HOST" >&2; exit 1; }

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
APP_HOME="$DATA_HOME/edge-natural-tts"
VOICE_DIR="$APP_HOME/voices"
RUNTIME_DIR="$APP_HOME/runtime/linux-piper"
VENV_DIR="$RUNTIME_DIR/venv"
HOST_PY="$RUNTIME_DIR/linux_piper_host.py"
HOST_LAUNCHER="$RUNTIME_DIR/edge-natural-tts-linux-piper-host"
MANIFEST_DIR="$CONFIG_HOME/microsoft-edge/NativeMessagingHosts"
MANIFEST_PATH="$MANIFEST_DIR/com.sguzman.edge_tts.linux_piper.json"

mkdir -p "$VOICE_DIR" "$RUNTIME_DIR" "$MANIFEST_DIR"

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo "Creating isolated Piper runtime at:"
  echo "  $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

if "$VENV_DIR/bin/python" - <<'PY'
import importlib.metadata as metadata
try:
    version = metadata.version("piper-tts")
except metadata.PackageNotFoundError:
    version = ""
raise SystemExit(0 if version == "1.8.0" else 1)
PY
then
  echo "Reusing existing app-private Piper 1.8.0 runtime."
else
  echo "Installing Piper 1.8.0 inside the app-private runtime only..."
  "$VENV_DIR/bin/python" -m pip install --disable-pip-version-check --no-input "piper-tts==1.8.0"
fi

"$VENV_DIR/bin/python" - <<'PY'
import importlib.metadata as metadata

names = {dist.metadata["Name"].lower() for dist in metadata.distributions() if dist.metadata.get("Name")}
if "onnxruntime-gpu" in names:
    raise SystemExit("Refusing runtime: onnxruntime-gpu is installed. Edge Natural TTS Piper must remain CPU-only.")
if metadata.version("piper-tts") != "1.8.0":
    raise SystemExit("Piper installation verification failed.")
print("Verified: Piper runtime is isolated and has no onnxruntime-gpu package.")
PY

install -m 0644 "$SOURCE_HOST" "$HOST_PY"

PREFERRED_VOICE_ID="en_US-ryan-high"
if [[ -f "$VOICE_DIR/$PREFERRED_VOICE_ID.onnx" && -f "$VOICE_DIR/$PREFERRED_VOICE_ID.onnx.json" ]]; then
  echo "Running private Piper voice self-test for $PREFERRED_VOICE_ID..."
  EDGE_TTS_PIPER_VOICE_DIR="$VOICE_DIR" CUDA_VISIBLE_DEVICES=""     "$VENV_DIR/bin/python" "$HOST_PY" --self-test "$PREFERRED_VOICE_ID"
fi

cat > "$HOST_LAUNCHER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export CUDA_VISIBLE_DEVICES=""
export EDGE_TTS_PIPER_VOICE_DIR="$VOICE_DIR"
exec "$VENV_DIR/bin/python" "$HOST_PY"
EOF
chmod 0755 "$HOST_LAUNCHER"

"$VENV_DIR/bin/python" - "$MANIFEST_PATH" "$HOST_LAUNCHER" "$EXTENSION_ID" <<'PY'
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
launcher = str(Path(sys.argv[2]).resolve())
extension_id = sys.argv[3]
manifest = {
    "name": "com.sguzman.edge_tts.linux_piper",
    "description": "Edge Natural TTS Linux Piper CPU-only host",
    "path": launcher,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"],
}
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
chmod 0644 "$MANIFEST_PATH"

echo
echo "Linux Piper native host installed."
echo "  Runtime:  $RUNTIME_DIR"
echo "  Voices:   $VOICE_DIR"
echo "  Manifest: $MANIFEST_PATH"
echo
echo "The voice directory was preserved exactly as-is."
echo "Reload the unpacked extension in Edge, then open the reader."
