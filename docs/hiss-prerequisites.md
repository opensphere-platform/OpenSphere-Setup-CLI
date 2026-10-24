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

## 노드 재부팅 조율 준비물 (2026-10-22)

설계: `foundation-decoupling-20261011/node-maintenance/NODE-REBOOT-COORDINATION-DESIGN-20261022.md`. 대표 결정 "모두 권고안대로 (권장)", 유지보수 창 매일 02:00–06:00 KST.

- 원본: Cluster Manager `deploy/hiss-node-maintenance.yaml`. Setup은 `src/hiss-node-maintenance-artifact.json`에 바이트를 고정하고 sha256으로 확인한다(`NODE_MAINTENANCE_SOURCE`).
- 객체 17개: namespace `opensphere-node-maintenance`, kured SA·ClusterRole·잠금 Role, Cluster Manager 실행 Role 셋(새 namespace, `monitoring`의 NetworkPolicy 하나, `opensphere-console`의 작업 기록 하나), kured에 Prometheus만 들어오게 하는 NetworkPolicy, admission 정책 둘과 binding 둘.
- `prepare-hiss`(계획)는 읽기만 한다. `monitoring`·`opensphere-console` namespace가 없으면 `Blocked`, 객체가 없으면 `NeedsPreparation`, 일부만 있거나 울타리 정책의 match·변수·검증이 다르면 `NeedsUpdate`, 같으면 `Present`.
- `prepare-hiss --apply`는 server-side apply(`opensphere-setup-hiss`, conflict 강제 안 함)를 두 번 한다. 울타리 정책이 먼저, 권한은 그다음이다. 울타리 적용이 실패하면 권한은 적용하지 않는다.
- 다른 HISS 실행 프로필과 달리 server-side apply다. 승인 kured digest가 바뀌면 울타리 정책을 제자리에서 고쳐야 하기 때문이다. 다른 field manager가 가진 필드는 conflict로 멈춘다.
- 새 설치 경로(bootstrap)는 아직 이 준비물을 적용하지 않는다. 설치된 클러스터에 `prepare-hiss`로 적용한다.

## 경보·백업 준비물과 보안 입력 (RKE2 준비 R1, 2026-10-24)

계획: `rke2-readiness-audit-20261024/01-NEXT-STAGE-PLAN-20261024.md` R1-4·R1-5. 대표 승인 "전부 승인 (권장)".

- **경보·백업 권한**: 원본은 Cluster Manager `deploy/hiss-backup-alerting.yaml`. Setup은 `src/hiss-backup-alerting-artifact.json`에 바이트를 고정한다(`BACKUP_ALERTING_SOURCE`).
  - `monitoring`: 핵심 경보 규칙 `opensphere-core-alerts` 갱신, 비상 경로 AlertmanagerConfig `opensphere-alert-emergency` 하나, 같은 이름 Secret 읽기, Alertmanager 객체 읽기(matcher strategy 확인). 이 쓰기는 2026-10-24 검토 뒤 대표가 승인했다.
  - `longhorn-system`(Longhorn이 있을 때만): default 백업 대상 갱신, 반복 작업, 백업 읽기, 볼륨 라벨 갱신. 반복 작업의 `retain`을 줄이면 Longhorn이 오래된 백업을 지운다(BK-P6 허용 범위).
  - admission 정책 다섯이 이 쓰기를 검토된 모양으로 묶는다. 정책을 먼저, 권한을 그다음에 적용한다.
  - Secret 쓰기 권한은 주지 않는다. Secret은 아래 보안 입력으로 Setup이 쓴다.
