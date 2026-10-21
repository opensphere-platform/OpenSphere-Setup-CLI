# Argo CD 관측 준비 — 2026-10-21

이 신규 Setup 전용 entrypoint는 기존 승인된 Core 준비의 target/권한 guard를 수정하지 않는다.
준비 코드의 단일 원본은 Platform Support의 `tools/prepare-argocd-observer.cjs`이며,
Setup은 12개 순수 의존성 자산을 `vendor/argocd-observer/manifest.json`의 고정 SHA-256으로
검증한 뒤 실행한다. 임의 script/manifest/URL/토큰 입력은 지원하지 않는다.

실행 위치: `OpenSphere-Setup-CLI`. 현재 entrypoint는 다음과 같다.

```powershell
node src/cli.mjs prepare-argocd-observer --mode plan ...
```

주 CLI `prepare-argocd-observer` dispatch와 ncc/SEA 자산 packaging을 포함한다.
기존에 발행된 `opensphere-setup.exe`가 이미 갱신되었다는 뜻은 아니다.
깨끗한 Setup checkout에서 이 변경만 검증하고 새 binary를 발행해야 한다.
기존 작업 checkout의 knowledge/journal 등 다른 미커밋 변경을 묶어 발행하지 않는다.

## 기본 인자

아래는 승인된 RKE2 대상의 공개 식별자와 검증한 도구 hash다. 개인 자격증명은 인자로 주지 않는다.

```powershell
$observerArgs = @(
  '--kubeconfig', 'C:/Users/cmars/.kube/rke2.yaml',
  '--context', 'rke2',
  '--expected-cluster-uid', '8cdee47b-abb7-4dba-b989-cf9ca292efcb',
  '--argocd', 'C:/Users/cmars/AppData/Local/Temp/opensphere-argocd-cli-3.4.2/argocd-windows-amd64.exe',
  '--argocd-sha256', '430fbb627c71465e0d076653b6b9b8785c1bbbb1e49aafb36df174327e5db918',
  '--openssl', 'C:/Program Files/Git/usr/bin/openssl.exe',
  '--openssl-sha256', '78340fb01dea2df5caab73dcf28833b31329226a4c9e02f717f1d399592265b9'
)
$plan = node src/cli.mjs prepare-argocd-observer @observerArgs --mode plan | ConvertFrom-Json
$plan
```

`plan`은 공개 메타데이터·정책·공개 TLS 인증서만 읽는다. 토큰, Secret data, 개인 로그를
출력하지 않는다. UID/RV와 비밀이 아닌 content digest, tool hash, 정책·권한 변경이 plan에 들어간다.
적용은 반드시 방금 확인한 `planDigest`로 한다. 각 단계 뒤에는 다시 plan을 생성해야 한다.

## 기존 설치의 순서

1. **호환 PSSS를 먼저 제품 경로로 배포한다.** 구 v2/v3 artifact와 정확한 legacy/reduced Role만
   일시 호환하며, Core는 서명 Secret을 GET하거나 POST하지 않는다.
2. 현재 서버 TLS가 메모리에서만 생성되고 저장된 공개 cert가 없다면, 먼저 전용 영속 TLS를 준비한다.
   기존 TLS Secret은 덮어쓰지 않는다. 90일 RSA-3072 self-signed serving cert의 SAN은
   `argocd-server.argocd.svc`, `argocd-server.argocd.svc.cluster.local` 두 개다.

   ```powershell
   node src/cli.mjs prepare-argocd-observer @observerArgs --mode tls-prepare --approve-plan $plan.planDigest
   ```

   개인키와 cert는 고정 hash OpenSSL의 stdout에서 프로세스 메모리로만 받아
   `argocd/argocd-server-tls`에 stdin으로 저장한다. 개인키 파일·certificate store를 만들지 않는다.
   Argo 표준 TLS Secret watch를 재사용한다. TLS reload 및 서버 재기동 후 동일 cert 사용은
   운영 검증의 필수 항목이다. HTTP나 인증서 검증 해제를 대안으로 사용하지 않는다.
3. 최신 plan을 다시 읽고, 실제 `Current`인 호환 PSSS source commit과 image digest를 명시하여 준비한다.

   ```powershell
   $plan = node src/cli.mjs prepare-argocd-observer @observerArgs --mode plan | ConvertFrom-Json
   node src/cli.mjs prepare-argocd-observer @observerArgs --mode apply --approve-plan $plan.planDigest --compat-source '<실제 Current source 40자리>' --compat-digest 'sha256:<실제 Current image 64자리>'
   ```

   PSSS observer 계정은 `apiKey`만 허용하며 로그인·기본 readonly/admin 상속이 없다.
   승인된 실제 Application/project 쌍, repository URL, local cluster만 읽는다. 로그는 demo 한 앱만이다.
   Foundation의 Registration get 명단도 현재 승인 Application inventory에서 생성한다.
   shared Console workload/Secret list나 새로운 target workload list/watch는 부여하지 않는다.

   CLI `--core`는 원본 kubeconfig를 변경하지 않는다. 공개 cluster/user 참조와 namespace만 담은
   임시 context overlay를 원본 KUBECONFIG와 병합하며, overlay에는 키·인증서·토큰을 넣지 않는다.
   임시 파일은 사용 직후 제거한다. 서버의 인증 비활성 설정을 바꾸지 않는다.
