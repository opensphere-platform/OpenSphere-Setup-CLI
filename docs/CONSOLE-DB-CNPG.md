# Console DB를 CloudNativePG로 옮기기 (R2-C2, Setup 쪽)

- **근거:** RKE2 운영 준비 단계 계획(2026-10-24) R2-C2와 §4.1 "CNPG", 대표 확인 2026-10-27.
  - 설계: `HA-AND-NODE-FAILURE-DESIGN-20261024.md` §1(A안).
  - 실험실과 설계 전제를 깬 열 가지: `R2-C2-CNPG-LAB-RESULTS-20261027.md`.
  - 이미지 판정과 조건 M1–M6: `R2-C2-CNPG-VULN-TRIAGE-20261027.md`.
  - 이 구현의 실험실 결과: `R2-C2-SETUP-IMPLEMENTATION-20261027.md`(감사 폴더).
- **범위:** Setup만 바꾼다. Console 쪽 변경은 §5 목록으로 남기고, R2-C1을 다시 얹은 Console 릴리스에서 한다.

## 1. 한눈에

| 무엇 | 어디 |
|---|---|
| CNPG operator와 울타리·NetworkPolicy | `opensphere-setup prepare-console-db` (`src/console-db-prepare.mjs`, `src/console-db-cnpg.mjs`) |
| 전환 | `opensphere-setup migrate-console-db` (`src/console-db-cutover.mjs`) |
| 가져온 뒤 손질 | `src/console-db-role-repair.mjs` |
| parity 관문 | `src/console-db-parity.mjs` |
| 이미지 두 개 | `src/console-db-cnpg-images.json` (여기 한 곳만) |
| chart 원본 | `src/console-db-cnpg-operator-artifact.json` (`scripts/render-console-db-cnpg-operator.mjs`로 다시 만든다) |
| 두 배치 모두에서 SQL 실행 | `bootstrap.mjs` `runComponentMigrationSql`·`readySupabasePostgresPod`, `verify.mjs`, `reset-initial-admin.mjs` |

## 2. operator (기반 구성요소)

CNPG operator는 HISS 기능이 아니다. Console Backbone의 전제다. Setup만으로 Console을 세우고 복구한다는 원칙(ADR-0017) 때문이다.

- namespace `opensphere-cnpg-system`, PSA restricted.
- 2복제, 리더 선출(lease `db9c8771.cnpg.io`), 노드에 흩어 놓는다.
- `WATCH_NAMESPACE=opensphere-console-data`(env와 config map 둘 다).
- 이미지: `console-db-cnpg-images.json`. 태그와 digest를 함께 쓴다. CNPG webhook이 digest만 쓴 이름을 거절하기 때문이다.
- 권한:
  - ClusterRole: nodes 읽기, webhook 설정 두 개를 **이름으로** get/patch, clusterimagecatalogs 읽기.
  - chart의 view/edit 집계 ClusterRole은 넣지 않는다. 넣으면 모든 namespace 편집자가 CNPG 권한을 얻는다.
  - `opensphere-console-data`의 Role: chart의 namespaced 규칙. 쓰지 않는 쓰기(Pooler Deployment, PodMonitor, VolumeSnapshot)는 읽기로 줄였다.
  - 자기 namespace의 Role: lease, webhook 인증서 Secret, config map, webhook Service, events, 자기 Deployment·EndpointSlice 읽기.
- 적용 순서: namespace와 울타리 → CRD → NetworkPolicy → RBAC·webhook·Deployment.
  - 울타리가 형식 검사를 통과하기 전에는 권한을 하나도 만들지 않는다.
  - 서버 측 apply, field manager `opensphere-setup-console-db`. `--force-conflicts`는 쓰지 않는다.
- 적용 뒤 확인 세 가지:
  - operator로서 남의 Secret 만들기(dry-run)를 울타리가 거절한다(다섯 번 연속).
  - operator로서 옛 PVC 지우기(dry-run)를 울타리가 거절한다.
  - Console DB Cluster의 서버 측 dry-run이 operator webhook을 지난다(M1 아래에서 API 서버가 9443에 닿는다).
