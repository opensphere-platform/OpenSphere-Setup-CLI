package main

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
)

func bindTestRelease(t *testing.T) {
	t.Helper()
	previous := releaseTag
	releaseTag = "setup-v0.5.0-edge.18"
	t.Cleanup(func() { releaseTag = previous })
}

func TestExactAssetRequiresOneCanonicalName(t *testing.T) {
	asset := releaseAsset{Name: powershellAsset}
	found, err := exactAsset([]releaseAsset{{Name: "other"}, asset}, powershellAsset)
	if err != nil || found.Name != powershellAsset {
		t.Fatalf("expected one exact installer asset, got %#v, %v", found, err)
	}
	if _, err := exactAsset([]releaseAsset{asset, asset}, powershellAsset); err == nil {
		t.Fatal("duplicate installer assets must fail closed")
	}
}

func TestValidateAssetAcceptsOnlyCanonicalReleaseURLAndSHA256(t *testing.T) {
	bindTestRelease(t)
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256([]byte("installer")))
	canonical := releaseAsset{
		Name:               powershellAsset,
		BrowserDownloadURL: "https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.18/Install-OpenSphereSetup.ps1",
		Digest:             digest,
	}
	if err := validateAsset(canonical, releaseTag); err != nil {
		t.Fatalf("canonical asset should pass: %v", err)
	}

	outside := canonical
	outside.BrowserDownloadURL = strings.Replace(outside.BrowserDownloadURL, "opensphere-platform", "lookalike", 1)
	if err := validateAsset(outside, releaseTag); err == nil {
		t.Fatal("asset outside the canonical repository must fail")
	}

	invalidDigest := canonical
	invalidDigest.Digest = "sha256:not-a-digest"
	if err := validateAsset(invalidDigest, releaseTag); err == nil {
		t.Fatal("invalid GitHub asset digest must fail")
	}
}
func TestInstallerVersionAndChannelSelectorsAreExclusive(t *testing.T) {
	selection, err := parseInstallerArguments([]string{"--version", "0.5.0-edge.18", "-NoPathUpdate"})
	if err != nil {
		t.Fatalf("exact version selection should pass: %v", err)
	}
	if selection.version != "0.5.0-edge.18" || len(selection.forwarded) != 1 {
		t.Fatalf("unexpected parsed selection: %#v", selection)
	}
	if _, err := parseInstallerArguments([]string{"--version", "0.5.0-edge.18", "--channel", "edge"}); err == nil {
		t.Fatal("version and channel together must fail")
	}
	if _, err := parseInstallerArguments([]string{"--channel", "unknown"}); err == nil {
		t.Fatal("unknown channel must fail")
	}
}

func TestChannelTagClassificationIsClosed(t *testing.T) {
	cases := []struct {
		tag     string
		channel string
		valid   bool
	}{
		{"setup-v0.5.0-edge.18", "edge", true},
		{"setup-v0.5.0-candidate.1", "candidate", true},
		{"setup-v0.5.0", "stable", true},
		{"setup-v0.5.0-edge.18", "stable", false},
		{"setup-v0.5.0", "edge", false},
	}
	for _, testCase := range cases {
		if actual := tagMatchesChannel(testCase.tag, testCase.channel); actual != testCase.valid {
			t.Errorf("tagMatchesChannel(%q, %q) = %t, want %t", testCase.tag, testCase.channel, actual, testCase.valid)
		}
	}
}
