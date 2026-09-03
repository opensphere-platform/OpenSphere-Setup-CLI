# 공개 GitHub Release 기반 Setup CLI 무설치 실행

Setup은 필요할 때 실행하는 독립형 관리 도구다. Windows에 Setup을 설치하거나 PATH, 서비스, 시작 프로그램을 등록하지 않는다. 설치 대상은 Kubernetes의 Console이며 실행 호스트가 아니다.

정본: [PORTABLE-EXECUTION-CONTRACT.md](PORTABLE-EXECUTION-CONTRACT.md).

## 배포 자산

| 자산 | 실행 방식 |
|---|---|
| `opensphere-setup.exe` | Windows amd64 단일 온라인 실행기. 검증된 런타임을 임시 실행하고 종료 시 정리 |
| `opensphere-setup-windows-amd64.zip` | Windows 자체 포함 포터블 폴더 |
| `opensphere-setup-linux-amd64.tar.gz`, `opensphere-setup-linux-arm64.tar.gz` | Linux 포터블 폴더 |
| `opensphere-setup-darwin-amd64.tar.gz`, `opensphere-setup-darwin-arm64.tar.gz` | macOS 포터블 폴더 |
| `SHA256SUMS` | 모든 자산 SHA-256 |

아카이브에는 Node.js, PowerShell, kubectl과 Linux용 `libatomic.so.1`이 포함된다. Node.js, npm, PowerShell, kubectl, libatomic을 호스트에 별도로 설치할 필요가 없다. 온라인 실행기는 이를 실행 때마다 TEMP에 받는다. 영구 캐시는 없다.

**용량은 아직 줄어들지 않았다.** 작은 온라인 EXE도 작업할 때 약 170MB의 압축 런타임을 내려받고 약 440MiB를 푼다. 임시 공간은 1GiB 이상 확보한다. 내부 Node SEA는 여전히 약 99MiB다. 이번 변경은 무설치 실행이며 네이티브 재작성·런타임 경량화 완료를 뜻하지 않는다.

## Windows 단일 EXE

`setup-v0.5.0-edge.19`부터 사용한다. 기존 `Install-OpenSphereSetup.exe`, `Install-OpenSphereSetup.ps1`, `install-opensphere-setup.sh`는 설치형 배포물이므로 새 릴리스에서 제외한다. 이전 immutable 릴리스는 변경하지 않는다.

```powershell
$release = 'setup-v0.5.0-edge.19'
$base = "https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/$release"
Invoke-WebRequest -UseBasicParsing "$base/opensphere-setup.exe" -OutFile .\opensphere-setup.exe
Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile .\SHA256SUMS
$expected = ((Get-Content .\SHA256SUMS | Where-Object { $_ -match ' opensphere-setup[.]exe$' }) -split '\s+')[0]
$actual = (Get-FileHash .\opensphere-setup.exe -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $expected -or $actual -ne $expected) { throw 'Launcher checksum mismatch.' }

.\opensphere-setup.exe version
.\opensphere-setup.exe --channel edge doctor --release edge --context docker-desktop --storage-class hostpath
.\opensphere-setup.exe --version 0.5.0-edge.19 bootstrap --release edge --context docker-desktop --storage-class hostpath
```

파일 위치에서 실행한다. 권한 상승, LocalAppData 설치, command shim, PATH 등록은 없다. `help`와 기본 `version`은 런타임 다운로드 없이 실행된다. 나머지 명령은 immutable Release의 ZIP을 GitHub asset digest와 SHA256SUMS로 검증한 뒤 안전하게 푼다. 자식 CLI의 stdin·stdout·stderr, 종료 코드와 호출자의 cwd를 유지한다.

## 버전과 채널

| 옵션 | 의미 |
|---|---|
| 생략 | 다운로드한 실행기가 결속된 exact 릴리스 |
| `--version <semver>` | 지정한 Setup 릴리스 |
| `--channel <edge|candidate|stable>` | 공개 채널 포인터를 한 번 해석한 exact 릴리스 |

두 선택자는 상호 배타적이며 명령 앞에 둔다. 명령 뒤의 Console `--release`와 검증된 `--lock`은 별개다. `candidate`와 `stable`은 HOLD다. 이전 자동 호스트 설치 정책 runtime은 거부한다. 새 runtime manifest의 `hostInstallation: explicit-only`가 필수다.

## 압축형 포터블 실행

Windows는 ZIP을 원하는 폴더에 풀고 그 안에서 `.\opensphere-setup.exe`를 실행한다. `runtime` 폴더를 함께 보존한다. 사용 후 폴더를 지우면 된다. 이 폴더 내부 EXE는 단독 파일이 아니라 동봉 런타임을 이용하는 실제 CLI다.

Linux/macOS는 해당 OS·CPU 아카이브와 SHA256SUMS를 검증하고 압축을 푼다.

```bash
release=setup-v0.5.0-edge.19
asset=opensphere-setup-linux-amd64.tar.gz
base="https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/$release"
curl --fail --location --proto '=https' --tlsv1.2 "$base/$asset" --output "$asset"
curl --fail --location --proto '=https' --tlsv1.2 "$base/SHA256SUMS" --output SHA256SUMS
expected="$(awk -v name="$asset" '$2 == name { print $1 }' SHA256SUMS)"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$asset" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$asset" | awk '{print $1}')"
fi
test -n "$expected" && test "$actual" = "$expected"
tar -xzf "$asset"
./opensphere-setup-linux-amd64/opensphere-setup version
```

macOS는 `darwin-amd64` 또는 `darwin-arm64`, Linux arm64는 `linux-arm64`로 바꾼다. 링크 생성, 사용자 데이터 디렉터리 설치, shell profile 수정은 필요 없다. 아카이브는 런타임의 사전 준비용이며 Console 이미지·소스까지 오프라인으로 제공하지는 않는다.

## 명시적인 호스트 변경과 보안

- `bootstrap`과 `upgrade`는 호스트의 `os` CLI를 자동 설치하지 않는다.
- 필요한 운영자만 `install-cli`를 별도로 실행한다. `--add-to-path`, `--install-dir`은 이 명령에만 허용한다.
- Windows 개발 CA 신뢰는 `bootstrap --trust-local-ca`를 명시한 경우에만 현재 사용자 인증서 저장소를 변경한다. 생략 시 자동 신뢰 등록을 하지 않으며 TLS 검증 우회로 대체하지 않는다.
- Kubernetes 자원, 작업 디렉터리의 release lock, 요청한 복구 산출물은 작업 결과다. 프로그램 설치 파일과 구분하며 임의 삭제하지 않는다.
- 공개 Setup 다운로드는 인증 없이 가능하다. private Console GHCR package는 read-only credential을 stdin으로 전달한다. candidate/stable OCI attestation에는 별도 `gh`가 필요하다.
- edge Windows EXE는 아직 Authenticode 서명 전이다. SmartScreen/조직 정책을 우회하지 않는다. macOS ad-hoc 서명은 Developer ID notarization을 대체하지 않는다. 서명·공증 전 candidate/stable 발행은 차단한다.
