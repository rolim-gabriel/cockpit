package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setup(t *testing.T) (root string) {
	root = t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "cfg"))
	t.Setenv("CLAUDE_CC_STATE_DIR", filepath.Join(root, "state"))
	return root
}

func writeTranscript(t *testing.T, root, dir, id string, cwds ...string) {
	p := filepath.Join(root, "cfg", "projects", dir)
	os.MkdirAll(p, 0o755)
	var lines []string
	for _, c := range cwds {
		b, _ := json.Marshal(map[string]any{"type": "user", "cwd": c})
		lines = append(lines, string(b))
	}
	os.WriteFile(filepath.Join(p, id+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644)
}

func pending(t *testing.T, root, name, cwd, from string, expires int64) string {
	d := filepath.Join(root, "state", "pending")
	os.MkdirAll(d, 0o755)
	b, _ := json.Marshal(map[string]any{"cwd": cwd, "from": from, "expires": expires})
	f := filepath.Join(d, name+".json")
	os.WriteFile(f, b, 0o644)
	return f
}

func TestResumeUsesFirstRecordedFolder(t *testing.T) {
	root := setup(t)
	proj := filepath.Join(root, "proj")
	// The Bash tool later moved into a subfolder; the project is the first folder.
	writeTranscript(t, root, "p", "abc", proj, filepath.Join(proj, "sub"))
	for _, args := range [][]string{{"--input-format", "x", "--resume=abc"}, {"--resume", "abc"}, {"-r", "abc"}} {
		if got, why := chooseFolder(args, "/first"); got != proj || why != "resume" {
			t.Fatalf("%v: got %q %q", args, got, why)
		}
	}
}

func TestResumeUnknownChatIsLeftAlone(t *testing.T) {
	setup(t)
	if got, _ := chooseFolder([]string{"--resume=nope"}, "/first"); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestResumeRejectsPathTricks(t *testing.T) {
	setup(t)
	if transcriptCwd("../x") != "" || transcriptCwd(`a\b`) != "" {
		t.Fatal("path in session id must be refused")
	}
}

func TestDataDirFromConfig(t *testing.T) {
	root := setup(t)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	os.MkdirAll(filepath.Join(root, "state"), 0o755)
	b, _ := json.Marshal(map[string]string{"dataDir": filepath.Join(root, "cfg")})
	os.WriteFile(filepath.Join(root, "state", "config.json"), b, 0o644)
	writeTranscript(t, root, "p", "abc", "/somewhere")
	if got := transcriptCwd("abc"); got != "/somewhere" {
		t.Fatalf("got %q", got)
	}
}

func TestPendingClaimedOnceByTheRightWindow(t *testing.T) {
	root := setup(t)
	future := time.Now().Add(time.Minute).UnixMilli()
	f1 := pending(t, root, "1000-a", "/projX", "/windowA", future)
	f2 := pending(t, root, "2000-b", "/projY", "/windowB", future)
	args := []string{"--output-format", "stream-json", "--input-format", "stream-json"}
	if got, _ := chooseFolder(args, "/windowB"); got != "/projY" {
		t.Fatalf("window B got %q", got)
	}
	if _, err := os.Stat(f1); err != nil {
		t.Fatal("window B must not take window A's handover")
	}
	if got, _ := chooseFolder(args, "/windowA"); got != "/projX" {
		t.Fatalf("window A got %q", got)
	}
	if got, _ := chooseFolder(args, "/windowA"); got != "" {
		t.Fatalf("claimed twice: %q", got)
	}
	if _, err := os.Stat(f2); err == nil {
		t.Fatal("claimed file should be gone")
	}
}

func TestPendingOldestFirstAndExpired(t *testing.T) {
	root := setup(t)
	args := []string{"--input-format", "stream-json"}
	pending(t, root, "0500-x", "/old", "/w", time.Now().Add(-time.Second).UnixMilli())
	pending(t, root, "1000-a", "/first", "/w", time.Now().Add(time.Minute).UnixMilli())
	pending(t, root, "2000-b", "/second", "/w", time.Now().Add(time.Minute).UnixMilli())
	if got, _ := chooseFolder(args, "/w"); got != "/first" {
		t.Fatalf("got %q", got)
	}
	if got, _ := chooseFolder(args, "/w"); got != "/second" {
		t.Fatalf("got %q", got)
	}
}

func TestOnlyChatLaunchesClaimHandovers(t *testing.T) {
	root := setup(t)
	pending(t, root, "1000-a", "/projX", "/w", time.Now().Add(time.Minute).UnixMilli())
	for _, args := range [][]string{{"auth", "status", "--json"}, {"--input-format", "x", "--no-session-persistence"}, {"--input-format", "x", "--continue"}} {
		if got, _ := chooseFolder(args, "/w"); got != "" {
			t.Fatalf("%v claimed %q", args, got)
		}
	}
}

func TestLogFromConfig(t *testing.T) {
	root := setup(t)
	t.Setenv("CLAUDE_CC_LOG", "")
	log := filepath.Join(root, "launcher.log")
	os.MkdirAll(filepath.Join(root, "state"), 0o755)
	b, _ := json.Marshal(map[string]string{"log": log})
	os.WriteFile(filepath.Join(root, "state", "config.json"), b, 0o644)
	logLaunch("/proj", "resume", []string{"--resume=abc"})
	data, err := os.ReadFile(log)
	if err != nil || !strings.Contains(string(data), `"reason":"resume"`) {
		t.Fatalf("log not written: %v %s", err, data)
	}
}
