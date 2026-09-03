package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// Cancel only the process tree started for this invocation, including kubectl
// tunnels. This prevents a cancelled temporary run from leaving helpers alive.
func configureChild(command *exec.Cmd) {
	command.WaitDelay = 5 * time.Second
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		killer := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "taskkill.exe"),
			"/PID", strconv.Itoa(command.Process.Pid), "/T", "/F")
		killer.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := killer.Run(); err != nil {
			return command.Process.Kill()
		}
		return nil
	}
}
