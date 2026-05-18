#!/bin/bash

REPO_DIR="/etc/nodejs/getSSL"
REPO_URL="git@github.com:jcoppieters/getSSL.git"

# Check if the directory exists AND is a valid git repository
if [ ! -d "$REPO_DIR/.git" ]; then
    echo "Repository not found. Cloning from $REPO_URL..."
    # Remove directory if it exists but isn't a git repo
    if [ -d "$REPO_DIR" ]; then
        echo "Removing incomplete directory..."
        rm -rf "$REPO_DIR"
    fi
    # Create parent directory if it doesn't exist
    mkdir -p "$(dirname "$REPO_DIR")"
    # Clone the repository
    git clone "$REPO_URL" "$REPO_DIR"
else
    echo "Repository found. Updating..."
fi

# Navigate to repository and update
cd "$REPO_DIR"
git pull
git reset --hard origin/main
npm install
npm run build
cd ~