- Console DB가 CNPG에 있으면 Setup `upgrade`가 operator 객체를 계획하고, 다르면 다시 적용한다.
  - 울타리는 지금 모드 그대로 둔다. 비상으로 warn에 둔 울타리를 upgrade가 deny로 되돌리지 않는다(`fenceMode: 'preserve'`).
  - 전환(`migrate-console-db`)은 deny일 때만 시작한다.

## 3. 울타리 (ValidatingAdmissionPolicy `opensphere-console-db-operator-fence`)

대표 결정(2026-10-27): operator는 `opensphere-console-data` 안에서 자기 Cluster의 객체만 쓴다. 다른 Secret은 쓰지 않는다.

- operator ServiceAccount(`system:serviceaccount:opensphere-cnpg-system:cnpg-cloudnative-pg`)에만 걸린다.
- `failurePolicy: Fail`, binding은 Deny. 비상시 `--operator-fence warn`으로 Warn·Audit로 바꿀 수 있다.
- 모든 자원을 와일드카드로 잡고 **허용 목록**으로 판단한다. operator가 써 본 적 없는 종류는 거절된다.
- 클러스터 범위: 자기 webhook 설정 두 개의 CA bundle만 바꿀 수 있다. 그 밖의 필드와 다른 객체는 거절한다.
- `opensphere-console-data` 안:
  - 이름은 `opensphere-console-db` 또는 `opensphere-console-db-…`만(events, `cnpg-default-monitoring` ConfigMap 제외).
  - 그 이름 규칙에 걸리는 Setup 객체 셋은 종류와 상관없이 operator가 쓰지 못한다: Secret 두 개(`…-supabase-admin`, `…-import-source`)와 전환 기록 `…-cutover`(ConfigMap, 같은 이름의 실행 잠금 Lease).
  - Secret 종류는 CNPG가 실제로 쓰는 셋만: `Opaque`(CA), `kubernetes.io/tls`(서버·복제 인증서), `kubernetes.io/basic-auth`. `kubernetes.io/service-account-token`은 안 된다. 그런 Secret을 만들면 token controller가 namespace의 아무 ServiceAccount 토큰이나 채워 준다.
  - Pod·Job: 고정한 이미지 두 개만, 인스턴스 ServiceAccount만, host 접근·privileged·권한 상승·capabilities 추가·hostPort 없음. 볼륨과 env는 자기 이름의 Secret·ConfigMap·PVC만.
  - Service: ClusterIP만, externalIPs 없음, 자기 인스턴스만 고른다.
  - PDB: 자기 인스턴스만.
  - ServiceAccount·Role·RoleBinding: 이름이 `opensphere-console-db`인 것만. RoleBinding은 인스턴스 SA 하나에만.
  - 인스턴스 Role: CNPG 1.30.1이 그리는 규칙표(`INSTANCE_ROLE_RULES`, 실험실 `review-fixes/lab/10-instance-role.json`)에 있는 자원과 동사만. 인스턴스 SA는 울타리 밖이라, operator가 Role로 더 많은 권한(예: Cluster 삭제)을 줄 수 없게 한다. Secret·ConfigMap·Cluster 규칙은 자기 이름만 적어야 하고, 전환 기록은 안 된다.
  - Cluster: 만들기·지우기·spec 바꾸기는 거절. status와 metadata는 된다.
  - exec(CONNECT)는 자기 인스턴스 Pod에만.
- **막지 못하는 것:** 읽기. CNPG는 namespace의 Secret을 watch하므로 `opensphere-supabase-secrets`도 읽을 수 있다. VAP는 읽기를 막을 수 없다. 남는 위험으로 기록한다.
- operator namespace 안의 쓰기는 울타리 밖이다. RBAC가 자기 namespace의 Secret·ConfigMap·Service·lease·events로 묶는다.

## 4. NetworkPolicy (M1, M2)

| 이름 | namespace | 내용 |
|---|---|---|
| `opensphere-cnpg-default-deny` | operator | 들고 나는 것 모두 막음 |
| `opensphere-cnpg-operator` | operator | 9443은 API 서버 주소에서만, 8080은 `monitoring`의 Prometheus에서만. 나가는 것은 API 서버와 인스턴스 8000·5432만 |
| `opensphere-console-db-cnpg` | console-data | 실험실이 검증한 인스턴스 정책. 8000·5432는 operator와 인스턴스끼리. API 서버로 나감 |
| 같은 이름의 CiliumNetworkPolicy 둘 | 둘 다 | Cilium이 있을 때만. `kube-apiserver` entity로 9443 받기와 API 나가기 |

