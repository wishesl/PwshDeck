//go:build windows

package main

import (
	"errors"
	"log"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// mutexName identifies the single running GUI instance. `Local\` scopes it to
// the interactive session (the stdio --mcp mode intentionally skips this).
const mutexName = `Local\pwsh-mcp-single-instance`

var (
	singleInstanceHandle windows.Handle

	user32                  = syscall.NewLazyDLL("user32.dll")
	procEnumWindows         = user32.NewProc("EnumWindows")
	procGetWindowTextW      = user32.NewProc("GetWindowTextW")
	procIsIconic            = user32.NewProc("IsIconic")
	procShowWindow          = user32.NewProc("ShowWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
)

// acquireSingleInstance claims the single-instance mutex. When another GUI
// instance is already running it brings that window to the foreground and
// returns false so the new process can exit.
func acquireSingleInstance() bool {
	name, err := windows.UTF16PtrFromString(mutexName)
	if err != nil {
		log.Printf("single-instance: cannot build mutex name: %v", err)
		return true // fail open rather than blocking startup
	}
	h, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			focusExistingWindow()
			return false
		}
		log.Printf("single-instance: CreateMutex failed: %v", err)
		return true
	}
	singleInstanceHandle = h
	return true
}

// focusExistingWindow brings the running instance's terminal window to the
// foreground (restoring it first if it is minimized).
func focusExistingWindow() {
	var found uintptr
	callback := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		if found != 0 {
			return 0 // stop enumerating
		}
		var buf [256]uint16
		n, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		title := syscall.UTF16ToString(buf[:n])
		if strings.Contains(title, "pwsh Terminal") {
			found = hwnd
			return 0
		}
		return 1
	})
	procEnumWindows.Call(callback, 0)

	if found == 0 {
		log.Println("single-instance: another instance is running but its window was not found")
		return
	}
	if iconic, _, _ := procIsIconic.Call(found); iconic != 0 {
		procShowWindow.Call(found, 9) // SW_RESTORE
	}
	procSetForegroundWindow.Call(found)
	log.Println("single-instance: focusing the running instance")
}
