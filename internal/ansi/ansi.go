// Package ansi turns raw terminal output into the plain text a human would see.
package ansi

import (
	"regexp"
	"strings"
)

// pattern matches ANSI/VT escape sequences in terminal output: CSI
// (ESC [ ...), OSC (ESC ] ... up to BEL/ST) and single-byte ESC sequences.
var pattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-~]`)

// Strip removes ANSI escape sequences and stray control characters from
// terminal output, producing plain text. Tabs, CR and LF are kept; other
// control characters are dropped.
func Strip(s string) string {
	s = pattern.ReplaceAllString(s, "")
	return strings.Map(func(r rune) rune {
		switch r {
		case '\t', '\r', '\n':
			return r
		default:
			if r < 0x20 || r == 0x7f {
				return -1 // drop remaining control characters
			}
			return r
		}
	}, s)
}
