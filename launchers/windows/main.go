package main

import (
	"archive/zip"
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
	"os/signal"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	canonicalRepository = "opensphere-platform/OpenSphere-Setup-CLI"
	channelPointerBase  = "https://raw.githubusercontent.com/opensphere-platform/OpenSphere-Setup-CLI/main/channels/"
	runtimeAsset        = "opensphere-setup-windows-amd64.zip"
	runtimeDirectory    = "opensphere-setup-windows-amd64"
	maxMetadataBytes    = 4 << 20
	maxChannelBytes     = 256
	maxArchiveBytes     = 512 << 20
	maxExpandedBytes    = 1 << 30
)

// The public launcher selects a release, runs its verified runtime from a unique
// temporary directory, and removes that directory after the child exits.
// It never installs Setup, writes a command shim, or changes the user's PATH.
var releaseTag string

var (
	validReleaseTag = regexp.MustCompile("^setup-v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
	validVersion    = regexp.MustCompile("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
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
	Size               int64  `json:"size"`
}
type selection struct {
	version string
	channel string
	command []string
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	code, err := run(ctx, os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "OpenSphere Setup:", err)
		if code == 0 {
			code = 1
		}
	}
	os.Exit(code)
}

func printHelp() {
	fmt.Printf("OpenSphere Setup CLI portable launcher %s\n\n", releaseTag)
	fmt.Println("Usage:")
	fmt.Println("  opensphere-setup.exe [--version <semver> | --channel <edge|candidate|stable>] <command> [options]")
	fmt.Println("  opensphere-setup.exe --channel edge doctor --release edge --context docker-desktop")
	fmt.Println("  opensphere-setup.exe --version 0.5.0-edge.19 bootstrap --release edge")
	fmt.Println("\nNo Windows installation, PATH registration, service, or permanent runtime cache.")
	fmt.Println("Each operation downloads the verified runtime into a temporary directory and removes it on exit.")
	fmt.Println("Internet access and download/extraction space are required. The archive remains available for offline runtime use.")
	fmt.Println("Selectors before <command> choose the Setup version. --release after <command> chooses the Console channel.")
	fmt.Println("Use version to print the selected Setup version; help/--help does not download a runtime.")
	fmt.Println("Console CLI installation is a separate explicit install-cli command.")
}

func parseArguments(args []string) (selection, error) {
	s := selection{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--version", "--channel":
			name := args[i]
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "-") {
				return s, fmt.Errorf("%s requires a value before the command", name)
			}
			i++
			if name == "--version" {
				if s.version != "" {
					return s, errors.New("--version may only be specified once")
				}
				s.version = args[i]
			} else {
				if s.channel != "" {
					return s, errors.New("--channel may only be specified once")
				}
				s.channel = args[i]
			}
		default:
			if strings.HasPrefix(args[i], "-") && args[i] != "--help" && args[i] != "-h" {
				return s, fmt.Errorf("unknown launcher option %s; put Console options after the command", args[i])
			}
			s.command = append([]string{}, args[i:]...)
			i = len(args)
		}
	}
	if s.version != "" && s.channel != "" {
		return s, errors.New("--version and --channel are mutually exclusive")
	}
	if s.version != "" && !validVersion.MatchString(s.version) {
		return s, errors.New("invalid Setup version")
	}
	if s.channel != "" && s.channel != "edge" && s.channel != "candidate" && s.channel != "stable" {
		return s, errors.New("unsupported Setup channel")
	}
	return s, nil
}

