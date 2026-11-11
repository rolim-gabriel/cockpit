#!/bin/sh
# Builds the wrapper for every platform into ../bin (run before packaging).
set -e
cd "$(dirname "$0")"
for t in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
  os=${t%/*}; arch=${t#*/}
  node_os=$os; [ "$os" = windows ] && node_os=win32
  node_arch=$arch; [ "$arch" = amd64 ] && node_arch=x64
  ext=""; [ "$os" = windows ] && ext=".exe"
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "../bin/$node_os-$node_arch/claude-cc-wrapper$ext" .
done
