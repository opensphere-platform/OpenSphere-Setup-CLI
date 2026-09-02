package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	canonicalRepository = "opensphere-platform/OpenSphere-Setup-CLI"
	powershellAsset     = "Install-OpenSphereSetup.ps1"
	channelPointerBase  = "https://raw.githubusercontent.com/opensphere-platform/OpenSphere-Setup-CLI/main/channels/"
	maxMetadataBytes    = 4 << 20
	maxInstallerBytes   = 4 << 20
	maxChannelBytes     = 256
)

// releaseTag is injected by the release workflow. Without an explicit selection,
// a bootstrapper remains bound to the immutable release that published it.
var releaseTag string

var (
	validReleaseTag = regexp.MustCompile(`^setup-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
	validVersion    = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
)

type releaseMetadata struct {
	TagName   string         `json:"tag_name"`
	Immutable bool           `json:"immutable"`
	Draft     bool           `json:"draft"`
	Assets    []releaseAsset `json:"assets"`
}

type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Digest             string `json:"digest"`
}

type installerSelection struct {
	version   string
	channel   string
	forwarded []string
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--bootstrap-version" {
		fmt.Println(releaseTag)
		return
	}
	if len(os.Args) == 2 && (os.Args[1] == "--help" || os.Args[1] == "-h") {
		printHelp()
		return
	}
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "OpenSphere Setup installation failed:", err)
		os.Exit(1)
	}
}

func printHelp() {
	fmt.Printf(`OpenSphere Setup CLI installer %s

Usage:
  Install-OpenSphereSetup.exe
  Install-OpenSphereSetup.exe --version <semver>
  Install-OpenSphereSetup.exe --channel <edge|candidate|stable>

--version selects one exact immutable Setup CLI release.
--channel resolves the public channel pointer once, then installs that immutable release.
The two selectors are mutually exclusive. Other arguments are forwarded to the
PowerShell installer, for example -NoPathUpdate.
`, releaseTag)
}

func run(ctx context.Context, arguments []string) error {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		return fmt.Errorf("this installer supports Windows amd64 only: %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	selection, err := parseInstallerArguments(arguments)
	if err != nil {
		return err
	}
	client := releaseHTTPClient()
	targetTag, err := selectReleaseTag(ctx, client, selection)
	if err != nil {
		return err
	}

	metadataURL := "https://api.github.com/repos/" + canonicalRepository + "/releases/tags/" + url.PathEscape(targetTag)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, metadataURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	request.Header.Set("User-Agent", "OpenSphere-Setup-Installer")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("query public release: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("query public release: GitHub returned %s", response.Status)
	}

	var release releaseMetadata
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxMetadataBytes))
	if err := decoder.Decode(&release); err != nil {
		return fmt.Errorf("decode public release metadata: %w", err)
	}
	if release.TagName != targetTag || !release.Immutable || release.Draft {
		return errors.New("GitHub release is not the requested published immutable Setup release")
	}

	asset, err := exactAsset(release.Assets, powershellAsset)
	if err != nil {
		return err
	}
	if err := validateAsset(asset, targetTag); err != nil {
		return err
	}

	temporaryDirectory, err := os.MkdirTemp("", "opensphere-setup-installer-")
	if err != nil {
		return fmt.Errorf("create temporary installer directory: %w", err)
	}
	defer os.RemoveAll(temporaryDirectory)
	powershellPath := filepath.Join(temporaryDirectory, powershellAsset)
	if err := downloadVerified(ctx, client, asset, powershellPath); err != nil {
		return err
	}

	powershell, powershellArguments, err := powershellCommand(powershellPath, targetTag, selection.forwarded)
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, powershell, powershellArguments...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("verified PowerShell installer: %w", err)
	}
	return nil
}

func releaseHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 2 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many download redirects")
			}
			if request.URL.Scheme != "https" {
				return errors.New("release download redirected outside HTTPS")
			}
			return nil
		},
	}
}

func parseInstallerArguments(arguments []string) (installerSelection, error) {
	selection := installerSelection{}
	for index := 0; index < len(arguments); index++ {
		switch arguments[index] {
		case "--version":
			if selection.version != "" || index+1 >= len(arguments) {
				return installerSelection{}, errors.New("--version must be specified once with a value")
			}
			index++
			selection.version = arguments[index]
		case "--channel":
			if selection.channel != "" || index+1 >= len(arguments) {
				return installerSelection{}, errors.New("--channel must be specified once with a value")
			}
			index++
			selection.channel = arguments[index]
		default:
			selection.forwarded = append(selection.forwarded, arguments[index])
		}
	}
	if selection.version != "" && selection.channel != "" {
		return installerSelection{}, errors.New("--version and --channel are mutually exclusive")
	}
	if selection.version != "" && !validVersion.MatchString(selection.version) {
		return installerSelection{}, fmt.Errorf("invalid Setup CLI version: %s", selection.version)
	}
	if selection.channel != "" && !isSupportedChannel(selection.channel) {
		return installerSelection{}, fmt.Errorf("unsupported Setup CLI channel: %s", selection.channel)
	}
	return selection, nil
}

func selectReleaseTag(ctx context.Context, client *http.Client, selection installerSelection) (string, error) {
	if selection.version != "" {
		return "setup-v" + selection.version, nil
	}
	if selection.channel != "" {
		return resolveChannelPointer(ctx, client, selection.channel)
	}
	if !validReleaseTag.MatchString(releaseTag) {
		return "", errors.New("the installer is not bound to a valid immutable release tag")
	}
	return releaseTag, nil
}

func resolveChannelPointer(ctx context.Context, client *http.Client, channel string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, channelPointerBase+channel, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "OpenSphere-Setup-Installer")
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("resolve public Setup CLI channel %s: %w", channel, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("resolve public Setup CLI channel %s: GitHub returned %s", channel, response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxChannelBytes+1))
	if err != nil {
		return "", fmt.Errorf("read public Setup CLI channel %s: %w", channel, err)
	}
	if len(body) > maxChannelBytes {
		return "", fmt.Errorf("public Setup CLI channel %s pointer is too large", channel)
	}
	tag := strings.TrimSpace(string(body))
	if tag == "HOLD" {
		return "", fmt.Errorf("Setup CLI channel %s is on HOLD and has no installable release", channel)
	}
	if !validReleaseTag.MatchString(tag) || !tagMatchesChannel(tag, channel) {
		return "", fmt.Errorf("public Setup CLI channel %s has an invalid release pointer", channel)
	}
	return tag, nil
}

func isSupportedChannel(channel string) bool {
	return channel == "edge" || channel == "candidate" || channel == "stable"
}

func tagMatchesChannel(tag, channel string) bool {
	version := strings.TrimPrefix(tag, "setup-v")
	switch channel {
	case "edge":
		matched, _ := regexp.MatchString(`-edge\.[0-9]+$`, version)
		return matched
	case "candidate":
		matched, _ := regexp.MatchString(`-candidate\.[0-9]+$`, version)
		return matched
	case "stable":
		matched, _ := regexp.MatchString(`^[0-9]+\.[0-9]+\.[0-9]+$`, version)
		return matched
	default:
		return false
	}
}

func exactAsset(assets []releaseAsset, name string) (releaseAsset, error) {
	matches := make([]releaseAsset, 0, 1)
	for _, asset := range assets {
		if asset.Name == name {
			matches = append(matches, asset)
		}
	}
	if len(matches) != 1 {
		return releaseAsset{}, fmt.Errorf("public release must contain exactly one %s asset; found %d", name, len(matches))
	}
	return matches[0], nil
}

func validateAsset(asset releaseAsset, targetTag string) error {
	expectedPrefix := "/" + canonicalRepository + "/releases/download/" + targetTag + "/"
	assetURL, err := url.Parse(asset.BrowserDownloadURL)
	if err != nil {
		return fmt.Errorf("parse installer asset URL: %w", err)
	}
	if assetURL.Scheme != "https" || assetURL.Hostname() != "github.com" ||
		!strings.HasPrefix(assetURL.EscapedPath(), expectedPrefix) {
		return errors.New("PowerShell installer URL is outside the canonical public release path")
	}
	digest, found := strings.CutPrefix(asset.Digest, "sha256:")
	if !found || len(digest) != sha256.Size*2 {
		return errors.New("PowerShell installer has no canonical GitHub SHA-256 digest")
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return errors.New("PowerShell installer has an invalid GitHub SHA-256 digest")
	}
	return nil
}

func downloadVerified(ctx context.Context, client *http.Client, asset releaseAsset, destination string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.BrowserDownloadURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/octet-stream")
	request.Header.Set("User-Agent", "OpenSphere-Setup-Installer")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("download verified PowerShell installer: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download verified PowerShell installer: GitHub returned %s", response.Status)
	}

	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("create temporary PowerShell installer: %w", err)
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, maxInstallerBytes+1))
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("write temporary PowerShell installer: %w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close temporary PowerShell installer: %w", closeErr)
	}
	if written > maxInstallerBytes {
		return errors.New("PowerShell installer exceeds the expected size limit")
	}
	expected, _ := strings.CutPrefix(asset.Digest, "sha256:")
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expected {
		return fmt.Errorf("PowerShell installer digest mismatch: sha256:%s", actual)
	}
	return nil
}

func powershellCommand(scriptPath, targetTag string, forwardedArguments []string) (string, []string, error) {
	powershell, err := exec.LookPath("pwsh.exe")
	arguments := []string{"-NoLogo", "-NoProfile", "-NonInteractive"}
	if err != nil {
		powershell, err = exec.LookPath("powershell.exe")
		if err != nil {
			return "", nil, errors.New("PowerShell 7 or Windows PowerShell 5.1 is required to run the installer")
		}
		arguments = append(arguments, "-ExecutionPolicy", "Bypass")
	}
	arguments = append(arguments, "-File", scriptPath, "-ReleaseTag", targetTag)
	arguments = append(arguments, forwardedArguments...)
	return powershell, arguments, nil
}
