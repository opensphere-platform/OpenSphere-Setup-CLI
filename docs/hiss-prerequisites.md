# HISS 실행 준비물 적용기

상태: 로컬 후보 구현. `src/hiss-prerequisites.mjs`는 아직 CLI나 bootstrap에서 호출하지 않는다. 추가 권한 적용 요청은 승인 대기이며, 이 문서나 테스트 성공은 적용 승인이 아니다.

## 역할과 경계

Setup은 설치 시 고정된 실행 준비물만 마련한다. 이후 HISS 설치·관리 명령은 모듈이 제공하며 GUI·22·CLI가 OS Shell을 통해 기존 Cluster Manager에 요청한다. Setup 적용기에 Helm 실행, HISS 명령 목록, L4 설치 기능을 옮기지 않는다. Crossplane은 이 HISS 프로필에 없다.

후보는 HTTPS localhost / edge / docker-desktop 범위로 제한한다. 이는 개발 후보의 적용 범위이며 운영 환경 지원이나 사용자 권한 검증을 대신하는 정책이 아니다.

## 입력과 보존

- 원본: `OpenSphere-shell-clusterManager@43489ecf269d1630a1c912e68fd8da9f9fbff1b2`, `deploy/hiss-execution-profile.proposed.json`.
- 프로필: `hiss-chart-execution-v1`, 공개 Namespace·ServiceAccount·RBAC 54개. 정확한 바이트 SHA-256은 `2695b1a044d62c91946a74f05dc105190afb00cece0e4750cbeb8baec5be1f6b`다.
- 테스트 fixture에는 원본 revision/path/hash를 기록한다. 서명·해시 검사를 위해 Git 줄끝 변환을 금지한다. 다른 저장소 소스를 런타임에 import하지 않는다.
- Console을 통해 전달할 때는 Console 릴리스의 source revision을 사용해야 한다. 위 CM revision을 Console 저장소의 다운로드 revision으로 사용하면 안 된다. 아직 다운로드/릴리스 활성화 경로를 연결하지 않았다.
- 기존 Namespace의 PSA·레이블·주석을 보존한다. 기존 정책이 일치하는 SA/RBAC도 소유권 레이블을 바꾸지 않는다. Helm hook 수명주기를 가진 객체는 충돌로 처리한다.
- 기존 Ingress의 Helm 이력 전환은 별도 미완료다. 이 적용기의 기존 RBAC 보존만으로 Helm upgrade/rollback의 보존을 입증하지 않는다.

## 실행 결과

기본은 읽기 전용 사전검사다. 전체 54개와 외부 의존 자원 5개를 먼저 조회하며, 실패·잘못된 응답·중복 응답을 자원 부재로 해석하지 않는다. 기존 객체 충돌이나 외부 의존 자원 부재가 있으면 하나도 생성하지 않는다.

생성을 활성화하는 호출은 승인 후 통합할 별도 단계다. 후보 적용기는 Namespace → SA → Role → Binding 순서로 누락된 객체만 `create`한다. 각 단계에서 의존 자원과 기존 UID를 다시 확인한다. `apply`, `patch`, `replace`, `delete`는 제공하지 않는다.

생성 요청이 실패하면 정확한 객체를 한 번 재조회한다. 일치하는 객체가 관측되면 `observedAfterCreate`로 기록한다. 생성했다고 단정하거나 곧바로 재생성하지 않는다. 확인할 수 없으면 완료한 prefix를 증거에 남기고 중단한다. 재호출은 새 관측으로 누락분만 채우며 자동 rollback 삭제를 하지 않는다.

`Prepared`는 준비물 일치를 뜻한다. 모든 결과에 `installationComplete: false`를 유지한다. 최종 UID·정책·의존 자원 재검사를 통과해도 HISS 기능 검증, 22 설치 실행, L4 설치 완료를 뜻하지 않는다. Kubernetes 조회와 생성은 하나의 원자적 트랜잭션이 아니므로 검사 사이의 외부 변경을 완전히 차단한다고 주장하지 않는다.

## 검증과 현재 상태

2026-09-07:

- 격리 메모리 API 테스트 15개 통과: 전체 사전검사, 기존 자원 보존, 의존 순서, 정책/UID 변경, 잘못된 관측, 생성 시간 초과, 재시도, 최종 확인 실패, 명시 context와 get/create 제한.
- 실제 localhost 읽기 전용 사전검사: Namespace 1개 보존, SA/RBAC 5개 일치, 48개 누락, 충돌 0, 외부 의존 실패 0. 생성/변경/삭제 없음.
- Setup 전체 작업 트리 회귀 검사 343개 통과. `OPENSPHERE_CONSOLE_SOURCE`는 이미 고정된 `08db0e9d3489c6f995c5b7e999c4ca2d58f74e0b`의 별도 추출 fixture로 지정했다. 기본 경로의 다른 Console checkout을 사용한 첫 검사는 통과하지 않았다.
- 전체 제거 목록의 이전 미커밋 변경은 이번 적용기와 별개다. 이 프로필을 제거 목록에 자동으로 추가하지 않았다.

남은 통합: 권한 적용 승인, 검증된 릴리스별 준비물 전달·호환성, bootstrap 연결, 기존 Ingress의 데이터/권한 보존 전환, 실제 22 → OS Shell 설치·관리·실패 복구·멱등성 검증, 최종 발행·배포 및 Setup 재현.
