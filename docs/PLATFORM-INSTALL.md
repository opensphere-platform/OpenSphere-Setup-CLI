# 공개 GitHub Release 기반 Setup CLI 설치

OpenSphere Setup CLI는 공개 GitHub 저장소와 immutable GitHub Release를 통해 다음 5개 자체 포함 아카이브로 배포한다.

| 운영체제 | 아키텍처 | Release asset |
|---|---|---|
| Windows | amd64 | `opensphere-setup-windows-amd64.zip` |
| Linux | amd64 | `opensphere-setup-linux-amd64.tar.gz` |
| Linux | arm64 | `opensphere-setup-linux-arm64.tar.gz` |
| macOS | Intel | `opensphere-setup-darwin-amd64.tar.gz` |
| macOS | Apple Silicon | `opensphere-setup-darwin-arm64.tar.gz` |

아카이브에는 Setup 실행 runtime, PowerShell, kubectl과 필요한 라이브러리가 포함된다. Linux 패키지는
`libatomic.so.1`도 포함한다. 대상 호스트에 Node.js, npm, PowerShell, kubectl, libatomic 또는
GitHub CLI를 별도로 설치할 필요가 없다. Setup 저장소와 Setup release 다운로드에는 GitHub 인증이
필요하지 않다.

Setup CLI 공개 정책과 Console 배포물 접근 정책은 분리한다. Console GHCR package가 private이면
`doctor`, `resolve`, `bootstrap`, `upgrade`에 read-only package credential을 표준 입력으로 전달한다.
토큰은 URL, argv, release lock, ConfigMap 또는 로그에 기록하지 않는다.

## 1. Windows amd64 자동 설치

공개 GitHub API에서 exact tag의 immutable release와 installer asset digest를 확인한 뒤 실행한다.

```powershell
$repository = 'opensphere-platform/OpenSphere-Setup-CLI'
$release = 'setup-v0.5.0-edge.17'
$headers = @{
  Accept = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2026-03-10'
  'User-Agent' = 'OpenSphere-Setup-Installer-Bootstrap'
}
$metadata = Invoke-RestMethod `
  -Uri "https://api.github.com/repos/$repository/releases/tags/$release" `
  -Headers $headers
if ($metadata.immutable -ne $true -or $metadata.tag_name -ne $release -or $metadata.draft) {
  throw 'Setup release is not the requested published immutable release.'
}
$asset = @($metadata.assets | Where-Object { $_.name -eq 'Install-OpenSphereSetup.ps1' })
if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:[0-9a-f]{64}$') {
  throw 'Canonical installer asset or digest is missing.'
}
$installer = Join-Path $env:TEMP 'Install-OpenSphereSetup.ps1'
Invoke-WebRequest -Uri $asset[0].browser_download_url -OutFile $installer -MaximumRedirection 5
$actual = 'sha256:' + (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $asset[0].digest) { throw 'Installer asset digest mismatch.' }
& $installer
opensphere-setup version
```

version-bound installer는 동일 immutable release의 Windows archive와 `SHA256SUMS`를 내려받고,
두 asset의 GitHub SHA-256 digest와 archive의 `SHA256SUMS` 항목을 교차 검증한다. 이후 자체 포함
runtime을 `%LOCALAPPDATA%\OpenSphere\Setup\<version>`에 설치하고 사용자 PATH에
`opensphere-setup` shim을 등록한 뒤 실제 `version`을 확인한다.

## 2. Linux

아키텍처에 맞춰 `amd64` 또는 `arm64`를 선택한다.

```bash
set -euo pipefail
release=setup-v0.5.0-edge.17
architecture=amd64
repository=https://github.com/opensphere-platform/OpenSphere-Setup-CLI
target="$PWD/opensphere-setup-download"
mkdir -p "$target"
cd "$target"
curl --fail --location --proto '=https' --tlsv1.2 \
  "$repository/releases/download/$release/opensphere-setup-linux-${architecture}.tar.gz" \
  --output "opensphere-setup-linux-${architecture}.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 \
  "$repository/releases/download/$release/SHA256SUMS" \
  --output SHA256SUMS
grep " opensphere-setup-linux-${architecture}.tar.gz$" SHA256SUMS | sha256sum --check
tar -xzf "opensphere-setup-linux-${architecture}.tar.gz"
SETUP="$PWD/opensphere-setup-linux-${architecture}/opensphere-setup"
"$SETUP" version
```

## 3. macOS

Intel은 `amd64`, Apple Silicon은 `arm64`를 선택한다.

```bash
set -euo pipefail
release=setup-v0.5.0-edge.17
architecture="$(test "$(uname -m)" = arm64 && echo arm64 || echo amd64)"
repository=https://github.com/opensphere-platform/OpenSphere-Setup-CLI
target="$PWD/opensphere-setup-download"
mkdir -p "$target"
cd "$target"
curl --fail --location --proto '=https' --tlsv1.2 \
  "$repository/releases/download/$release/opensphere-setup-darwin-${architecture}.tar.gz" \
  --output "opensphere-setup-darwin-${architecture}.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 \
  "$repository/releases/download/$release/SHA256SUMS" \
  --output SHA256SUMS
expected="$(grep " opensphere-setup-darwin-${architecture}.tar.gz$" SHA256SUMS | awk '{print $1}')"
actual="$(shasum -a 256 "opensphere-setup-darwin-${architecture}.tar.gz" | awk '{print $1}')"
test -n "$expected" && test "$actual" = "$expected"
tar -xzf "opensphere-setup-darwin-${architecture}.tar.gz"
SETUP="$PWD/opensphere-setup-darwin-${architecture}/opensphere-setup"
"$SETUP" version
```

GitHub Immutable Releases가 tag와 asset 변경을 잠근다. macOS `edge` SEA는 생성 후 ad-hoc 서명하고
아카이브를 다시 풀어 실행까지 검증한다. 이 서명은 Apple Developer ID notarization을 대체하지 않으며,
운영 승격에서는 별도 Developer ID 서명·notarization gate가 필요하다.

## 4. Kubernetes 무변경 진단

공개 Setup CLI를 설치한 뒤 Kubernetes를 변경하기 전에 `doctor`를 실행한다. `edge`는 GitHub CLI를
요구하지 않는다. `candidate`와 `stable`은 OCI attestation 검증을 위해 `gh`가 필요하다.

Console GHCR package가 공개이면:

```powershell
opensphere-setup doctor `
  --release edge `
  --context docker-desktop `
  --storage-class hostpath
```

Console GHCR package가 private이면 새 read-only package token을 표준 입력으로만 전달한다.

```powershell
$env:GHCR_TOKEN | opensphere-setup doctor `
  --release edge `
  --context docker-desktop `
  --storage-class hostpath `
  --registry-username '<github-login>' `
  --registry-token-stdin
```

## 5. Console bootstrap

`doctor`가 통과한 exact release lock과 동일한 channel을 설치한다.

```powershell
$env:GHCR_TOKEN | opensphere-setup bootstrap `
  --release edge `
  --context docker-desktop `
  --storage-class hostpath `
  --registry-username '<github-login>' `
  --registry-token-stdin
```

fresh local edge의 기본 Console origin은 `https://localhost:1114`이다. 개발 CA를 아직 신뢰하지 않는
경우에만 명시적으로 `--console http://localhost:1114`를 사용할 수 있다. 원격 환경과
`candidate`/`stable`에는 외부 CA가 서명한 HTTPS 인증서 Secret이 필요하다.
