package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"
)

// Windows closes the exclusive handle after a crash, so an empty lock file
// never becomes a stale lock. The file contains no runtime or credentials.
func acquireRuntimeLock(ctx context.Context, path string) (func(), error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	waiting := false
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if stat, err := os.Lstat(path); err == nil {
			if !stat.Mode().IsRegular() {
				return nil, errors.New("portable runtime lock is not a regular file")
			}
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil,
			syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
		if err == nil {
			return func() { syscall.CloseHandle(handle) }, nil
		}
		if err != syscall.Errno(32) {
			return nil, err
		} // ERROR_SHARING_VIOLATION
		if !waiting {
			fmt.Fprintln(os.Stderr, "[Setup] waiting for this version's runtime preparation")
			waiting = true
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}