4. namespace 범위 controller 권한과 자동 생성된 local-cluster cache 범위가 다르면,
   namespace를 고정한 local cluster descriptor를 별도 준비한다. 권한을 늘려서 해결하지 않는다.

   ```powershell
   $plan = node src/cli.mjs prepare-argocd-observer @observerArgs --mode plan | ConvertFrom-Json
   $plan.clusterScope
   node src/cli.mjs prepare-argocd-observer @observerArgs --mode cluster-scope --approve-plan $plan.planDigest
   ```

   `argocd/opensphere-local-namespace-cluster` Secret 한 개를 create-only로 준비한다.
   Secret은 Argo cluster descriptor의 표준 저장 형식이며 인증정보를 담지 않는다.
   `server=https://kubernetes.default.svc`, `config={}`, `clusterResources=false`로 고정하고,
   namespace는 승인된 실제 Application inventory에서 도출한다. 현재 허용 집합은
   `opensphere-console`, `opensphere-platform-delivery`뿐이다. namespace를 임의 인자로
   확장할 수 없다. 기존 controller ServiceAccount와 RBAC를 재사용하며 새 권한·토큰·
   인증서 발급 또는 observer token 회전은 없다.

   plan은 descriptor의 UID/RV와 공개 내용 digest를 묶는다. 다른 소유자, 중복 local
   descriptor, credential 필드, 넓어진 namespace, `clusterResources=true` 및 plan 이후
   변경은 거부한다. 정확히 일치하는 기존 Setup descriptor면 Noop이다. create 전 server
   dry-run과 대상 cluster UID 재검사를 수행한다. 이 단계는 cache 범위를 준비할 뿐,
   실제 resource-tree·resource·events·logs 수용을 완료했다고 표시하지 않는다.
5. 고정 demo가 설치되어 있다면 자식 자원 관측에 필요한 Project 범위를 준비한다.

   ```powershell
   $plan = node src/cli.mjs prepare-argocd-observer @observerArgs --mode plan | ConvertFrom-Json
   $plan.projectObservation
   node src/cli.mjs prepare-argocd-observer @observerArgs --mode project-observation --approve-plan $plan.planDigest
   ```

   대상은 `argocd/psss-opensphere-adoption-demo` AppProject와
   `opensphere-psss-first-delivery-projects` VAP뿐이다. 정확한 이전/다음 상태만 수용한다.
   UID/RV와 공개 spec digest를 먼저 검증하고 VAP server dry-run → 재확인 → stdin replace → 검증,
   그 다음 Project server dry-run → 재확인 → stdin replace → 검증 순서로 실행한다.
   다른 필드·metadata·PFSS 분기를 보존한다. 두 객체는 원자적 transaction이 아니므로
   부분 실패 뒤에는 새 plan으로 남은 정확한 전환만 재개한다. 이전 상태로 자동 복귀하지 않는다.

   고정 demo의 whitelist만 기존 Deployment·Service·ConfigMap에 ReplicaSet·Pod를 더한다.
   다른 psss Project는 세 종류를 유지한다. Project whitelist 자체는 관측 전용 권한이 아니므로
   signed source 검사에서 직접 ReplicaSet·Pod를 계속 거부하고, controller의 이 두 자원
   create/update/patch/delete 거부와 observer의 sync/exec 거부를 운영 수용 시험에서 확인한다.
   새 RBAC·토큰·Application revision/annotation 변경은 없다. 기존 demo의 정확한 legacy
   source/cluster/revision 승인 anchor는 제품 owner가 검증하여 수용한다.
6. 실제 OS Shell 및 브라우저에서 API·UID·로그·settings·TLS를 검증한다. prepared는 수용 완료가 아니다.
7. 새 plan을 확인하고 검증 책임자의 명시적 확인으로 signing Secret authority를 회수한다.

   ```powershell
   $plan = node src/cli.mjs prepare-argocd-observer @observerArgs --mode plan | ConvertFrom-Json
   node src/cli.mjs prepare-argocd-observer @observerArgs --mode cutover --approve-plan $plan.planDigest --authenticated-proof $plan.policyDigest
   ```

   `--authenticated-proof`는 **신뢰된 Setup 실행자가 실제 API 시험을 완료했다는 확인**이다.
   공개 digest 자체를 별도 암호학적 증명이라고 주장하지 않는다. cutover는 signing/notifications
   Secret get 및 Secret create를 제거하고 `authority.reduced=true`를 기록한다. 그 뒤 Core는
   legacy Role 재등장을 drift로 거부한다. 이전 권한을 복원하는 rollback을 자동 수행하지 않는다.

## 최초 설치와 갱신