- API 서버 주소는 실행 때 `default/kubernetes` Service와 EndpointSlice에서 읽는다. 코드에 박지 않는다.
- 인스턴스는 `app=opensphere-supabase-postgres` 레이블을 물려받는다. 그래서 Console의 기존 정책이 새 primary에도 그대로 적용된다.

## 5. 전환 (`migrate-console-db`)

```
opensphere-setup migrate-console-db --context <ctx> --cluster-uid <kube-system uid> --evidence-dir <클러스터 밖 폴더>
    [--apply [--until <단계>]] [--accept-prerequisite <id>]... [--extra-writer <ns>/<deployment>[=<DB 역할>]]...
opensphere-setup migrate-console-db ... --rollback | --status | --discard-attempt <attempt id>
opensphere-setup migrate-console-db ... [--break-lock <잡은 쪽>]   (죽은 실행의 잠금을 넘겨받는다)
```

- `--apply`가 없으면 사전 점검만 한다(읽기).
- 단계마다 체크포인트 ConfigMap `opensphere-console-data/opensphere-console-db-cutover`에 기록한다. 다시 실행하면 기록되지 않은 첫 단계부터 이어 간다. 기록된 단계는 다시 하지 않는다.
- **한 번에 하나만 돈다.** `--apply`·`--rollback`·`--discard-attempt`는 같은 이름의 Lease(`coordination.k8s.io`)를 잡고 시작한다.
  - 기다리는 동안 1분마다 갱신한다. 유효 기간은 30분이다.
  - 다른 실행이 잡고 있으면 거절한다(`CUTOVER_LOCKED`, 잡은 쪽 이름을 알려 준다).
  - 그 프로세스가 죽은 것을 확인했으면 `--break-lock <잡은 쪽>`으로 넘겨받는다. 30분이 지나면 저절로 풀린다.
  - 잡은 뒤 누가 Lease를 바꾸면 그 실행은 멈춘다(`CUTOVER_LOCK_LOST`).
  - Lease 쓰기는 Setup의 관리자 kubeconfig로 한다. 새 권한은 없다.
  - 클러스터 UID를 먼저 확인한 뒤 잠금을 쓴다. 다른 클러스터에는 아무것도 쓰지 않는다.
- 체크포인트도 resourceVersion으로 쓴다.
- 쓰는 동안(`InProgress`, `Switched`, `RollingBack`)에는 Setup의 bootstrap·upgrade·verify·마이그레이션이 모두 멈춘다.

