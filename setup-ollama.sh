#!/bin/bash
# Setup Ollama for PII redaction

# Check if Ollama is installed
if ! command -v ollama &> /dev/null; then
  echo "Installing Ollama..."
  brew install ollama
else
  echo "Ollama already installed: $(ollama --version)"
fi

# Start Ollama in background if not running
if ! curl -s http://localhost:11434/api/tags &> /dev/null; then
  echo "Starting Ollama server..."
  ollama serve &
  sleep 3
else
  echo "Ollama server already running."
fi

# Pull model
MODEL=${OLLAMA_MODEL:-llama3.1:8b}
echo "Pulling model: $MODEL ..."
ollama pull "$MODEL"

echo ""
echo "Done! You can now run:"
echo "  node pii-redactor.mjs <path-to-pdf>    # test PII redaction"
echo "  node summarize.mjs <path-to-pdf>        # full pipeline"
