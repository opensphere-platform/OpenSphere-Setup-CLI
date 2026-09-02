# 공개 GitHub Release 기반 Setup CLI 설치

OpenSphere Setup CLI는 공개 GitHub 저장소와 immutable GitHub Release로 배포한다. 일반 사용자는 운영체제별 설치기 하나로 시작하고, 설치기는 자체 포함 runtime 아카이브를 내려받아 검증한 뒤 사용자 경로에 설치한다.

## 1. Release 자산

| 구분 | Release asset | 용도 |
|---|---|---|
| Windows 권장 설치기 | `Install-OpenSphereSetup.exe` | exact Release에 결속된 실행형 부트스트랩 |
| Windows 대체 설치기 | `Install-OpenSphereSetup.ps1` | 검토 가능한 PowerShell 설치 경로 |
| Linux/macOS 권장 설치기 | `install-opensphere-setup.sh` | OS와 아키텍처 자동 판별 |
| Windows amd64 runtime | `opensphere-setup-windows-amd64.zip` | Node.js, PowerShell, kubectl 포함 |
| Linux amd64 runtime | `opensphere-setup-linux-amd64.tar.gz` | Node.js, PowerShell, kubectl, `libatomic.so.1` 포함 |
| Linux arm64 runtime | `opensphere-setup-linux-arm64.tar.gz` | Node.js, PowerShell, kubectl, `libatomic.so.1` 포함 |
| macOS Intel runtime | `opensphere-setup-darwin-amd64.tar.gz` | Node.js, PowerShell, kubectl 포함 |
| macOS Apple Silicon runtime | `opensphere-setup-darwin-arm64.tar.gz` | Node.js, PowerShell, kubectl 포함 |
| 전체 체크섬 | `SHA256SUMS` | 설치기와 runtime 교차 검증 |

대상 호스트에 Node.js, npm, PowerShell, kubectl, libatomic 또는 GitHub CLI를 별도로 설치할 필요가 없다. Setup 저장소와 Setup Release 다운로드에도 GitHub 인증이 필요하지 않다.

Setup CLI 공개 정책과 Console 배포물 접근 정책은 분리한다. Console GHCR package가 private이면 `doctor`, `resolve`, `bootstrap`, `upgrade`에 read-only package credential을 표준 입력으로 전달한다. 토큰은 URL, argv, release lock, ConfigMap 또는 로그에 기록하지 않는다.

## 2. 설치

설치기는 세 가지 선택 방식을 제공한다.

| 선택 | 의미 |
|---|---|
| 옵션 없음 | 설치기 자체가 발행된 exact immutable Release 설치 |
| `--version <semver>` | 지정한 Setup CLI 버전의 exact immutable Release 설치 |
| `--channel <edge|candidate|stable>` | 공개 채널 포인터를 한 번 해석한 뒤 그 exact immutable Release 설치 |

`--version`과 `--channel`은 상호 배타적이다. 채널 포인터는 Setup CLI package 배포 선택자이며 Console OCI 채널이나 설치 lock을 대신하지 않는다. 현재 `edge`는 `setup-v0.5.0-edge.18`, `candidate`와 `stable`은 `HOLD`다. 설치가 끝난 뒤 Console 배포 채널은 `opensphere-setup doctor/bootstrap --release ...`로 별도 선택하고, Console exact release는 검증된 `--lock`으로 고정한다.

### 2.1 Windows amd64

Release 페이지에서 `Install-OpenSphereSetup.exe`를 내려받아 실행한다.

```powershell
.\Install-OpenSphereSetup.exe --channel edge
# 또는 exact Setup CLI 버전 고정
.\Install-OpenSphereSetup.exe --version 0.5.0-edge.18
opensphere-setup version
```

체크섬까지 명시적으로 확인하려면 다음 절차를 사용한다.

