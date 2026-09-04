#!/bin/bash
cd "$(dirname "$0")"
echo "Starting ENGR101 Office Hours Dashboard..."
echo "Open http://127.0.0.1:8080 in your browser"
echo "Press Ctrl+C to stop"
python3 server.py
