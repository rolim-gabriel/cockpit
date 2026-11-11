// claude-cc-wrapper is set as the official Claude Code extension's
// `claudeCode.claudeProcessWrapper`. The official extension launches every chat
// panel's Claude process as:
//
//	claude-cc-wrapper <claude-binary> <args...>
//
// and always in the window's first folder. This wrapper runs the same binary with
// the same arguments, but in the conversation's own project folder:
//   - resuming a conversation (--resume <id>): the folder recorded in its transcript
//   - a new conversation: the folder Claude Command Center handed over just before
//     opening the panel (a short-lived pending file)
//
// Anything else (auth checks, first-folder chats, other tools) runs unchanged.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
)

const tailBytes = 256 * 1024

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "claude-cc-wrapper: expected the Claude Code binary as the first argument")
		os.Exit(2)
	}
	exe, args := os.Args[1], os.Args[2:]
	if override := os.Getenv("CLAUDE_CC_EXEC"); override != "" {
		exe = override
	}
	cwd, _ := os.Getwd()
	target, reason := chooseFolder(args)
	if target != "" && isDir(target) {
		cwd = target
	} else {
		reason = "unchanged"
	}
	logLaunch(cwd, reason, args)

	cmd := exec.Command(exe, args...)
	cmd.Dir = cwd
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "claude-cc-wrapper: could not start %s: %v\n", exe, err)
		os.Exit(127)
	}
	forwardSignals(cmd.Process)
	err := cmd.Wait()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		os.Exit(exitErr.ExitCode())
	}
	if err != nil {
		os.Exit(1)
	}
}

// chooseFolder returns the folder the session belongs in, or "" to leave it.
func chooseFolder(args []string) (string, string) {
	if id := resumeID(args); id != "" {
		if dir := transcriptCwd(id); dir != "" {
			return dir, "resume"
		}
		return "", ""
	}
	if isNewSession(args) {
		if dir := claimPending(); dir != "" {
			return dir, "pending"
		}
	}
	return "", ""
}

func resumeID(args []string) string {
	for i, a := range args {
		if (a == "--resume" || a == "-r") && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(a, "--resume=") {
			return strings.TrimPrefix(a, "--resume=")
		}
	}
	return ""
}

// A chat panel's session launch (not an auth check or a one-off helper query).
func isNewSession(args []string) bool {
	has := func(flag string) bool {
		for _, a := range args {
			if a == flag || strings.HasPrefix(a, flag+"=") {
				return true
			}
		}
		return false
	}
	return has("--input-format") && !has("--no-session-persistence") && !has("--continue") && !has("-c")
}

func configDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// transcriptCwd finds <id>.jsonl under the projects folder and returns the last
// working folder recorded in it.
func transcriptCwd(id string) string {
	if strings.ContainsAny(id, `/\`) || strings.Contains(id, "..") {
		return ""
	}
	matches, _ := filepath.Glob(filepath.Join(configDir(), "projects", "*", id+".jsonl"))
	for _, f := range matches {
		if dir := lastCwd(f); dir != "" {
			return dir
		}
	}
	return ""
}

func lastCwd(file string) string {
	f, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	start := int64(0)
	if st.Size() > tailBytes {
		start = st.Size() - tailBytes
	}
	if _, err := f.Seek(start, 0); err != nil {
		return ""
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)
	found := ""
	for sc.Scan() {
		var rec struct {
			Cwd         string `json:"cwd"`
			IsSidechain bool   `json:"isSidechain"`
		}
		if json.Unmarshal(sc.Bytes(), &rec) == nil && rec.Cwd != "" && !rec.IsSidechain {
			found = rec.Cwd
		}
	}
	if found == "" && start > 0 {
		// Very long tail without a cwd: fall back to the first records.
		if _, err := f.Seek(0, 0); err == nil {
			sc = bufio.NewScanner(f)
			sc.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)
			for sc.Scan() {
				var rec struct{ Cwd string `json:"cwd"` }
				if json.Unmarshal(sc.Bytes(), &rec) == nil && rec.Cwd != "" {
					return rec.Cwd
				}
			}
		}
	}
	return found
}

func stateDir() string {
	if d := os.Getenv("CLAUDE_CC_STATE_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude-command-center")
}

// claimPending takes the folder Claude Command Center handed over for the next
// new chat. The file is renamed first so two launches can never both claim it.
func claimPending() string {
	file := filepath.Join(stateDir(), "pending-new-chat.json")
	claimed := fmt.Sprintf("%s.%d", file, os.Getpid())
	if os.Rename(file, claimed) != nil {
		return ""
	}
	defer os.Remove(claimed)
	data, err := os.ReadFile(claimed)
	if err != nil {
		return ""
	}
	var p struct {
		Cwd     string `json:"cwd"`
		Expires int64  `json:"expires"` // unix ms
	}
	if json.Unmarshal(data, &p) != nil || time.Now().UnixMilli() > p.Expires {
		return ""
	}
	return p.Cwd
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func logLaunch(cwd, reason string, args []string) {
	file := os.Getenv("CLAUDE_CC_LOG")
	if file == "" {
		return
	}
	line, _ := json.Marshal(map[string]any{"at": time.Now().Format(time.RFC3339), "cwd": cwd, "reason": reason, "args": args})
	if f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		f.Write(append(line, '\n'))
		f.Close()
	}
}

func forwardSignals(p *os.Process) {
	ch := make(chan os.Signal, 4)
	signal.Notify(ch, forwardedSignals...)
	go func() {
		for s := range ch {
			p.Signal(s)
		}
	}()
}
