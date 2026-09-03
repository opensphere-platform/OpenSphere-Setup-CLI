package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Existing folders must be real directories, not junctions or symbolic links.
func assertPlainDirectory(directory string) error {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	for p := absolute; ; p = filepath.Dir(p) {
		stat, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if !stat.IsDir() || stat.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("portable runtime path is not a plain directory: %s", p)
		}
		if filepath.Dir(p) == p {
			return nil
		}
	}
}

func hashRegularFile(path string, expectedSize int64) (string, error) {
	stat, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !stat.Mode().IsRegular() || stat.Size() != expectedSize {
		return "", fmt.Errorf("stored runtime size/type mismatch: %s", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(file, expectedSize+1))
	if err != nil {
		return "", err
	}
	if size != expectedSize {
		return "", errors.New("stored runtime size changed while reading")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func verifyStoredAsset(path string, asset releaseAsset) error {
	digest, err := hashRegularFile(path, asset.Size)
	if err != nil {
		return err
	}
	if "sha256:"+digest != asset.Digest {
		return fmt.Errorf("stored asset SHA-256 mismatch: %s", asset.Name)
	}
	return nil
}

func withPortableRuntime(ctx context.Context, client *http.Client, release releaseMetadata, base string, operation func(string) (int, error)) (int, error) {
	root, err := preparePortableRuntime(ctx, client, release, base)
	if err != nil {
		return 1, err
	}
	if err := ctx.Err(); err != nil {
		return 130, err
	}
	// Preparation lock is released before execution. Other commands may reuse the
	// immutable runtime concurrently; no command evicts or overwrites it.
	return operation(root)
}

func preparePortableRuntime(ctx context.Context, client *http.Client, release releaseMetadata, base string) (string, error) {
	if !validReleaseTag.MatchString(release.TagName) || !release.Immutable || release.Draft {
		return "", errors.New("portable runtime requires a published immutable release")
	}
	archive, err := exactAsset(release.Assets, runtimeAsset)
	if err != nil {
		return "", err
	}
	sums, err := exactAsset(release.Assets, "SHA256SUMS")
	if err != nil {
		return "", err
	}
	for _, asset := range []releaseAsset{archive, sums} {
		if err := validateAsset(asset, release.TagName); err != nil {
			return "", err
		}
	}
	if archive.Size > maxArchiveBytes || sums.Size > 1<<20 {
		return "", errors.New("release asset exceeds size limit")
	}
	if err := assertPlainDirectory(filepath.Dir(base)); err != nil {
		return "", err
	}
	if err := os.MkdirAll(base, 0700); err != nil {
		return "", fmt.Errorf("cannot create portable runtime folder beside EXE; move the EXE to a writable folder: %w", err)
	}
	if err := assertPlainDirectory(base); err != nil {
		return "", err
	}
	unlock, err := acquireRuntimeLock(ctx, filepath.Join(base, release.TagName+".lock"))
	if err != nil {
		return "", err
	}
	defer unlock()
	destination := filepath.Join(base, release.TagName)
	archivePath, sumsPath := filepath.Join(destination, "runtime.zip"), filepath.Join(destination, "SHA256SUMS")
	if _, err := os.Lstat(destination); err == nil {
		fmt.Fprintf(os.Stderr, "[Setup] verifying stored runtime: %s\n", destination)
		root, err := func() (string, error) {
			if err := assertPlainDirectory(destination); err != nil {
				return "", err
			}
			if err := verifyStoredAsset(archivePath, archive); err != nil {
				return "", err
			}
			if err := verifyStoredAsset(sumsPath, sums); err != nil {
				return "", err
			}
			data, err := os.ReadFile(sumsPath)
			if err != nil {
				return "", err
			}
			if err := verifyChecksumFile(data, archive); err != nil {
				return "", err
			}
			return verifyRuntime(archivePath, filepath.Join(destination, "expanded"), strings.TrimPrefix(release.TagName, "setup-v"))
		}()
		if err != nil {
			return "", fmt.Errorf("stored runtime failed verification; close Setup commands and remove only %s to download again: %w", destination, err)
		}
		fmt.Fprintln(os.Stderr, "[Setup] reusing verified runtime; no runtime download")
		return root, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	staging, err := os.MkdirTemp(base, ".download-"+release.TagName+"-")
	if err != nil {
		return "", err
	}
	// Only this invocation's unique staging directory is cleaned. Complete
	// versions and any other process's staging directories are never removed.
	defer func() {
		if err := os.RemoveAll(staging); err != nil {
			fmt.Fprintf(os.Stderr, "[Setup] incomplete download cleanup failed: %s: %v\n", staging, err)
		}
	}()
	fmt.Fprintf(os.Stderr, "[Setup] downloading %.1f MiB runtime once for %s\n", float64(archive.Size)/(1<<20), release.TagName)
	stagedArchive, stagedSums := filepath.Join(staging, "runtime.zip"), filepath.Join(staging, "SHA256SUMS")
	if err := downloadVerified(ctx, client, sums, stagedSums, 1<<20); err != nil {
		return "", err
	}
	if err := downloadVerified(ctx, client, archive, stagedArchive, maxArchiveBytes); err != nil {
		return "", err
	}
	data, err := os.ReadFile(stagedSums)
	if err != nil {
		return "", err
	}
	if err := verifyChecksumFile(data, archive); err != nil {
		return "", err
	}
	if _, err := extractRuntime(stagedArchive, filepath.Join(staging, "expanded"), strings.TrimPrefix(release.TagName, "setup-v")); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.Rename(staging, destination); err != nil {
		return "", err
	}
	fmt.Fprintf(os.Stderr, "[Setup] runtime saved for reuse: %s\n", destination)
	return filepath.Join(destination, "expanded", runtimeDirectory), nil
}
