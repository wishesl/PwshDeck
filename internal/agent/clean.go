package agent

import (
	"regexp"
	"strings"
)

// Output-cleaning helpers mirror internal/mcp's (same regexes and semantics):
// terminal output is cleaned before it reaches the model so it sees plain
// text. Kept in this package to avoid a dependency on the MCP transport.

// ansiPattern matches ANSI/VT escape sequences: CSI, OSC (up to BEL/ST) and
// single-byte ESC sequences.
var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-~]`)

// cleanOutput strips ANSI escapes and stray control characters, keeping
// \t\r\n and printable text.
func cleanOutput(s string) string {
	s = ansiPattern.ReplaceAllString(s, "")
	return strings.Map(func(r rune) rune {
		switch r {
		case '\t', '\r', '\n':
			return r
		default:
			if r < 0x20 || r == 0x7f {
				return -1
			}
			return r
		}
	}, s)
}

// stripCommandEcho removes the echoed command line the shell renders while
// typing, keeping only the command's own output. Same first-occurrence
// strategy as the MCP tools (PSReadLine echoes long commands in fragments
// plus one full redraw).
func stripCommandEcho(output, command string) string {
	command = strings.TrimSpace(command)
	if command == "" || strings.ContainsAny(command, "\r\n") {
		return output
	}
	idx := strings.Index(output, command)
	if idx < 0 {
		return output
	}
	rest := output[idx+len(command):]
	rest = strings.TrimLeft(rest, " \t")
	return strings.TrimLeft(rest, "\r\n")
}

// tailOutput keeps the tail of a chunk of output (fresh output matters more
// than early noise), trimming trailing newlines.
func tailOutput(s string, limit int) string {
	if limit <= 0 || len(s) <= limit {
		return strings.TrimRight(s, "\r\n")
	}
	return strings.TrimRight(s[len(s)-limit:], "\r\n")
}

// decodeInput expands the escapes send_input documents (\r, \n, \t, \\ and
// \uXXXX) into raw bytes so the agent can send Enter or Ctrl+C as text.
func decodeInput(s string) string {
	if !strings.ContainsRune(s, '\\') {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] != '\\' || i+1 >= len(s) {
			b.WriteByte(s[i])
			i++
			continue
		}
		switch s[i+1] {
		case 'r':
			b.WriteByte('\r')
			i += 2
		case 'n':
			b.WriteByte('\n')
			i += 2
		case 't':
			b.WriteByte('\t')
			i += 2
		case '\\':
			b.WriteByte('\\')
			i += 2
		case 'u':
			if i+6 <= len(s) {
				if r, ok := parseUnicodeEscape(s[i+2 : i+6]); ok {
					b.WriteRune(r)
					i += 6
					continue
				}
			}
			b.WriteByte(s[i])
			i++
		default:
			b.WriteByte(s[i])
			i++
		}
	}
	return b.String()
}

// parseUnicodeEscape parses four hex digits into a rune.
func parseUnicodeEscape(hex string) (rune, bool) {
	var v rune
	for _, c := range hex {
		var d rune
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, false
		}
		v = v*16 + d
	}
	return v, true
}
