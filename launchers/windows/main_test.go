package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testTag = "setup-v0.5.0-edge.19"

func TestSelectorsAndCommandArguments(t *testing.T) {
	s, err := parseArguments([]string{"--channel", "edge", "bootstrap", "--release", "edge", "--lock", "space path.json"})
	if err != nil {
		t.Fatal(err)
	}
	if s.channel != "edge" || strings.Join(s.command, "|") != "bootstrap|--release|edge|--lock|space path.json" {
		t.Fatalf("command arguments were changed: %#v", s)
	}
	for _, args := range [][]string{
		{"--channel", "edge", "--version", "0.5.0-edge.19", "doctor"},
		{"--channel", "bad", "doctor"}, {"--version"}, {"--version", "../escape"},
		{"--channel", "edge", "--channel", "edge"}, {"-InstallRoot", "C:/unused"},
	} {
		if _, err := parseArguments(args); err == nil {
			t.Fatalf("invalid selection accepted: %v", args)
		}
	}
}
func TestCanonicalReleaseAssets(t *testing.T) {
	asset := makeAsset(runtimeAsset, []byte("archive"))
	if err := validateAsset(asset, testTag); err != nil {
		t.Fatal(err)
	}
	if _, err := exactAsset([]releaseAsset{asset, asset}, runtimeAsset); err == nil {
		t.Fatal("duplicate asset accepted")
	}
	for _, mutate := range []func(*releaseAsset){
		func(a *releaseAsset) { a.BrowserDownloadURL += "?other=1" },
		func(a *releaseAsset) {
			a.BrowserDownloadURL = strings.Replace(a.BrowserDownloadURL, "github.com", "evil.example", 1)
		},
		func(a *releaseAsset) { a.BrowserDownloadURL += "/another-file" },
		func(a *releaseAsset) { a.Digest = "sha256:bad" },
		func(a *releaseAsset) { a.Size = 0 },
	} {
		bad := asset
		mutate(&bad)
		if err := validateAsset(bad, testTag); err == nil {
			t.Fatalf("unsafe asset accepted: %#v", bad)
		}
	}
}

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func clientFor(bodies map[string][]byte) *http.Client {
	return &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		body, ok := bodies[r.URL.String()]
		if !ok {
			return nil, fmt.Errorf("unexpected request %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
	})}
}
func makeAsset(name string, body []byte) releaseAsset {
	return releaseAsset{
		Name: name, Size: int64(len(body)),
		BrowserDownloadURL: "https://github.com/" + canonicalRepository + "/releases/download/" + testTag + "/" + name,
		Digest:             fmt.Sprintf("sha256:%x", sha256.Sum256(body)),
	}
}

