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