```powershell
$release = 'setup-v0.5.0-edge.18'
$base = "https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/$release"
Invoke-WebRequest -UseBasicParsing "$base/Install-OpenSphereSetup.exe" -OutFile .\Install-OpenSphereSetup.exe
Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile .\SHA256SUMS
$expected = ((Get-Content .\SHA256SUMS | Where-Object { $_ -match ' Install-OpenSphereSetup[.]exe$' }) -split '\s+')[0]
$actual = (Get-FileHash .\Install-OpenSphereSetup.exe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Windows installer checksum mismatch.' }
.\Install-OpenSphereSetup.exe
```

EXE는 exact tag의 공개 GitHub Release가 published·immutable인지 확인하고, `Install-OpenSphereSetup.ps1`의 GitHub asset digest를 검증한 뒤 실행한다. PowerShell 설치기는 Windows runtime archive의 GitHub digest와 `SHA256SUMS`를 다시 교차 검증한다. 검증된 runtime은 `%LOCALAPPDATA%\OpenSphere\Setup\<version>`에 설치되고 `%LOCALAPPDATA%\OpenSphere\bin\opensphere-setup.cmd`가 사용자 PATH에 등록된다.

현재 dge EXE는 Authenticode 서명 전 단계다. 조직 정책이나 SmartScreen이 실행을 차단하면 경고를 우회하지 말고, 위 SHA-256을 확인한 뒤 검토 가능한 PowerShell 대체 설치기를 사용한다. stable Windows 설치기 발행에는 신뢰 가능한 코드 서명 인증서와 서명 검증 gate가 필요하다. Visual Studio 설치 여부만으로 실행 파일의 게시자 신뢰가 생기지는 않는다.

### 2.2 Linux amd64/arm64 · macOS Intel/Apple Silicon

같은 셸 설치기가 OS와 CPU 아키텍처를 자동 판별한다. 실행 전에 설치기 자체의 체크섬을 확인한다.

```bash
set -eu
release=setup-v0.5.0-edge.18
base="https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/$release"
curl --fail --location --proto '=https' --tlsv1.2 \
  "$base/install-opensphere-setup.sh" --output install-opensphere-setup.sh
curl --fail --location --proto '=https' --tlsv1.2 \
  "$base/SHA256SUMS" --output SHA256SUMS
expected="$(awk '$2 == "install-opensphere-setup.sh" { print $1 }' SHA256SUMS)"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum install-opensphere-setup.sh | awk '{print $1}')"
else
  actual="$(shasum -a 256 install-opensphere-setup.sh | awk '{print $1}')"
fi
test -n "$expected" && test "$actual" = "$expected"
chmod +x install-opensphere-setup.sh
./install-opensphere-setup.sh --channel edge
# 또는 exact Setup CLI 버전 고정
./install-opensphere-setup.sh --version 0.5.0-edge.18
opensphere-setup version
```

기본 설치 위치는 Linux에서 `${XDG_DATA_HOME:-$HOME/.local/share}/opensphere/setup/<version>`, macOS에서 `$HOME/Library/Application Support/OpenSphere/Setup/<version>`이다. 명령 링크는 `$HOME/.local/bin/opensphere-setup`에 만든다. 이 경로가 PATH에 없으면 설치기가 추가할 `export PATH=...` 명령을 출력하며 셸 설정 파일을 임의로 수정하지 않는다. 설치 위치는 `OPENSPHERE_SETUP_INSTALL_ROOT`, 명령 디렉터리는 `OPENSPHERE_SETUP_BIN_DIR`로 명시할 수 있다.

### 2.3 Windows PowerShell 대체 경로

EXE 실행이 정책상 허용되지 않는 관리 호스트에서는 같은 immutable Release의 `Install-OpenSphereSetup.ps1`을 내려받아 SHA-256을 확인한 뒤 실행한다. 이 스크립트는 EXE가 호출하는 것과 동일한 설치 구현이다.

```powershell
.\Install-OpenSphereSetup.ps1 -Channel edge
# 또는 exact Setup CLI 버전 고정
.\Install-OpenSphereSetup.ps1 -Version 0.5.0-edge.18
opensphere-setup version
```

## 3. 무결성과 플랫폼 제약
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