func run(ctx context.Context, args []string) (int, error) {
	if len(args) == 1 && args[0] == "--bootstrap-version" {
		fmt.Println(releaseTag)
		return 0, nil
	}
	if len(args) == 1 && args[0] == "--version" {
		args = []string{"version"}
	}
	s, err := parseArguments(args)
	if err != nil {
		return 1, err
	}
	if len(s.command) == 0 || s.command[0] == "help" || s.command[0] == "--help" || s.command[0] == "-h" {
		printHelp()
		return 0, nil
	}
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		return 1, errors.New("this launcher supports Windows amd64 only")
	}
	client := releaseHTTPClient()
	tag, err := selectReleaseTag(ctx, client, s)
	if err != nil {
		return 1, err
	}
	if len(s.command) == 1 && s.command[0] == "version" {
		if s.version != "" || s.channel != "" {
			if _, err := readRelease(ctx, client, tag); err != nil {
				return 1, err
			}
		}
		fmt.Println("opensphere-setup " + strings.TrimPrefix(tag, "setup-v"))
		return 0, nil
	}
	release, err := readRelease(ctx, client, tag)
	if err != nil {
		return 1, err
	}
	fmt.Fprintf(os.Stderr, "[Setup] %s — temporary execution; no Windows installation\n", tag)
	return withTemporaryRuntime(ctx, client, release, func(root string) (int, error) {
		setup := filepath.Join(root, "opensphere-setup.exe")
		check := exec.CommandContext(ctx, setup, "version")
		configureChild(check)
		out, err := check.Output()
		expected := "opensphere-setup " + strings.TrimPrefix(tag, "setup-v")
		if err != nil || strings.TrimSpace(string(out)) != expected {
			return 1, errors.New("verified runtime reports an unexpected Setup version")
		}
		command := exec.CommandContext(ctx, setup, s.command...)
		configureChild(command)
		command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
		// Inherit the caller's working directory and stdin unchanged: relative
		// lock paths and piped credentials belong to the operation, not this launcher.
		if err := command.Run(); err != nil {
			if ctx.Err() != nil {
				return 130, ctx.Err()
			}
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				return exit.ExitCode(), nil
			}
			return 1, err
		}
		return 0, nil
	})
}

func releaseHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 15 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many download redirects")
			}
			if request.URL.Scheme != "https" {
				return errors.New("download redirected outside HTTPS")
			}
			return nil
		},
	}
}

func request(ctx context.Context, client *http.Client, address string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "OpenSphere-Setup-Portable")
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("public release request returned %s", res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("public metadata exceeds size limit")
	}
	return data, nil
}

func selectReleaseTag(ctx context.Context, client *http.Client, s selection) (string, error) {
	tag := releaseTag
	if s.version != "" {
		tag = "setup-v" + s.version
	}
	if s.channel != "" {
		data, err := request(ctx, client, channelPointerBase+s.channel, maxChannelBytes)
		if err != nil {
			return "", err
		}
		tag = strings.TrimSpace(string(data))
		if tag == "HOLD" {
			return "", fmt.Errorf("Setup CLI channel %s is on HOLD", s.channel)
		}
		if !tagMatchesChannel(tag, s.channel) {
			return "", errors.New("invalid public channel pointer")
		}
	}
	if !validReleaseTag.MatchString(tag) {
		return "", errors.New("launcher is not bound to a valid Setup release")
	}
	return tag, nil
}

func tagMatchesChannel(tag, channel string) bool {
	version := strings.TrimPrefix(tag, "setup-v")
	pattern := ""
	switch channel {
	case "edge":
		pattern = "^[0-9]+\\.[0-9]+\\.[0-9]+-edge\\.[0-9]+$"
	case "candidate":
		pattern = "^[0-9]+\\.[0-9]+\\.[0-9]+-candidate\\.[0-9]+$"
	case "stable":
		pattern = "^[0-9]+\\.[0-9]+\\.[0-9]+$"
	default:
		return false
	}
	ok, _ := regexp.MatchString(pattern, version)
	return strings.HasPrefix(tag, "setup-v") && ok
}

