#!/usr/bin/env bash
set -euo pipefail

CDN="https://cdn.jsdelivr.net/gh/mshaugh/nerdfont-webfonts@v3.3.0/build/fonts"
DIR="$(dirname "$0")/../public/fonts"
mkdir -p "$DIR"

fonts=(
  JetBrainsMonoNerdFont-Regular
  JetBrainsMonoNerdFont-Bold
  FiraCodeNerdFont-Regular
  FiraCodeNerdFont-Bold
  HackNerdFont-Regular
  HackNerdFont-Bold
  MesloLGSNerdFont-Regular
  MesloLGSNerdFont-Bold
  CaskaydiaMonoNerdFont-Regular
  CaskaydiaMonoNerdFont-Bold
  GeistMonoNerdFont-Regular
  GeistMonoNerdFont-Bold
  CommitMonoNerdFont-Regular
  CommitMonoNerdFont-Bold
  0xProtoNerdFont-Regular
  0xProtoNerdFont-Bold
)

for f in "${fonts[@]}"; do
  echo "Downloading ${f}.woff2..."
  curl -fsSL -o "${DIR}/${f}.woff2" "${CDN}/${f}.woff2"
done

echo "Done. ${#fonts[@]} files in ${DIR}/"
