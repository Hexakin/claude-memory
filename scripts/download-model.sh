#!/usr/bin/env bash
set -euo pipefail

# Download nomic-embed-text-v1.5 Q8_0 GGUF model
# Run as claude-memory user

MODEL_DIR="${MEMORY_MODEL_DIR:-/opt/claude-memory/models}"
MODEL_FILE="nomic-embed-text-v1.5.Q8_0.gguf"
MODEL_URL="https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf"

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_DIR/$MODEL_FILE" ]; then
  echo "Model already exists at $MODEL_DIR/$MODEL_FILE"
  echo "Size: $(du -h "$MODEL_DIR/$MODEL_FILE" | cut -f1)"
  exit 0
fi

echo "Downloading $MODEL_FILE..."
echo "URL: $MODEL_URL"
echo "Destination: $MODEL_DIR/$MODEL_FILE"
echo ""

curl -L --progress-bar -o "$MODEL_DIR/$MODEL_FILE" "$MODEL_URL"

# Verify the download
if [ -f "$MODEL_DIR/$MODEL_FILE" ]; then
  SIZE=$(du -h "$MODEL_DIR/$MODEL_FILE" | cut -f1)
  echo ""
  echo "Download complete: $MODEL_DIR/$MODEL_FILE ($SIZE)"
else
  echo "ERROR: Download failed"
  exit 1
fi