| 단계 | 하는 일 |
|---|---|
| freeze | 옛 PV를 `Retain`으로. 쓰는 쪽을 기록하고 0으로(Console 먼저, Supabase 나중). 원본에 클라이언트 세션이 남으면 멈춘다. 그다음 원본의 **쓰기 지표**를 기록한다: 사용자 표의 행 변경 수(`n_tup_ins/upd/del`), 관계 파일과 카탈로그 행 버전(TRUNCATE·DDL), 시퀀스 값, 다른 DB의 행 변경 수. 2초 간격 두 번이 같을 때만 기록한다 |
| dump | 먼저 남은 공간을 본다. 원본 볼륨과 이 기계 모두 DB 크기의 1.1배 + 256 MiB가 비어 있어야 한다(볼륨이 차면 PostgreSQL이 멈춘다). `pg_dump -Fc`, `pg_restore --list`로 확인, 증거 폴더로 복사, sha256 대조. 맞으면 원본 볼륨의 덤프는 지운다. 증거 폴더는 현재 사용자만 읽는다(Windows는 복구 키와 같은 ACL 도우미, 그 밖은 0700) |
| fingerprint | 원본이 freeze 때 그대로인지 먼저 본다. 표마다 행 수와 **내용 해시**, **정의**(열·기본값·identity, 인덱스, 제약, 뷰, 함수, 시퀀스 값), 원장, 역할, 멤버십, 권한(읽기 전용, XML 함수 없음). 비밀번호 없는 역할 덤프 |
| create | Setup Secret 둘(지금 비밀번호를 프로세스 안에서 옮김, 출력 없음), 임시 원본 Service, Cluster. 가져오기와 3인스턴스·동기 대기를 기다린다. 가져오기 로그를 보관하고 예상 밖 오류가 있으면 멈춘다. **로그를 읽지 못했으면 멈춘다**(아래) |
| repair | 멤버십, 역할 설정, 속성, 스키마·DB 권한을 되살린다 |
| parity | 관문. 설명된 차이 밖의 것이 하나라도 있으면 멈춘다(§5.1) |
| switch | 원본이 freeze 때 그대로인지 다시 본다(세션 없음, 지표 그대로). 지금 Service의 selector와 ports를 체크포인트에 적는다. selector를 `{app, cnpg.io/instanceRole: primary}`, targetPort를 5432로. 끝점이 primary 하나인지 본다. 원본을 한 번 더 본 뒤 StatefulSet을 0으로 |
| reopen | Service가 primary 하나만 고르는지, targetPort가 5432인지, Cluster가 hibernate되지 않고 건강한지, StatefulSet Pod가 없는지 본다. 하나라도 아니면 쓰는 쪽을 올리지 않는다. 그다음 되돌릴 수 없는 지점을 기록하고 쓰는 쪽을 원래 수로 |
| verify | PostgREST schema reload, CNPG 경로로 원장 확인, 쓰는 쪽 역할이 모두 새 primary에 붙었는지, Cluster 상태 |
| finalize | 임시 원본 Service와 import-source Secret을 지운다 |

- **원본 쓰기 확인:** 쓰는 쪽 목록에 없는 무엇이 freeze 뒤에 원본에 쓰면, fingerprint나 switch가 `SOURCE_WRITTEN`으로 멈춘다. 아무것도 옮기지 않은 상태다. 되돌린 뒤 그 쓰는 쪽을 찾아 `--extra-writer`로 새 시도를 한다.
  - 원본을 읽기 전용으로 바꾸는 방법은 쓰지 않았다. `default_transaction_read_only`는 세션이 끌 수 있고, 되돌리기가 중간에 실패하면 원본이 읽기 전용으로 남아 그 자체가 장애가 된다.
- **가져오기 로그:** CNPG가 import Job을 지운 뒤에 이어 하면, 같은 시도에서 먼저 받아 둔 로그(`import-capture.json`, 성공한 Pod, sha256 일치)가 있을 때만 이어 간다. 없으면 `IMPORT_LOG_MISSING`으로 멈춘다. 되돌리기 → `--discard-attempt` → 새 시도. 건너뛰는 옵션은 두지 않았다. 그 로그가 가져오기 오류를 보는 유일한 곳이기 때문이다.
- **`--extra-writer`를 이어 하기에서:** freeze가 끝나기 전이면 체크포인트의 쓰는 쪽에 더해지고 freeze가 멈춘다. 끝난 뒤면 거절한다.
- **되돌리기(`--rollback`)는 reopen 전에만 된다.**
  - 무엇이든 바꾸기 전에 `RollingBack`을 기록한다. 중간에 실패해도 그 상태로 남고, `--apply`는 거절한다. `--rollback`을 다시 실행하면 이어서 끝낸다.
  - Cluster hibernate를 요청한다. 인스턴스도 `app` 레이블을 가진다.
  - 곧바로 옛 길을 되살린다: switch 때 적어 둔 selector와 ports를 그대로, StatefulSet을 1로. 원장이 원본 지문과 같은지 본다. 중단된 dump가 남긴 파일도 지운다.
  - 쓰는 쪽은 Service의 준비된 끝점이 StatefulSet Pod 하나뿐일 때만 되살린다. hibernate가 3분 안에 인스턴스를 멈추지 못하면(operator 정지 등) Setup이 인스턴스 Pod를 지운다. hibernate 요청이 남아 있어 operator가 다시 만들지 않는다. 그래도 3분 안에 안 되면 멈추고, 다시 실행한다.
  - hibernate된 Cluster는 남긴다. 다음 시도 전에 `--discard-attempt <id>`로 지운다(가져온 사본만 지운다).
