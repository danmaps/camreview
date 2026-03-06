#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/openclaw/.openclaw/workspace/camreview"

cd "$REPO_DIR"

git pull --ff-only

docker-compose up -d --build
