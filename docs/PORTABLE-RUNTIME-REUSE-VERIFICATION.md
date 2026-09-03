# Setup 런타임 재사용 및 기존 릴리스 정리 검증 — edge.20

검증 시각: 2026-09-03T01:32:41.5932954Z (UTC). 이 문서는 검증 당시 결과이며 이후 Kubernetes 상태를 보장하지 않는다.

정본: [독립 실행 계약](PORTABLE-EXECUTION-CONTRACT.md). 이전 edge.19의 매번 다운로드 정책은 폐기했다.

## 공개 배포

- 공개 불변 릴리스: [setup-v0.5.0-edge.20](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/tag/setup-v0.5.0-edge.20)
- 소스 commit: `b7235284a144208310cc75b7c57d8b1c0372b262`
- [발행 실행 33703707587](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33703707587): 5개 플랫폼 build와 publish 모두 성공
- 새 Windows EXE: **7,497,216 bytes**
- EXE SHA-256: `6af20efc8569583cfdfef146c750c7e8f1bc2bc6ac4064352c2b97315a468582`
- 첫 Windows ZIP: **173,873,139 bytes**
- ZIP 및 압축 해제한 파일 989개 보관: **634,903,500 bytes**, 약 605.5 MiB

## 동작 검증

Node 테스트 270개와 Go test/vet를 통과했다. Go 회귀 검사는 무다운로드 재사용, 정상·오류 종료 시 보존, 변조·누락·추가 파일·링크 거부, 동시 4개 준비 요청의 다운로드 1회 수렴, 버전 분리, 다운로드 실패 정리와 잠금 취소를 포함하며 전체 Go 검사를 3회 반복했다.

공개 EXE와 SHA256SUMS를 인증 없이 내려받아 GitHub digest·크기와 체크섬을 검증했다. Windows에서 실제 공개 EXE를 사용한 결과는 다음과 같다. 소요 시간은 이 PC에서 측정한 값이며 보장값이 아니다.

| 검사 | 종료 코드 | 런타임 다운로드 | 소요 초 | 결과 |
|---|---:|---:|---:|---|
| 버전 확인 | 0 | 0 | 1.52 | 통과 |
| 최초 Kubernetes 상태 조회 | 0 | 1 | 30.02 | 통과 |
| 동일 명령 재실행 | 0 | 0 | 3.44 | 통과 |
| 명령 오류 후 런타임 보존 | 1 | 0 | 2.98 | 통과 |
| EXE·런타임 폴더 이동 후 재사용 | 0 | 0 | 3.36 | 통과 |
| 예상하지 않은 DLL 추가 시 실행 차단 | 1 | 0 | 2.98 | 통과 |
| 추가한 파일 제거 후 정상 재사용 | 0 | 0 | 3.34 | 통과 |

재사용·명령 오류·폴더 이동 이후에도 보관된 모든 파일의 상대 경로·크기·수정 시각 목록이 같았다. 새로 압축을 풀거나 기존 파일을 덮어쓰지 않았다. 각 검사 뒤 .download staging 잔여는 0개였고, 사용자·시스템 PATH 및 LocalAppData의 OpenSphere/Setup·OpenSphere/bin 상태는 변하지 않았다. 테스트 전 두 호스트 설치 폴더는 없었다.

실제 Kubernetes 작업은 읽기 전용 status였다. bootstrap·upgrade·install-cli, 인증서 등록, 클러스터 변경은 수행하지 않았다. 사용자가 내려받아 보유한 EXE도 임의 교체하지 않았다.

로컬 상세 증거: `.release/public-portable-reuse-setup-v0.5.0-edge.20-33703707587/verification.json` 및 명령별 로그. 해당 경로는 Git 추적 대상이 아닌 로컬 산출물이다.

## 사용자가 요청한 기존 릴리스 삭제

2026-09-03 사용자의 '기존 릴리즈 모두 삭제' 지시에 따라, 새 공개 버전의 검증 완료 후 **이전 GitHub 릴리스 18개와 첨부 배포 파일 116개**를 삭제했다. 모든 DELETE 요청이 HTTP 204로 완료되었다. 삭제 직후 authenticated Releases API를 다시 조회하여 **edge.20 릴리스 하나, 자산 7개**만 남은 것을 확인했다.

| 삭제한 버전 | GitHub Release ID | 첨부 파일 |
|---|---:|---:|
| setup-v0.5.0-edge.19 | 381652847 | 7 |
| setup-v0.5.0-edge.18 | 381381956 | 9 |
| setup-v0.5.0-edge.9 | 359026454 | 7 |
| setup-v0.5.0-edge.8 | 359017099 | 7 |
| setup-v0.5.0-edge.16 | 359215766 | 7 |
| setup-v0.5.0-edge.14 | 359085290 | 7 |
| setup-v0.5.0-edge.13 | 359078076 | 7 |
| setup-v0.5.0-edge.12 | 359069137 | 7 |
| setup-v0.5.0-edge.11 | 359066642 | 7 |
| setup-v0.5.0-edge.10 | 359027884 | 7 |
| setup-v0.5.0-edge.7 | 358869038 | 7 |
| setup-v0.5.0-edge.6 | 358862032 | 7 |
| setup-v0.5.0-edge.5 | 358792962 | 6 |
| setup-v0.5.0-edge.3 | 358713587 | 6 |
| setup-v0.5.0-edge.2 | 358708329 | 6 |
| setup-v0.5.0-edge.1 | 358705143 | 6 |
| setup-v0.4.0-edge.3 | 358609515 | 3 |
| setup-v0.4.0-edge.2 | 358597565 | 3 |

삭제 범위는 OpenSphere-Setup-CLI 저장소의 GitHub Release와 첨부 파일이다. Git 태그·commit·브랜치, Console 등 다른 저장소, 로컬 기존 다운로드와 레거시 프로젝트는 삭제하지 않았다. 삭제한 버전의 Release 기반 다운로드·실행 선택은 더 이상 사용할 수 없다. 과거 검증 문서의 옛 Release 링크는 역사적 식별 정보다.

## 현재 사용 조건

- 기존 edge.19 EXE는 매번 다운로드 로직이 그대로 있으므로 새 edge.20 EXE로 한 번 교체해야 한다.
- EXE 옆 opensphere-setup-runtime 폴더를 함께 보관한다. 같은 버전이면 이후 런타임 다운로드는 없다.
- 작은 채널·Release 메타데이터 조회와 전체 파일 검증은 매번 수행한다. 완전 오프라인 실행기는 아니다.
- 내부 약 99MiB Node runtime은 경량화하지 않았다. 최초 다운로드와 디스크 보관 비용은 남는다.
- Windows Authenticode 서명·macOS Developer ID 공증은 미완료이며 candidate/stable은 HOLD다.
