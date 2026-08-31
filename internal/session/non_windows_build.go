//go:build !windows

package session

// Keep SessionInfo portable for non-Windows builds.
var hostWindowsBuild int
