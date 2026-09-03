# 공개 GitHub Release 기반 Setup CLI 무설치 실행

Setup은 필요할 때 실행하는 독립형 관리 도구다. Windows에 Setup을 설치하거나 PATH, 서비스, 시작 프로그램을 등록하지 않는다. 설치 대상은 Kubernetes의 Console이며 실행 호스트가 아니다.

정본: [PORTABLE-EXECUTION-CONTRACT.md](PORTABLE-EXECUTION-CONTRACT.md).

## 배포 자산

| 자산 | 실행 방식 |
|---|---|
| `opensphere-setup.exe` | Windows amd64 포터블 실행기. 버전별 런타임을 한 번 받아 EXE 옆에 보관·재사용 |
| `opensphere-setup-windows-amd64.zip` | Windows 자체 포함 포터블 폴더 |
| `opensphere-setup-linux-amd64.tar.gz`, `opensphere-setup-linux-arm64.tar.gz` | Linux 포터블 폴더 |
| `opensphere-setup-darwin-amd64.tar.gz`, `opensphere-setup-darwin-arm64.tar.gz` | macOS 포터블 폴더 |
| `SHA256SUMS` | 모든 자산 SHA-256 |

아카이브에는 Node.js, PowerShell, kubectl과 Linux용 `libatomic.so.1`이 포함된다. Node.js, npm, PowerShell, kubectl, libatomic을 호스트에 별도로 설치할 필요가 없다. 실행기는 이를 버전마다 한 번만 받아 EXE 옆의 `opensphere-setup-runtime/<release-tag>/`에 ZIP과 압축 해제한 런타임을 보관한다. 같은 버전은 재다운로드·재압축 해제 없이 검증 후 재사용한다.

**내부 런타임 용량은 아직 줄어들지 않았다.** 처음 사용하는 버전은 약 174MB ZIP을 내려받고 약 440MiB를 푼다. 무결성 검증을 위한 원본 ZIP까지 보관하므로 버전당 약 610MiB를 사용한다. 새 버전 준비 시 1GiB 이상 여유 공간을 확보한다. 내부 Node SEA는 여전히 약 99MiB다. 이번 변경은 반복 다운로드 제거이며 네이티브 재작성 완료를 뜻하지 않는다.

## Windows 단일 EXE

`setup-v0.5.0-edge.20`부터 같은 버전의 런타임을 재사용한다. edge.19 EXE는 자동으로 이 동작으로 바뀌지 않으므로 아래 새 EXE로 한 번 교체한다. 기존 `Install-OpenSphereSetup.exe`, `Install-OpenSphereSetup.ps1`, `install-opensphere-setup.sh`는 설치형 배포물이므로 새 릴리스에서 제외한다. 이전 릴리스 18개는 사용자 요청으로 삭제했다. 현재 edge.20만 다운로드할 수 있다. Git 태그는 유지했다.

```powershell
$release = 'setup-v0.5.0-edge.20'
$base = "https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/$release"
Invoke-WebRequest -UseBasicParsing "$base/opensphere-setup.exe" -OutFile .\opensphere-setup.exe
Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile .\SHA256SUMS
$expected = ((Get-Content .\SHA256SUMS | Where-Object { $_ -match ' opensphere-setup[.]exe$' }) -split '\s+')[0]
$actual = (Get-FileHash .\opensphere-setup.exe -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $expected -or $actual -ne $expected) { throw 'Launcher checksum mismatch.' }

.\opensphere-setup.exe version
.\opensphere-setup.exe --channel edge doctor --release edge --context docker-desktop --storage-class hostpath
.\opensphere-setup.exe --version 0.5.0-edge.20 bootstrap --release edge --context docker-desktop --storage-class hostpath
```

파일 위치에서 실행한다. 권한 상승, LocalAppData 설치, command shim, PATH 등록은 없다. `help`와 기본 `version`은 런타임 다운로드 없이 실행된다. 나머지 명령은 채널·immutable Release 메타데이터를 온라인으로 확인한다. 처음 쓰는 버전만 ZIP을 GitHub asset digest와 SHA256SUMS로 검증해 푼다. 재사용 시 보관 ZIP·체크섬의 digest와 모든 런타임 파일의 SHA-256을 원본 ZIP과 대조하고 추가 파일·링크·누락·변조를 거부한다. 자식 CLI의 stdin·stdout·stderr, 종료 코드와 호출자의 cwd를 유지한다.

## 버전과 채널

| 옵션 | 의미 |
|---|---|
| 생략 | 다운로드한 실행기가 결속된 exact 릴리스 |
| `--version <semver>` | 지정한 Setup 릴리스 |
| `--channel <edge|candidate|stable>` | 공개 채널 포인터를 한 번 해석한 exact 릴리스 |

두 선택자는 상호 배타적이며 명령 앞에 둔다. 명령 뒤의 Console `--release`와 검증된 `--lock`은 별개다. `candidate`와 `stable`은 HOLD다. 이전 자동 호스트 설치 정책 runtime은 거부한다. 새 runtime manifest의 `hostInstallation: explicit-only`가 필수다.

## 보관·이동·정리

보관 위치는 현재 작업 폴더가 아니라 **EXE가 있는 폴더**다.

```text
opensphere-setup.exe
opensphere-setup-runtime/
  setup-v0.5.0-edge.20.lock
  setup-v0.5.0-edge.20/
    runtime.zip
    SHA256SUMS
    expanded/opensphere-setup-windows-amd64/...
```

- 같은 버전의 동시 최초 실행은 준비 잠금을 공유하여 한 번만 다운로드한다. 준비가 끝나면 명령은 동시에 실행할 수 있다. 빈 lock 파일은 잠금 상태가 아니며 프로세스가 종료되면 OS 잠금도 해제된다.
- 정상·오류 명령 종료 후에도 완성된 런타임은 남는다. 다운로드 실패 시 해당 실행의 미완성 폴더만 정리한다. 강제 종료 시 남은 `.download-*` 폴더는 재사용하지 않는다.
- 파일이 손상됐으면 실행을 차단하고 정확한 버전 경로를 안내한다. 모든 Setup 명령을 종료한 뒤 그 버전 폴더만 지우고 다시 실행하면 받는다. 다른 버전은 건드리지 않는다.
- EXE와 보관 폴더를 함께 이동한다. 제거할 때도 모든 명령을 종료한 뒤 이 두 항목을 지우면 된다. 작업 결과나 Kubernetes 자원을 지우는 기능이 아니다.
- EXE 위치에 쓰기 권한이 없으면 쓰기 가능한 폴더로 옮긴다. 관리자 권한 요청·LocalAppData 설치·숨은 공용 캐시로 대체하지 않는다.
- 재사용하더라도 작은 Release 메타데이터 조회는 필요하다. 인터넷 없이 런타임을 직접 시작하려면 아래의 사전 다운로드 압축형 포터블을 사용한다. 실제 Kubernetes·이미지·GitHub 작업에는 해당 연결이 별도로 필요할 수 있다.

## 압축형 포터블 실행

Windows는 ZIP을 원하는 폴더에 풀고 그 안에서 `.\opensphere-setup.exe`를 실행한다. `runtime` 폴더를 함께 보존한다. 사용 후 폴더를 지우면 된다. 이 폴더 내부 EXE는 단독 파일이 아니라 동봉 런타임을 이용하는 실제 CLI다.

Linux/macOS는 해당 OS·CPU 아카이브와 SHA256SUMS를 검증하고 압축을 푼다.

```bash
release=setup-v0.5.0-edge.20
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
