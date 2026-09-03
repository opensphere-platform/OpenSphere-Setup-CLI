# Setup 포터블 공개 실행 검증 — 0.5.0-edge.19

검증 시각: 2026-09-03 09:38 KST. 이 문서는 해당 시점의 증거이며 이후 환경의 건강 상태를 보장하지 않는다.

기준: [독립 실행 계약](PORTABLE-EXECUTION-CONTRACT.md).

## 배포 식별

- 공개 불변 릴리스: [setup-v0.5.0-edge.19](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/tag/setup-v0.5.0-edge.19)
- 소스 commit: `669a4058de3cd14cb180ac25695a18bd529ea654`
- [발행 실행 33700026861](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33700026861): Windows amd64, Linux amd64/arm64, macOS amd64/arm64 및 publish 모두 성공
- 공개 자산 7개: 플랫폼 런타임 아카이브 5개, Windows 온라인 실행기 1개, SHA256SUMS
- Windows 온라인 실행기: **7,464,960 bytes**
- 실행기 SHA-256: `ba8622c590bbaec9241fda8c64df13284d6b9ffbc5a342d89e2916c38c6f5777`
- Windows 런타임 ZIP: **173,873,139 bytes**

기존 설치형 edge.18 릴리스는 수정하지 않았다. 새 Windows 기본 파일은 `Install-OpenSphereSetup.exe`가 아니라 `opensphere-setup.exe`다.

## 검증 결과

로컬 Node 테스트 270개, Go test/vet, 복구 기록 동시성 회귀 반복 30회를 통과했다. 최초 다중 플랫폼 빌드에서 발견된 임시 복구 기록 동시 삭제 경합은 최종 기록의 동일성을 재검증하는 조건으로 수정했다. 최종 기록 손실·변조·권한 오류를 차단하는 회귀 검사도 포함한다.

GitHub 로그인이나 토큰 없이 공개 실행기와 체크섬을 내려받고, Release asset digest·크기·SHA256SUMS를 대조한 후 아래 명령을 실행했다.

| 검사 | 종료 코드 | 결과 |
|---|---:|---|
| `version` | 0 | 빌드에 결속된 0.5.0-edge.19 확인 |
| `--channel edge version` | 0 | 공개 채널에서 같은 릴리스 선택 |
| `--channel candidate version` | 1 | HOLD를 정상 차단 |
| `--channel edge status --context docker-desktop` | 0 | 임시 런타임으로 실제 Kubernetes 상태 조회 성공 |
| `--version 0.5.0-edge.19 doctor --release unsupported` | 1 | 잘못된 명령 옵션 거부 후 정리 |

모든 검사에서 사용자·시스템 PATH는 바뀌지 않았다. 검사 전에 없던 `%LOCALAPPDATA%/OpenSphere/Setup`과 `OpenSphere/bin`은 검사 후에도 없었다. 정상 명령과 오류 명령 모두 이번 실행이 만든 `opensphere-setup-run-*` 임시 디렉터리가 남지 않았다. 예상 오류 종료 코드 1은 테스트 통과 조건이며, 검증기 자체의 실패와 구분했다.

실제 동작 검증에서 bootstrap/upgrade/install-cli는 실행하지 않았다. Kubernetes 자원 변경, 인증서 등록, 기존 다운로드 파일 삭제도 하지 않았다. bootstrap/upgrade의 os CLI 자동 설치 제거와 인증서 신뢰 등록의 명시 옵션 요구는 코드 및 테스트로 검증했다.

로컬 세부 증거: `.release/public-portable-verification-setup-v0.5.0-edge.19-33700026861/verification.json` 및 같은 폴더의 명령별 로그. 이 경로는 Git 추적 대상이 아닌 로컬 검증 산출물이다.

## 남아 있는 한계

- **무설치 온라인 실행기**다. 모든 의존성을 내장한 경량 오프라인 단일 EXE가 아니다.
- 작업마다 약 174MB ZIP을 임시로 내려받는다. 내부 약 99MiB Node SEA 및 PowerShell/kubectl 용량은 남아 있다.
- 강제 종료·전원 장애 시 임시 파일이 남을 수 있다. 다른 실행의 파일을 임의 삭제하지 않는다.
- Windows Authenticode 서명과 macOS Developer ID 공증은 미완료다. edge는 사전 검증 채널이며 candidate/stable은 HOLD를 유지한다.
- 이 검증은 Windows에서 공개 온라인 실행 경로를 확인했다. Linux/macOS는 CI의 각 네이티브 런타임 smoke test까지 확인한 범위다.
