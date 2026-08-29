//go:build windows

package main

import (
	"errors"
	"log"

	"golang.org/x/sys/windows"
)

// mutexName identifies the single running GUI instance. `Local\` scopes it to
// the interactive session (the stdio --mcp mode intentionally skips this).
const mutexName = `Local\PwshDeck-single-instance`

// showEventName lets a second instance tell the running instance to reveal its
// (possibly tray-hidden) windows. Revealing must go through Wails' own Show()
// path — a bare ShowWindow(SW_SHOW) from the second process would surface an
// empty/white WebView2 surface, because it skips chromium.Show().
const showEventName = `Local\PwshDeck-show-request`

var singleInstanceHandle windows.Handle

// acquireSingleInstance claims the single-instance mutex. When another GUI
// instance is already running it signals that instance to reveal its windows
// and returns false so the new process can exit.
func acquireSingleInstance() bool {
	name, err := windows.UTF16PtrFromString(mutexName)
	if err != nil {
		log.Printf("single-instance: cannot build mutex name: %v", err)
		return true // fail open rather than blocking startup
	}
	h, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			signalExistingInstance()
			return false
		}
		log.Printf("single-instance: CreateMutex failed: %v", err)
		return true
	}
	singleInstanceHandle = h
	return true
}

// signalExistingInstance pings the running instance's show event. The running
// instance watches that event and reveals its windows on its own main thread.
func signalExistingInstance() {
	name, err := windows.UTF16PtrFromString(showEventName)
	if err != nil {
		log.Printf("single-instance: cannot build show-event name: %v", err)
		return
	}
	h, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, name)
	if err != nil {
		// The running instance creates the event during startup; if it is not
		// there yet that instance is still booting and will show normally.
		log.Printf("single-instance: running instance's show event not ready: %v", err)
		return
	}
	defer windows.CloseHandle(h)
	if err := windows.SetEvent(h); err != nil {
		log.Printf("single-instance: SetEvent failed: %v", err)
	}
}

// watchShowRequest creates the cross-process show event and blocks until a
// second instance signals it, then invokes reveal (which restores the windows
// via Wails' Show()/Focus() on the main thread). Run it once per GUI process.
func watchShowRequest(reveal func()) {
	name, err := windows.UTF16PtrFromString(showEventName)
	if err != nil {
		log.Printf("single-instance: cannot build show-event name: %v", err)
		return
	}
	h, err := windows.CreateEvent(nil, 1, 0, name) // manual-reset, non-signaled
	if err != nil {
		log.Printf("single-instance: CreateEvent failed: %v", err)
		return
	}
	defer windows.CloseHandle(h)

	for {
		if _, err := windows.WaitForSingleObject(h, windows.INFINITE); err != nil {
			log.Printf("single-instance: wait on show event failed: %v", err)
			return
		}
		_ = windows.ResetEvent(h)
		reveal()
	}
}
