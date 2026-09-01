//go:build !windows

package main

// acquireSingleInstance is a no-op on non-Windows platforms.
func acquireSingleInstance() bool { return true }

// watchShowRequest is a no-op on non-Windows platforms: there is no second
// instance to send a "show window" request from.
func watchShowRequest(reveal func()) {}
