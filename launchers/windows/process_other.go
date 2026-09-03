//go:build !windows

package main

import "os/exec"

func configureChild(command *exec.Cmd) {}
