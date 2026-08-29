package mcp

import "testing"

func TestCleanOutput(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "plain text untouched",
			in:   "hello world\n",
			want: "hello world\n",
		},
		{
			name: "CSI color sequences stripped",
			in:   "\x1b[93mWrite-Host \x1b[36m'hi'\x1b[0m\r\n",
			want: "Write-Host 'hi'\r\n",
		},
		{
			name: "cursor and mode sequences stripped",
			in:   "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[HPowerShell 7.6.5\r\n",
			want: "PowerShell 7.6.5\r\n",
		},
		{
			name: "OSC title sequence stripped including BEL",
			in:   "\x1b]0;C:\\Users\\Tony\\pwsh\x07PS C:\\Users\\Tony> ",
			want: "PS C:\\Users\\Tony> ",
		},
		{
			name: "stray control characters dropped, tabs kept",
			in:   "a\x00b\x07c\t\x1bM",
			want: "abc\t",
		},
		{
			name: "empty input",
			in:   "",
			want: "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanOutput(tt.in); got != tt.want {
				t.Errorf("cleanOutput(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestDecodeInput(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"carriage return", "ls\\r", "ls\r"},
		{"ctrl+c", "\\u0003", "\x03"},
		{"newline and tab", "a\\nb\\t", "a\nb\t"},
		{"escaped backslash", "a\\\\b", "a\\b"},
		{"unknown escape kept", "a\\qb", "a\\qb"},
		{"trailing backslash kept", "ab\\", "ab\\"},
		{"no escapes", "hello", "hello"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := decodeInput(tt.in); got != tt.want {
				t.Errorf("decodeInput(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestStripCommandEcho(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		command string
		want    string
	}{
		{"echo stripped with CRLF", "Get-Date\r\nTuesday\r\n", "Get-Date", "Tuesday\r\n"},
		{"echo stripped with LF", "ls\nfile.txt\n", "ls", "file.txt\n"},
		{"echo with trailing whitespace stripped", "Write-Output hello-mcp  \r\nhello-mcp", "Write-Output hello-mcp", "hello-mcp"},
		{"fragmented long echo stripped", "echo hello worlecho hello world\r\nresult", "echo hello world", "result"},
		{"no echo leaves output", "result\r\n", "Get-Date", "result\r\n"},
		{"multi-line command untouched", "a\r\nb\r\n", "a\nb", "a\r\nb\r\n"},
		{"empty command untouched", "x\r\n", "", "x\r\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := stripCommandEcho(tt.output, tt.command); got != tt.want {
				t.Errorf("stripCommandEcho(%q, %q) = %q, want %q", tt.output, tt.command, got, tt.want)
			}
		})
	}
}

func TestStripTrailingPrompt(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"simple prompt stripped", "hello\r\nPS C:\\dir> ", "hello"},
		{"nested prompt stripped", "x\r\nPS C:\\dir>> ", "x"},
		{"prompt without trailing space stripped", "hello\r\nPS C:\\dir>", "hello"},
		{"no prompt untouched", "hello\r\n", "hello\r\n"},
		{"mid-output prompt-like text kept", "PS fake> \nhello\n", "PS fake> \nhello\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := stripTrailingPrompt(tt.in); got != tt.want {
				t.Errorf("stripTrailingPrompt(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
