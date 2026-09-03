package main

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

func TestCancellationWaitsForOwnedChildToExit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	command := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60")
	configureChild(command)
	if err := command.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled operation succeeded")
		}
	case <-time.After(10 * time.Second):
		_ = command.Process.Kill()
		t.Fatal("owned process did not exit after cancellation")
	}
}