func TestPublicChannelHoldAndImmutableRelease(t *testing.T) {
	for _, value := range []string{"HOLD", "setup-v0.5.0", "../escape"} {
		client := clientFor(map[string][]byte{channelPointerBase + "edge": []byte(value)})
		if _, err := selectReleaseTag(context.Background(), client, selection{channel: "edge"}); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	client := clientFor(map[string][]byte{channelPointerBase + "edge": []byte(testTag + "\n")})
	tag, err := selectReleaseTag(context.Background(), client, selection{channel: "edge"})
	if err != nil || tag != testTag {
		t.Fatalf("valid channel: %s, %v", tag, err)
	}
	for _, r := range []releaseMetadata{{TagName: testTag, Immutable: false}, {TagName: testTag, Immutable: true, Draft: true}} {
		body, _ := json.Marshal(r)
		client := clientFor(map[string][]byte{"https://api.github.com/repos/" + canonicalRepository + "/releases/tags/" + testTag: body})
		if _, err := readRelease(context.Background(), client, testTag); err == nil {
			t.Fatal("unpublished/mutable release accepted")
		}
	}
}

func TestDownloadRejectsTruncatedTamperedAndOversizedAssets(t *testing.T) {
	asset := makeAsset("payload", []byte("expected bytes"))
	for _, payload := range [][]byte{[]byte("short"), []byte("tampered bytes"), []byte("expected bytes plus extra")} {
		client := clientFor(map[string][]byte{asset.BrowserDownloadURL: payload})
		err := downloadVerified(context.Background(), client, asset, filepath.Join(t.TempDir(), "payload"), 100)
		if err == nil {
			t.Fatalf("accepted tampered body %q", payload)
		}
	}
	client := clientFor(nil)
	if err := downloadVerified(context.Background(), client, asset, filepath.Join(t.TempDir(), "payload"), 1); err == nil {
		t.Fatal("asset size limit ignored")
	}
}

func runtimeZip(t *testing.T, extra string, manifestVersion string, hostPolicy string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	manifest := fmt.Sprintf("{\"name\":\"opensphere-setup\",\"version\":%q,\"platform\":\"windows\",\"architecture\":\"amd64\",\"hostInstallation\":%q}", manifestVersion, hostPolicy)
	files := map[string]string{
		runtimeDirectory + "/OPENSPHERE-RUNTIME.json": manifest,
		runtimeDirectory + "/opensphere-setup.exe":    "fixture",
		runtimeDirectory + "/runtime/pwsh/pwsh.exe":   "fixture",
		runtimeDirectory + "/runtime/bin/kubectl.exe": "fixture",
	}
	if extra != "" {
		files[extra] = "unsafe"
	}
	for name, body := range files {
		f, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(f, body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestRuntimeExtractionRejectsEscapesAndLegacyHostInstallPolicy(t *testing.T) {
	for _, extra := range []string{"../outside", runtimeDirectory + "/../../outside", runtimeDirectory + "/file:stream", runtimeDirectory + "\\wrong", runtimeDirectory + "/.. /outside", runtimeDirectory + "/NUL.txt"} {
		dir := t.TempDir()
		zipPath := filepath.Join(dir, "runtime.zip")
		if err := os.WriteFile(zipPath, runtimeZip(t, extra, "0.5.0-edge.19", "explicit-only"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := extractRuntime(zipPath, filepath.Join(dir, "expanded"), "0.5.0-edge.19"); err == nil {
			t.Fatalf("unsafe path accepted: %s", extra)
		}
	}
	for _, values := range [][2]string{{"0.5.0-edge.18", "explicit-only"}, {"0.5.0-edge.19", ""}} {
		dir := t.TempDir()
		zipPath := filepath.Join(dir, "runtime.zip")
		if err := os.WriteFile(zipPath, runtimeZip(t, "", values[0], values[1]), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := extractRuntime(zipPath, filepath.Join(dir, "expanded"), "0.5.0-edge.19"); err == nil {
			t.Fatal("legacy/foreign runtime accepted")
		}
	}
}

func TestChecksumRequiresExactSingleMatchingEntry(t *testing.T) {
	asset := makeAsset(runtimeAsset, []byte("archive"))
	good := strings.TrimPrefix(asset.Digest, "sha256:") + "  " + runtimeAsset + "\n"
	if err := verifyChecksumFile([]byte(good), asset); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", good + good, strings.Repeat("0", 64) + "  " + runtimeAsset} {
		if err := verifyChecksumFile([]byte(bad), asset); err == nil {
			t.Fatal("bad checksum file accepted")
		}
	}
}

func TestTemporaryRuntimeIsRemovedOnSuccessAndOperationFailure(t *testing.T) {
	for _, fail := range []bool{false, true} {
		archiveData := runtimeZip(t, "", "0.5.0-edge.19", "explicit-only")
		archive := makeAsset(runtimeAsset, archiveData)
		sumData := []byte(strings.TrimPrefix(archive.Digest, "sha256:") + "  " + runtimeAsset + "\n")
		sums := makeAsset("SHA256SUMS", sumData)
		client := clientFor(map[string][]byte{archive.BrowserDownloadURL: archiveData, sums.BrowserDownloadURL: sumData})
		release := releaseMetadata{TagName: testTag, Immutable: true, Assets: []releaseAsset{archive, sums}}
		var usedRoot string
		cwd, _ := os.Getwd()
		code, err := withTemporaryRuntime(context.Background(), client, release, func(root string) (int, error) {
			usedRoot = root
			if _, err := os.Stat(filepath.Join(root, "opensphere-setup.exe")); err != nil {
				t.Fatal(err)
			}
			current, _ := os.Getwd()
			if current != cwd {
				t.Fatal("caller working directory changed")
			}
			if fail {
				return 7, errors.New("child failed")
			}
			return 0, nil
		})
		if usedRoot == "" {
			t.Fatal("runtime was not invoked")
		}
		if _, statErr := os.Stat(filepath.Dir(filepath.Dir(usedRoot))); !os.IsNotExist(statErr) {
			t.Fatalf("temporary files remain: %s, %v", usedRoot, statErr)
		}
		if fail && (code != 7 || err == nil) {
			t.Fatalf("failure status lost: %d %v", code, err)
		}
		if !fail && (code != 0 || err != nil) {
			t.Fatalf("success failed: %d %v", code, err)
		}
	}
}