func readRelease(ctx context.Context, client *http.Client, tag string) (releaseMetadata, error) {
	data, err := request(ctx, client, "https://api.github.com/repos/"+canonicalRepository+"/releases/tags/"+url.PathEscape(tag), maxMetadataBytes)
	if err != nil {
		return releaseMetadata{}, err
	}
	var release releaseMetadata
	if err := json.Unmarshal(data, &release); err != nil {
		return release, err
	}
	if release.TagName != tag || !release.Immutable || release.Draft {
		return release, errors.New("requested release is not published and immutable")
	}
	return release, nil
}

func exactAsset(assets []releaseAsset, name string) (releaseAsset, error) {
	var found releaseAsset
	count := 0
	for _, asset := range assets {
		if asset.Name == name {
			found = asset
			count++
		}
	}
	if count != 1 {
		return found, fmt.Errorf("release must contain exactly one %s asset", name)
	}
	return found, nil
}

func validateAsset(asset releaseAsset, tag string) error {
	u, err := url.Parse(asset.BrowserDownloadURL)
	expected := "/" + canonicalRepository + "/releases/download/" + url.PathEscape(tag) + "/" + url.PathEscape(asset.Name)
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil ||
		u.EscapedPath() != expected || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("asset URL is outside the exact canonical release")
	}
	digest := strings.TrimPrefix(asset.Digest, "sha256:")
	if !strings.HasPrefix(asset.Digest, "sha256:") || len(digest) != 64 || strings.ToLower(digest) != digest {
		return errors.New("asset has no canonical GitHub SHA-256 digest")
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return errors.New("invalid asset SHA-256 digest")
	}
	if asset.Size <= 0 {
		return errors.New("asset has no positive size")
	}
	return nil
}

func downloadVerified(ctx context.Context, client *http.Client, asset releaseAsset, destination string, limit int64) error {
	if asset.Size > limit {
		return errors.New("release asset exceeds size limit")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.BrowserDownloadURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "OpenSphere-Setup-Portable")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("asset download returned %s", res.Status)
	}
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(res.Body, asset.Size+1))
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written != asset.Size {
		return errors.New("release asset size mismatch")
	}
	if "sha256:"+hex.EncodeToString(hash.Sum(nil)) != asset.Digest {
		return errors.New("release asset SHA-256 mismatch")
	}
	return nil
}

func verifyChecksumFile(data []byte, archive releaseAsset) error {
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == archive.Name {
			count++
			if "sha256:"+fields[0] != archive.Digest {
				return errors.New("SHA256SUMS disagrees with GitHub asset digest")
			}
		}
	}
	if count != 1 {
		return errors.New("SHA256SUMS must contain exactly one runtime checksum")
	}
	return nil
}