- reopen 뒤에는 되돌리기를 거절한다. 그때부터는 새 덤프로만 되돌린다(설계 §1.6).
- 옛 StatefulSet·PVC·PV는 이 명령이 지우지 않는다. 릴리스 prune도 지우지 않는다. 7일 뒤 한 줄로 알리고 따로 지운다(계획 §4.3).

### 5.1 parity가 보는 것

- 표: 행 수와 내용 해시. 행마다 `md5(행::text)`를 구해 64비트 합 두 개로 접는다. 행 순서와 상관없고, 정렬하거나 큰 문자열을 만들지 않는다. 시간대·날짜 형식·float 자릿수·bytea 형식은 양쪽 같게 둔다.
  - 원본에서 1 GiB가 넘는 표는 행 수만 비교하고 `parity.json`의 `unhashed`에 적는다. 대상은 원본의 계획을 그대로 따른다.
- 정의: 열(타입, NOT NULL, 기본값, identity, generated, collation), 인덱스, 제약, 뷰, 함수(`pg_get_functiondef`), 시퀀스 값. 확장에 속한 객체는 확장 줄(이름·버전·스키마)로 본다. CNPG 이미지의 vector가 더 새 판이기 때문이다.
- 원장, 역할, 멤버십, 역할 설정, 권한, 소유자, RLS, 정책, 트리거, 이벤트 트리거, 기본 권한, DB locale, publication은 전과 같다.
- `extensions` 스키마의 권한 차이는 소유자가 postgres로 바뀐 것만 설명된 차이로 본다. 두 소유자의 권한을 뺀 나머지 권한이 같아야 한다. 권한이 하나라도 더하거나 빠지면 멈춘다.

### 5.2 사전 조건 (Setup이 볼 수 없는 것은 이름으로 받는다)

| id | 내용 |
|---|---|
| `pool-error-listener` | console-api, extension-controller, os-shell-control의 pg Pool `error` 리스너(Console, R2-C1). 없으면 장애·switchover마다 셋이 재시작한다(실험실 X6) |
| `crash-alerts` | PostgreSQL crash recovery와 CNPG 인스턴스 재시작 경보(Cluster Manager, 판정 M4) |
| `kured-cnpg-gate` | kured `PDBBlocking`이 CNPG primary PDB를 빼는 CM 판(HA §1.5) |
| `ksm-pdb-labels` | kube-state-metrics의 PDB 레이블 허용 목록에 `cnpg.io/cluster`. Setup이 직접 본다 |
| `node-maintenance-paused` | 유지 창 동안 `node-maintenance.pause` |
| `outage-announced` | 하루 전 정지 공지 |
| `console-layout-release` | `-ConsoleDataLayout`을 선언한 Console 릴리스가 준비됨(§6). 전환 뒤 첫 Setup 업그레이드에 필요하다 |

## 6. Console 쪽 변경 목록 (R2-C1을 다시 얹은 Console 릴리스)

Setup은 Console DB가 CNPG에 있으면 `-ConsoleDataLayout`을 선언하지 않은 Console 릴리스를 대상으로도, rollback 기준으로도 설치하지 않는다. 옛 installer는 StatefulSet(replicas 1)과 옛 Service를 다시 적용하기 때문이다.

1. `scripts/Install-ConsoleApiRuntime.ps1`
   - param 블록에 `[ValidateSet('statefulset','cnpg')][string]$ConsoleDataLayout = 'statefulset'`. Setup은 이 선언을 보고 판단한다(`installerSupportsCnpgLayout`).
   - `cnpg`일 때:
     - `$dataResources`(296–312행)와 `$dataWorkloads`(327행)에서 `serviceaccount/opensphere-supabase-postgres`, `persistentvolumeclaim/opensphere-supabase-postgres-data`, `statefulset/opensphere-supabase-postgres`를 뺀다. 있는 객체는 건드리지 않는다(scale도 하지 않는다).
     - Service `opensphere-supabase-postgres`를 selector `{app: opensphere-supabase-postgres, cnpg.io/instanceRole: primary}`, ports `[{name: postgres, port: 5432, targetPort: 5432}]`로 그린다.
     - `Set-ReadyPostgresPod`(334행): `cnpg.io/cluster=opensphere-console-db,cnpg.io/instanceRole=primary`에서 Ready 정확히 하나. Cluster `status.currentPrimary == targetPrimary`를 확인한다.
     - SQL 실행(345·352행): `kubectl exec -i <pod> -c postgres -- psql -X -q -U postgres -d postgres -v ON_ERROR_STOP=1` + `-tA` 또는 `--single-transaction`. 입력 앞에 트랜잭션이면 `SET LOCAL ROLE supabase_admin;`, 읽기면 `SET ROLE supabase_admin;`. `PGPASSWORD`를 쓰지 않는다.
     - `rollout status statefulset/opensphere-supabase-postgres`(570행) 대신 Cluster `readyInstances == instances`를 기다린다.
