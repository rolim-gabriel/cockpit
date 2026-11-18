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
	"runtime"
	"strings"
	"time"
)

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
	target, reason := chooseFolder(args, cwd)
	if target != "" && !isDir(target) && reason == "resume" {
		// Never fall back to the window's folder: Claude would then work in the wrong project.
		logLaunch(target, "missing-folder", args)
		fmt.Fprintf(os.Stderr, "This chat belongs to the folder %s, which does not exist (moved, renamed or not synced yet). "+
			"Restore the folder, or open the chat from Claude Command Center after fixing it.\n", target)
		os.Exit(3)
	}
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
func chooseFolder(args []string, launchDir string) (string, string) {
	if id := resumeID(args); id != "" {
		if dir := transcriptCwd(id); dir != "" {
			return dir, "resume"
		}
		return "", ""
	}
	if isNewSession(args) {
		if dir := claimPending(launchDir); dir != "" {
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
	// Claude Command Center writes its data folder setting here when it differs from the default.
	if d := readConfig().DataDir; d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// transcriptCwd finds <id>.jsonl under the projects folder and returns the folder the
// conversation was started in (its first recorded cwd). Later records can carry a
// subfolder the Bash tool moved into, so the first one is the project.
func transcriptCwd(id string) string {
	if strings.ContainsAny(id, `/\`) || strings.Contains(id, "..") {
		return ""
	}
	matches, _ := filepath.Glob(filepath.Join(configDir(), "projects", "*", id+".jsonl"))
	for _, f := range matches {
		if dir := firstCwd(f); dir != "" {
			return dir
		}
	}
	return ""
}

func firstCwd(file string) string {
	f, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)
	for n := 0; sc.Scan() && n < 2000; n++ {
		var rec struct {
			Cwd         string `json:"cwd"`
			IsSidechain bool   `json:"isSidechain"`
		}
		if json.Unmarshal(sc.Bytes(), &rec) == nil && rec.Cwd != "" && !rec.IsSidechain {
			return rec.Cwd
		}
	}
	return ""
}

type config struct {
	DataDir string `json:"dataDir"`
	Log     string `json:"log"`
}

// readConfig reads the settings Claude Command Center hands to the launcher.
func readConfig() (c config) {
	if data, err := os.ReadFile(filepath.Join(stateDir(), "config.json")); err == nil {
		json.Unmarshal(data, &c)
	}
	return c
}

func stateDir() string {
	if d := os.Getenv("CLAUDE_CC_STATE_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude-command-center")
}

// claimPending takes the folder Claude Command Center handed over for the next new chat
// launched from this window (launchDir is the window's first folder). Each request is its
// own file, oldest first; renaming it first makes sure only one launch can claim it.
func claimPending(launchDir string) string {
	dir := filepath.Join(stateDir(), "pending")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	now := time.Now().UnixMilli()
	for _, e := range entries { // ReadDir sorts by name; names start with a timestamp
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		file := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var p struct {
			Cwd     string `json:"cwd"`
			From    string `json:"from"`    // first folder of the window that asked
			Expires int64  `json:"expires"` // unix ms
		}
		if json.Unmarshal(data, &p) != nil || now > p.Expires {
			os.Remove(file)
			continue
		}
		if !samePath(p.From, launchDir) {
			continue
		}
		claimed := file + ".claimed"
		if os.Rename(file, claimed) != nil {
			continue // another launch took it
		}
		os.Remove(claimed)
		return p.Cwd
	}
	return ""
}

// samePath: the same folder, even when one path goes through a symlink (/tmp vs /private/tmp on
// macOS) or differs only in letter case (Windows, macOS).
func samePath(a, b string) bool {
	if x, err := os.Stat(a); err == nil {
		if y, err := os.Stat(b); err == nil {
			return os.SameFile(x, y)
		}
	}
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "linux" {
		return a == b
	}
	return strings.EqualFold(a, b)
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func logLaunch(cwd, reason string, args []string) {
	file := os.Getenv("CLAUDE_CC_LOG")
	if file == "" {
		file = readConfig().Log
	}
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
