//go:build windows

package main

import "os"

// Windows delivers Ctrl+C to the whole console group, so the child already gets it.
var forwardedSignals = []os.Signal{}