2. `scripts/Install-ConsoleNativeRuntime.ps1`: 같은 param. 205행 Pod 선택과 212행 psql을 위와 같이.
3. `backend/supabase/target/deploy.yaml`: StatefulSet·PVC·SA·Service를 배치별 파일로 나눈다. `cnpg`에서는 Auth·REST·Storage, NetworkPolicy, CNPG용 Service만 적용한다. NetworkPolicy는 `app=opensphere-supabase-postgres`를 그대로 고른다.
4. `deploy/console-image-admission-policy.yaml` (**X11, 아래 §7**): `opensphere-console-image-integrity-workload`에 matchCondition `request.userInfo.username != 'system:serviceaccount:opensphere-cnpg-system:cnpg-cloudnative-pg'`를 더한다. 그 사용자의 이미지는 Setup 울타리가 digest로 묶는다.
5. pg Pool `error` 리스너: `apps/console-api/src/server.mjs:70`, `apps/extension-controller/src/server.mjs:59`, `apps/os-shell-control/server.js:247`(X6, 전환 사전 조건).
6. `apps/recovery-owner/recovery-jobs.yaml`(227행 `SUPABASE_POSTGRES_HOST`): 이름은 그대로다. 복구 Job의 `pg_dump`가 쓰는 역할과 sslmode를 CNPG에서 한 번 확인한다(CNPG는 TLS를 켜고 비TLS도 받는다).
7. 확인만: `migrations/baseline/verify/*.verify.sql`의 `RESET ROLE`. `SET LOCAL ROLE` 아래에서는 `postgres`로 돌아간다. 이 파일은 확인만 하고 객체를 만들지 않으므로 소유자 문제는 없다.
8. 옛 경로(`backend/supabase/install.ps1`, `migrate-only.ps1`, `scripts/Deploy-LocalEdgeOsShell.ps1`)는 localhost·legacy용이다. Setup이 CNPG 배치에서 legacy installer를 거절한다.

## 7. RKE2에서 새로 찾은 막힘 (X11)

- RKE2의 Console 정책 `opensphere-console-image-integrity-workload`는 `opensphere-console-data`의 Deployment·StatefulSet·DaemonSet·**Job**에 `ghcr.io/opensphere-platform/…@sha256` 이미지만 허락한다.
- CNPG의 import·initdb·join은 Job이다. CNPG 표준 이미지라 **RKE2에서는 가져오기 Job이 거절된다**(실험실에서 그 정책을 그대로 올려 재현). 인스턴스 Pod는 Pod라 걸리지 않는다.
- 두 길:
  - **A. 미러:** 두 이미지를 digest 그대로 `ghcr.io/opensphere-platform/mirror/cloudnative-pg/…`에 복사한다. Setup은 이 이름도 받는다(images 파일만 바꾼다). GHCR 게시가 하나 늘고, 비공개면 pull Secret 두 곳(operator namespace, 인스턴스 SA)이 더 필요하다. 공개는 되돌릴 수 없다.
  - **B. Console 정책 예외(권장):** §6-4. CNPG operator 사용자의 쓰기는 Setup 울타리가 같은 digest로 묶으므로 이중 검사가 빠지지 않는다. 실험실에서 이 예외 아래 join Job이 두 정책을 모두 지났다.
- 어느 쪽이든 전환 전에 정해야 한다. 대표 결정 사항이다.