- **경보 울타리가 막는 것과 못 막는 것**
  - 막는 것: 이름이 다른 AlertmanagerConfig, 다른 Secret을 참조하는 수신처, URL을 직접 쓰는 webhook, HTTP 클라이언트 설정, 경보를 누르는 inhibit·mute, 기록되지 않은 SMTP 서버·발신자·수신자. CM이 비상 Secret과 기록값 ConfigMap을 바꾸는 것도 막는다.
  - **못 막는 것**: RKE2의 CM 계정은 이미 kube-prometheus-stack 실행 Role(`opensphere-hiss-kube-prometheus-stack-executor`)로 `monitoring`의 모든 Secret을 읽고 쓰고, Alertmanager 객체와 차트 PrometheusRule을 고칠 수 있다. 이 경로로는 다른 Secret을 읽거나 Alertmanager 자체 구성을 바꿀 수 있다. "경보 경로로 새지 않음"은 **CM 특권 쓰기 울타리(D-F, CM #32 / Setup #45)와 함께일 때만** 성립한다.
  - 실험실에서 그 실행 Role을 RKE2와 똑같이 붙이고 시험했다. 결과는 `rke2-readiness-audit-20261024/r1-cm-setup-lab-20261024/`.
- **Longhorn 울타리 단계**: 세 Longhorn binding은 처음에 `[Warn, Audit]`로 적용된다. 정책은 Longhorn mutating webhook을 거친 뒤의 객체를 보는데, 그 webhook이 기본값을 더하면 CM의 정상 쓰기가 거절될 수 있기 때문이다.
  - CM의 쓰기 결과(`hiss.backup.*`)는 경고를 `admissionWarnings`로 돌려준다.
  - RKE2에서 첫 `backup.target.set`, `backup.job.apply`, `backup.volume.assign`(지정과 해제)이 경고 없이 끝나면 `opensphere-setup prepare-hiss --apply --backup-fences deny`로 `[Deny]`로 올린다. `--backup-fences warn`은 되돌린다.
  - 옵션 없이 다시 적용해도 이미 `[Deny]`인 binding은 그대로 둔다.
  - 경보 binding 둘은 처음부터 `[Deny]`다.
- **수집 허용 NetworkPolicy**: 원본은 `deploy/hiss-scrape-access.yaml`(`SCRAPE_ACCESS_SOURCE`). ingress-nginx·cert-manager에 Prometheus를 들이는 정책 둘이다.
  - 다른 정책이 이미 그 Pod를 격리할 때만 적용한다. 격리가 없는 namespace에 이 정책을 넣으면 80/443과 webhook이 막힌다. 그래서 그때는 `NotNeeded`다.
  - Setup이 넣은 정책만 남아 혼자 격리하게 되면 `IsolatesAlone`으로 알리고, `--apply`에서 지운다.
  - 2026-10-24 RKE2 읽기 결과: 두 namespace 모두 `NotNeeded`.
- **보안 입력** `prepare-hiss-secret`: 값은 stdin의 JSON 하나로만 받는다. 인자·출력·오류에 값이 나오지 않는다. kubectl 오류는 진단을 지우고 종료 코드만 알린다.
  - `alert-emergency` → `monitoring/opensphere-alert-emergency`. Slack(`hooks.slack.com`만) 또는 SMTP(DNS 이름만), 선택 dead-man URL(https). 만료는 최대 2026-11-30.
    - 비밀이 아닌 값(수신 종류, SMTP 서버·발신자·수신자)은 ConfigMap `monitoring/opensphere-alert-emergency-allowed`에도 쓴다. 경보 울타리의 parameter다. 이것이 없으면 CM의 AlertmanagerConfig 쓰기는 모두 거절된다.
    - `--clear`는 Secret을 지우고 ConfigMap은 `receiver-kind: none`으로 남긴다. 그래야 CM이 경로를 지울 수 있다.
  - `backup-store --name <n>` → `longhorn-system/opensphere-backup-<n>`. Longhorn S3 키(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINTS`, 선택 `AWS_CERT`·`VIRTUAL_HOSTED_STYLE`). 끝점은 DNS 이름이나 IPv4 주소다(사내 S3가 주소만 있을 수 있다).
  - `etcd-s3` → `kube-system/opensphere-etcd-s3`. RKE2 `etcd-s3-config-secret` 키(`etcd-s3-endpoint` 등). master `config.yaml` 변경은 따로 하는 호스트 작업이다.
  - `--clear --confirm <Secret 이름>`으로 지운다.
  - 대상 Secret에 client-side `kubectl apply`가 남긴 `kubectl.kubernetes.io/last-applied-configuration`(옛 값)이 있으면 새 값을 쓰기 전에 지운다.

```sh
# 예: 비상 수신처(Slack). 파일은 관리자만 읽을 수 있는 곳에 두고, 쓴 뒤 지운다.
opensphere-setup prepare-hiss-secret alert-emergency --context rke2 < emergency.json
# 그다음 OS Shell: cluster-manager.hiss.alerts.apply part=emergency
```
