//go:build !windows

package main

// acquireSingleInstance is a no-op on non-Windows platforms.
func acquireSingleInstance() bool { return true }
