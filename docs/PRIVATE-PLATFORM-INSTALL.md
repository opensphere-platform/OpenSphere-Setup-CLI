# 비공개 운영체제별 Setup CLI 설치

OpenSphere Setup CLI는 비공개 GitHub Release에서 다음 5개 자체 포함 아카이브로 배포한다.

| 운영체제 | 아키텍처 | Release asset |
|---|---|---|
| Windows | amd64 | `opensphere-setup-windows-amd64.zip` |
| Linux | amd64 | `opensphere-setup-linux-amd64.tar.gz` |
| Linux | arm64 | `opensphere-setup-linux-arm64.tar.gz` |
| macOS | Intel | `opensphere-setup-darwin-amd64.tar.gz` |
| macOS | Apple Silicon | `opensphere-setup-darwin-arm64.tar.gz` |

아카이브에는 Node SEA, PowerShell, kubectl과 필요한 런타임이 포함된다. Linux 패키지는
`libatomic.so.1`도 포함한다. 따라서 대상 호스트에 Node.js, npm, PowerShell, kubectl,
libatomic을 별도로 설치할 필요가 없다.

호스트에 필요한 외부 도구는 다음뿐이다.

- Git
- GitHub CLI(`gh`)
- 접근 가능한 Kubernetes v1.30 이상 클러스터

## 1. 비공개 저장소 인증

GitHub 계정에는 Setup 비공개 저장소에 대한 `Contents: read` 권한이 있어야 한다.

```text
gh auth login
gh auth status
```

토큰을 자동화에 사용할 경우 argv에 직접 넣지 말고 `GH_TOKEN` secret으로 전달한다.

## 2. Windows amd64

```powershell
$release = 'setup-v0.5.0-edge.3'
$target = Join-Path $PWD 'opensphere-setup-download'
New-Item -ItemType Directory -Force $target | Out-Null

gh release download $release `
  --repo opensphere-platform/OpenSphere-Setup-CLI `
  --pattern 'opensphere-setup-windows-amd64.zip' `
  --pattern 'SHA256SUMS' `
  --dir $target

Set-Location $target
$expected = ((Get-Content SHA256SUMS |
  Where-Object { $_ -match 'opensphere-setup-windows-amd64\.zip$' }) -split '\s+')[0]
$actual = (Get-FileHash .\opensphere-setup-windows-amd64.zip -Algorithm SHA256).Hash
if ($actual.ToLowerInvariant() -ne $expected.ToLowerInvariant()) {
  throw 'OpenSphere Setup archive checksum mismatch'
}

gh release verify $release `
  --repo opensphere-platform/OpenSphere-Setup-CLI
gh release verify-asset $release .\opensphere-setup-windows-amd64.zip `
  --repo opensphere-platform/OpenSphere-Setup-CLI
Expand-Archive .\opensphere-setup-windows-amd64.zip -DestinationPath .
.\opensphere-setup-windows-amd64\opensphere-setup.exe version
```

## 3. Linux

아키텍처에 맞춰 `amd64` 또는 `arm64`를 선택한다.

```bash
release=setup-v0.5.0-edge.3
architecture=amd64
target="$PWD/opensphere-setup-download"
mkdir -p "$target"

gh release download "$release" \
  --repo opensphere-platform/OpenSphere-Setup-CLI \
  --pattern "opensphere-setup-linux-${architecture}.tar.gz" \
  --pattern SHA256SUMS \
  --dir "$target"

cd "$target"
grep " opensphere-setup-linux-${architecture}.tar.gz$" SHA256SUMS | sha256sum --check
gh release verify "$release" --repo opensphere-platform/OpenSphere-Setup-CLI
gh release verify-asset "$release" "opensphere-setup-linux-${architecture}.tar.gz" \
  --repo opensphere-platform/OpenSphere-Setup-CLI
tar -xzf "opensphere-setup-linux-${architecture}.tar.gz"
./"opensphere-setup-linux-${architecture}"/opensphere-setup version
```

## 4. macOS

Intel은 `amd64`, Apple Silicon은 `arm64`를 선택한다.

```bash
release=setup-v0.5.0-edge.3
architecture=arm64
target="$PWD/opensphere-setup-download"
mkdir -p "$target"

gh release download "$release" \
  --repo opensphere-platform/OpenSphere-Setup-CLI \
  --pattern "opensphere-setup-darwin-${architecture}.tar.gz" \
  --pattern SHA256SUMS \
  --dir "$target"

cd "$target"
expected="$(grep " opensphere-setup-darwin-${architecture}.tar.gz$" SHA256SUMS | awk '{print $1}')"
actual="$(shasum -a 256 "opensphere-setup-darwin-${architecture}.tar.gz" | awk '{print $1}')"
test "$actual" = "$expected"
gh release verify "$release" --repo opensphere-platform/OpenSphere-Setup-CLI
gh release verify-asset "$release" "opensphere-setup-darwin-${architecture}.tar.gz" \
  --repo opensphere-platform/OpenSphere-Setup-CLI
tar -xzf "opensphere-setup-darwin-${architecture}.tar.gz"
./"opensphere-setup-darwin-${architecture}"/opensphere-setup version
```

GitHub Immutable Releases가 tag와 asset 변경을 잠그고 release attestation을 생성한다.
`edge` 아카이브의 이 검증은 Windows Authenticode와 Apple Developer ID notarization을
대체하지 않으며, 운영 승격에서는 별도 release gate가 필요하다.

## 5. 설치 전 검사와 bootstrap

압축을 푼 디렉터리에서 운영체제별 실행 파일로 `doctor`를 먼저 실행한다. 다음은 Windows
Docker Desktop 예시다.

```powershell
.\opensphere-setup-windows-amd64\opensphere-setup.exe doctor `
  --release edge `
  --context docker-desktop `
  --storage-class hostpath `
  --console https://localhost:8090

.\opensphere-setup-windows-amd64\opensphere-setup.exe bootstrap `
  --release edge `
  --context docker-desktop `
  --storage-class hostpath `
  --console https://localhost:8090
```

Linux와 macOS에서는 같은 인수를 `./opensphere-setup`에 전달한다. 비공개 GHCR image를
사용하면 `gh auth status`가 성공하고 계정에 package read 권한이 있는지 먼저 확인한다.
