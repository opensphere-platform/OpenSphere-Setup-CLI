package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func storedRuntimeFixture(t *testing.T, version string) (releaseMetadata, *http.Client, *atomic.Int32) {
	t.Helper()
	tag := "setup-v" + version
	archiveData := runtimeZip(t, "", version, "explicit-only")
	archive := makeAsset(runtimeAsset, archiveData)
	archive.BrowserDownloadURL = strings.ReplaceAll(archive.BrowserDownloadURL, testTag, tag)
	sumData := []byte(strings.TrimPrefix(archive.Digest, "sha256:") + "  " + runtimeAsset + "\n")
	sums := makeAsset("SHA256SUMS", sumData)
	sums.BrowserDownloadURL = strings.ReplaceAll(sums.BrowserDownloadURL, testTag, tag)
	var requests atomic.Int32
	bodies := map[string][]byte{archive.BrowserDownloadURL: archiveData, sums.BrowserDownloadURL: sumData}
	client := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		requests.Add(1)
		body, ok := bodies[r.URL.String()]
		if !ok {
			return nil, errors.New("unexpected request")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
	})}
	return releaseMetadata{TagName: tag, Immutable: true, Assets: []releaseAsset{archive, sums}}, client, &requests
}

func TestPortableRuntimeReusesFilesWithoutDownloadAfterSuccessAndFailure(t *testing.T) {
	release, client, requests := storedRuntimeFixture(t, "0.5.0-edge.20")
	base := filepath.Join(t.TempDir(), "opensphere-setup-runtime")
	cwd, _ := os.Getwd()
	var firstRoot string
	code, err := withPortableRuntime(context.Background(), client, release, base, func(root string) (int, error) {
		firstRoot = root
		return 7, errors.New("operation failed")
	})
	if code != 7 || err == nil || requests.Load() != 2 {
		t.Fatalf("initial preparation: %d %v requests=%d", code, err, requests.Load())
	}
	executable := filepath.Join(firstRoot, "opensphere-setup.exe")
	before, err := os.Stat(executable)
	if err != nil {
		t.Fatal(err)
	}
	code, err = withPortableRuntime(context.Background(), clientFor(nil), release, base, func(root string) (int, error) {
		if root != firstRoot {
			t.Fatal("runtime was extracted again")
		}
		current, _ := os.Getwd()
		if current != cwd {
			t.Fatal("caller working directory changed")
		}
		return 0, nil
	})
	if err != nil || code != 0 {
		t.Fatalf("reuse failed: %d %v", code, err)
	}
	after, _ := os.Stat(executable)
	if !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("stored executable was replaced or rewritten")
	}
	entries, _ := filepath.Glob(filepath.Join(base, ".download-*"))
	if len(entries) != 0 {
		t.Fatal("staging residue", entries)
	}
}

func TestPortableRuntimeRejectsChangedMissingAndUnexpectedFilesWithoutDownloading(t *testing.T) {
	for _, scenario := range []string{"executable", "archive", "checksum", "missing", "extra-dll", "junction"} {
		t.Run(scenario, func(t *testing.T) {
			release, client, _ := storedRuntimeFixture(t, "0.5.0-edge.20")
			base := filepath.Join(t.TempDir(), "opensphere-setup-runtime")
			root, err := preparePortableRuntime(context.Background(), client, release, base)
			if err != nil {
				t.Fatal(err)
			}
			destination := filepath.Join(base, release.TagName)
			switch scenario {
			case "executable":
				err = os.WriteFile(filepath.Join(root, "opensphere-setup.exe"), []byte("changed"), 0600)
			case "archive":
				err = os.WriteFile(filepath.Join(destination, "runtime.zip"), []byte("changed"), 0600)
			case "checksum":
				err = os.WriteFile(filepath.Join(destination, "SHA256SUMS"), []byte("changed"), 0600)
			case "missing":
				err = os.Remove(filepath.Join(root, "runtime", "bin", "kubectl.exe"))
			case "extra-dll":
				err = os.WriteFile(filepath.Join(root, "injected.dll"), []byte("extra"), 0600)
			case "junction":
				external := t.TempDir()
				err = os.Symlink(external, filepath.Join(root, "foreign"))
				if err != nil {
					t.Skipf("symbolic links unavailable: %v", err)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			called := false
			_, err = withPortableRuntime(context.Background(), clientFor(nil), release, base, func(string) (int, error) { called = true; return 0, nil })
			if err == nil || called || !strings.Contains(err.Error(), "stored runtime failed verification") {
				t.Fatalf("unsafe reuse: called=%v, %v", called, err)
			}
		})
	}
}

func TestPortableRuntimeNewVersionDoesNotReplacePreviousVersion(t *testing.T) {
	base := filepath.Join(t.TempDir(), "opensphere-setup-runtime")
	var previous string
	for _, version := range []string{"0.5.0-edge.20", "0.5.0-edge.21"} {
		release, client, requests := storedRuntimeFixture(t, version)
		root, err := preparePortableRuntime(context.Background(), client, release, base)
		if err != nil || requests.Load() != 2 {
			t.Fatalf("version %s: %v", version, err)
		}
		if previous != "" {
			if root == previous {
				t.Fatal("versions share a runtime")
			}
			if _, err := os.Stat(filepath.Join(previous, "opensphere-setup.exe")); err != nil {
				t.Fatal("previous runtime removed", err)
			}
		}
		previous = root
	}
}

func TestPortableRuntimeConcurrentPreparationDownloadsOnlyOnce(t *testing.T) {
	release, client, requests := storedRuntimeFixture(t, "0.5.0-edge.20")
	base := filepath.Join(t.TempDir(), "opensphere-setup-runtime")
	var group sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := preparePortableRuntime(context.Background(), client, release, base)
			errs <- err
		}()
	}
	group.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if requests.Load() != 2 {
		t.Fatalf("runtime was downloaded more than once: %d requests", requests.Load())
	}
}

func TestPortableRuntimeIncompleteDownloadNeverBecomesReusable(t *testing.T) {
	release, client, _ := storedRuntimeFixture(t, "0.5.0-edge.20")
	base := filepath.Join(t.TempDir(), "opensphere-setup-runtime")
	broken := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("truncated")), Header: make(http.Header)}, nil
	})}
	if _, err := preparePortableRuntime(context.Background(), broken, release, base); err == nil {
		t.Fatal("partial download accepted")
	}
	if _, err := os.Stat(filepath.Join(base, release.TagName)); !os.IsNotExist(err) {
		t.Fatal("incomplete version visible")
	}
	entries, _ := filepath.Glob(filepath.Join(base, ".download-*"))
	if len(entries) != 0 {
		t.Fatal("incomplete download was not cleaned")
	}
	if _, err := preparePortableRuntime(context.Background(), client, release, base); err != nil {
		t.Fatal("retry failed", err)
	}
}

func TestPortableRuntimeCancellationReleasesPreparationLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "version.lock")
	unlock, err := acquireRuntimeLock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if release, err := acquireRuntimeLock(ctx, path); err == nil {
		release()
		t.Fatal("exclusive lock was not held")
	} else if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	unlock()
	release, err := acquireRuntimeLock(context.Background(), path)
	if err != nil {
		t.Fatal("closed lock was not reusable", err)
	}
	release()
}
