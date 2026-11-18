//go:build !windows

package main

import (
	"os"
	"syscall"
)

var forwardedSignals = []os.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP}
