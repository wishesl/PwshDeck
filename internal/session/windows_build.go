//go:build windows

package session

import "golang.org/x/sys/windows"

// hostWindowsBuild is passed to xterm.js so it can select the correct ConPTY
// wrapping behavior. Windows builds before 21376 need the legacy heuristics.
var hostWindowsBuild = func() int {
	_, _, build := windows.RtlGetNtVersionNumbers()
	return int(build)
}()