func extractRuntime(archivePath, destination, expectedVersion string) (string, error) {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	if len(reader.File) > 5000 {
		return "", errors.New("runtime archive has too many entries")
	}
	var expanded uint64
	for _, file := range reader.File {
		name := strings.TrimSuffix(file.Name, "/")
		if name == "" || strings.ContainsAny(name, "\\:") || path.Clean(name) != name ||
			(name != runtimeDirectory && !strings.HasPrefix(name, runtimeDirectory+"/")) ||
			(!file.FileInfo().IsDir() && !file.Mode().IsRegular()) {
			return "", fmt.Errorf("unsafe runtime archive entry %q", file.Name)
		}
		for _, segment := range strings.Split(name, "/") {
			if strings.TrimRight(segment, ". ") != segment || strings.ContainsAny(segment, "<>\"|?*\x00") {
				return "", errors.New("runtime ZIP contains an ambiguous Windows path")
			}
			device := strings.ToUpper(strings.SplitN(segment, ".", 2)[0])
			if device == "CON" || device == "PRN" || device == "AUX" || device == "NUL" ||
				(len(device) == 4 && (strings.HasPrefix(device, "COM") || strings.HasPrefix(device, "LPT")) && device[3] >= '1' && device[3] <= '9') {
				return "", errors.New("runtime ZIP contains a Windows device path")
			}
		}
		if file.UncompressedSize64 > maxArchiveBytes {
			return "", errors.New("runtime archive entry exceeds size limit")
		}
		expanded += file.UncompressedSize64
		if expanded > maxExpandedBytes {
			return "", errors.New("runtime archive exceeds expanded size limit")
		}
		target := filepath.Join(destination, filepath.FromSlash(name))
		relative, err := filepath.Rel(destination, target)
		if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
			return "", errors.New("runtime archive entry escapes temporary directory")
		}
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0700); err != nil {
				return "", err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return "", err
		}
		input, err := file.Open()
		if err != nil {
			return "", err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			input.Close()
			return "", err
		}
		written, copyErr := io.Copy(output, io.LimitReader(input, int64(file.UncompressedSize64)+1))
		inputErr, outputErr := input.Close(), output.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if inputErr != nil {
			return "", inputErr
		}
		if outputErr != nil {
			return "", outputErr
		}
		if uint64(written) != file.UncompressedSize64 {
			return "", errors.New("expanded runtime size mismatch")
		}
	}
	root := filepath.Join(destination, runtimeDirectory)
	metadata, err := os.ReadFile(filepath.Join(root, "OPENSPHERE-RUNTIME.json"))
	if err != nil {
		return "", err
	}
	var manifest struct{ Name, Version, Platform, Architecture, HostInstallation string }
	if err := json.Unmarshal(metadata, &manifest); err != nil {
		return "", err
	}
	if manifest.Name != "opensphere-setup" || manifest.Version != expectedVersion ||
		manifest.Platform != "windows" || manifest.Architecture != "amd64" || manifest.HostInstallation != "explicit-only" {
		return "", errors.New("runtime manifest does not match selected release and host")
	}
	for _, relative := range []string{"opensphere-setup.exe", "runtime/pwsh/pwsh.exe", "runtime/bin/kubectl.exe"} {
		stat, err := os.Lstat(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil || !stat.Mode().IsRegular() {
			return "", fmt.Errorf("runtime is missing %s", relative)
		}
	}
	return root, nil
}

func withTemporaryRuntime(ctx context.Context, client *http.Client, release releaseMetadata, operation func(string) (int, error)) (int, error) {
	archive, err := exactAsset(release.Assets, runtimeAsset)
	if err != nil {
		return 1, err
	}
	sums, err := exactAsset(release.Assets, "SHA256SUMS")
	if err != nil {
		return 1, err
	}
	for _, asset := range []releaseAsset{archive, sums} {
		if err := validateAsset(asset, release.TagName); err != nil {
			return 1, err
		}
	}
	temporary, err := os.MkdirTemp("", "opensphere-setup-run-")
	if err != nil {
		return 1, err
	}
	defer func() {
		if err := os.RemoveAll(temporary); err != nil {
			fmt.Fprintf(os.Stderr, "[Setup] temporary cleanup failed; remove %s after all child processes exit: %v\n", temporary, err)
		}
	}()
	fmt.Fprintf(os.Stderr, "[Setup] downloading %.1f MiB verified runtime; files are temporary\n", float64(archive.Size)/(1<<20))
	archivePath, sumsPath := filepath.Join(temporary, "runtime.zip"), filepath.Join(temporary, "SHA256SUMS")
	if err := downloadVerified(ctx, client, sums, sumsPath, 1<<20); err != nil {
		return 1, err
	}
	if err := downloadVerified(ctx, client, archive, archivePath, maxArchiveBytes); err != nil {
		return 1, err
	}
	data, err := os.ReadFile(sumsPath)
	if err != nil {
		return 1, err
	}
	if err := verifyChecksumFile(data, archive); err != nil {
		return 1, err
	}
	root, err := extractRuntime(archivePath, filepath.Join(temporary, "expanded"), strings.TrimPrefix(release.TagName, "setup-v"))
	if err != nil {
		return 1, err
	}
	return operation(root)
}