최초 설치에는 observer token이 아직 없어도 된다. Setup의 `core-credentials`를 먼저 실행하여
signing/notifications Secret을 새로 만들거나 기존 값을 보존하고 공개 준비 marker를 둔다.
Core runtime 설치 → 영속 TLS 준비 → observer 및 namespace cluster 범위 준비 → 인증된 수용 →
cutover 순서로 진행한다.
observer 인증 실패가 최초 Core 설치의 선행 blocker가 되는 순환은 만들지 않는다.

토큰 유효기간은 7일이다. 갱신은 최신 plan과 동일한 deployed compatibility proof를 사용하여
`--mode renew`로 한다. 새 토큰은 메모리에서 Secret stdin으로만 저장한다. 이전 토큰은
실제 인증 검증 후 cutover 전까지 폐기하지 않고, 같은 Secret 안의 밀봉된 복구 값으로 보존한다.
cutover가 이전 token ID를 폐기하고 복구 값을 제거한다. 부분 실패가 생기면 새/이전 토큰의
상태를 확인하기 전 임의 재발급·영구 토큰·더 강한 신원 fallback을 하지 않는다.

이전 ID가 이미 폐기되었지만 Secret cleanup이 중단된 경우, cutover는 고정 observer 계정의
token ID 메타데이터에서 이전 ID 부재와 현재 ID 존재를 확인한 뒤 정리를 재개한다.
전용 Secret의 UID/RV·token claims를 재확인하고 stdin replace로 이전 밀봉 필드만 제거한다.
확인되지 않은 CLI 오류를 무시하지 않으며 미완료 rotation이 있으면 추가 renew를 거부한다.
signing key나 전체 signing Secret을 읽지 않는다. Secret 값은 메모리·stdin 밖으로 내보내지 않는다.

90일 serving cert의 교체는 기존 Secret을 덮어쓰지 않는 별도 rotation 계획이 필요하다.
토큰·cert 만료 시각은 trust ConfigMap에 공개 상태로 남긴다. 24시간 전 경고·갱신 검증을 운영에 포함한다.

## 기존 권한 준비와 재현성

실제 origin/main의 기존 `preparePlatformCorePrerequisites`는 이미 승인된 target 및 정해진
Argo v2/reader-fence 전환만 허용한다. 이번 reduced executor가 기존 전환 목록과 다르면
`PRECONDITION_FAILED`로 **쓰기 전에 중단**한다. 축소된 Role을 legacy로 되돌리지 않는다.
이를 정상 진행으로 오해해서 scope guard나 equality 검사를 제거하지 않는다.

격리된 origin/main 기반 edge.40 소스의 전체 Setup 회귀는 670건 중 667건 통과, 실패 0,
기존 Console source 환경 미설정으로 3건 skip이다. 신규 source CLI 8/8 및
실제 ncc bundle/변조 거부/SEA 자산 목록 3/3은 모두 통과했다. PSSS Core/정책/준비 helper·manual 관련 74/74 통과.
Git OpenSSL의 키·cert 메모리 발급은 별도 로컬 실험에서 일치·SAN 두 개를 확인했으며,
그 실험은 Kubernetes 쓰기 0회와 개인키 파일 생성 0회였다. 이후 승인된 운영 시험에서
동일 준비 도구의 token 갱신·이전 ID 폐기·sealed cleanup, signing Secret get/create 회수,
namespace descriptor 및 고정 demo Project/VAP 전환이 확인되었다. controller의 ReplicaSet·Pod
create/update/patch/delete는 실제로 거부되었다. 이 사실은 새 PSSS 릴리스 전체 화면 수용이나
독립 클린 설치를 완료했다는 뜻이 아니며 최종 배포·재현 결과는 별도 운영 증거로 남긴다.


패키지 회귀 검증은 `npm run test:argocd-observer-bundle`로 실행한다. 기존 readiness 모듈의
직접 실행 guard가 ncc에서 imported 코드도 CLI로 오인하던 문제는 해당 filename 조건만
추가하여 정상 help와 신규 준비 명령 모두를 검증한다. SEA에는 고정 13개 자산만 넣으며,
검증된 코드만 임시 경로에 materialize한 뒤 제거한다. private credential은 자산에 포함되지 않는다.
공개 발행 workflow는 실제 Linux SEA에서 observer 명령을 실행하여 `Missing --kubeconfig`와
종료 코드 1을 확인한다. 로컬 Windows 시험은 ncc bundle까지이며 Linux native SEA 실행을
대신 증명하지 않는다. YAML 및 Linux matrix를 대입한 PowerShell smoke 구문의 파싱은 통과했다.

고정 source provenance: PSSS `65d8bbfdddefafd1d1146b4ac73f8bda8f517a9f`.
sourceTree SHA-256: `1ce1770be7b8ce8bc893b5d20a779f64054769ef4956097fd8ece8b01ac13a04`.
고정 manifest SHA-256: `e63ed20f420e7cbed142803e915e2e4ea294e04439901d5bbfc1510d80bbfbe9`.
