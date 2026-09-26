# OpenSphere Release Distribution and Version Selection

Status: Supabase + Gitea + Beszel backbone, Setup CLI 0.5 target contract

## 결정

OpenSphere 설치 입력은 mutable tag 목록이 아니라 Console anchor digest에 첨부된 서명 `OpenSphereReleaseBOM`이다. BOM은 한 source revision에서 빌드된 **19개 canonical component**를 하나의 원자적 release로 묶는다(R2D2 worker 이전에 설치된 18개 lock은 upgrade·rollback 기준으로만 받는다). 설치 lock은 같은 release tag와 source revision에 결속된 **4개 auxiliary artifact**도 반드시 보존한다(Console anchor에 index 렌더러 계약 `io.opensphere.console-index-content`가 없는 이전 release는 `consoleIndexContent`를 뺀 3개).

`integrated` lock은 BOM과 동일한 통합 release다. 로컬 `edge`의 영향을 받은 이미지만 다시 빌드하는 경우에는 `component` lock을 사용할 수 있다. 이 lock도 canonical 19개와 auxiliary 4개의 전체 목록을 갖는 완전한 설치 상태이며 부분 목록이 아니다. 다음 전이 증명을 release digest에 결속한다.

- `baseReleaseDigest`: 현재 클러스터에 설치된 직전 lock
- `changedComponents`: 이번에 실제로 다시 빌드한 canonical component의 정렬된 집합
- 목록에 없는 canonical component: 직전 lock의 repository, image digest, source revision과 registry 요구를 byte-for-byte 계승
- 목록에 있는 canonical component: 새 source revision과 digest를 사용하며 실제로 직전 lock과 달라야 함
- auxiliary artifact: 같은 immutable release tag에서 해석하며 repository, digest, source revision과 `io.opensphere.release-scope=auxiliary`를 검증

component lock은 localhost `edge`의 **upgrade 전용** 계약이다. fresh bootstrap, `candidate`/`stable`, signed Release BOM 승격에는 사용할 수 없다. 실패하면 직전의 완전한 base lock과 사전 확보한 artifact로 rollback한 뒤 그 상태를 다시 검증한다.

**되돌릴 수 없는 migration(2026-09-26, 검토 R1·재검토 F1–F3):** 한 방향 migration은 semantic key로 정한다(지금은 R2D2 task engine 전환 `console.osdst.task_engine_cutover`). 대상 release의 검증된 migration manifest에 그 key가 있으면 Setup은 갱신 전에 원장을 읽고, 원장이 대상 migration 사슬의 정확한 prefix인지(ID·key·계보·file hash·source revision·set digest·size) 확인한다. 못 읽거나 어긋나거나 대상보다 앞서면 워크로드·migration·설치 기록을 바꾸기 전에 멈춘다(namespace와 pull secret 보장은 그보다 앞서 멱등으로 실행된다).

- **이미 지난 경우:** 원장에 한 방향 migration이 이미 있으면, 이전 release의 migration 소유 구성요소가 빌드된 검증된 manifest에 그 migration이 같은 ID·hash로 들어 있어야 이전 release를 rollback 대상으로 인정한다. 없거나 확인할 수 없으면 일반 갱신은 바꾸기 전에 멈춘다.
- **일반 갱신의 출발점:** 설치 기록이 이전 release의 `Ready`일 때만 일반 갱신을 한다. `Failed`·`Installing`·알 수 없는 상태는 `verify --complete-installation`(같은 release) 또는 `upgrade --one-way-recovery`로 다룬다. 같은 release를 관측만 하는 갱신은 아무것도 설치하지 않고 `Failed`를 풀지 않는다.
- **선점 기록:** 첫 변경 전에 설치 기록을 이전 release의 `Installing`과 `transition`(실행 ID, 이전·대상 digest, 이전 검증 시각, 한 방향 migration과 rollback 방침)으로 바꾼다. 이 실행의 모든 기록 쓰기는 uid·resourceVersion을 대조하고, 새 버전은 그 쓰기의 PATCH 응답이 보고한 것만 자기 것으로 삼는다(뒤의 GET으로 본 버전은 채택하지 않는다). 응답이 유실되거나 확인되지 않으면 소유권 불명으로 멈추고 명시적 복구로만 재개한다. 대상 설치, 검증 뒤, 정리(prune) 뒤, inventory 기록, rollback 설치·검증·정리 앞에서 소유권을 다시 확인한다. 다른 쓰기가 끼면 그 자리에서 멈추고 이미 한 일과 하지 않은 일을 오류에 남긴다. 이 대조는 설치 기록 ConfigMap을 지키며, 다른 객체(inventory·workload)가 그와 원자적으로 바뀐다는 뜻은 아니다. Console Knowledge 전달도 같은 규칙을 따른다: 첫 workload 변경 직전에 idle Ready 기록을 선점(Installing + `knowledgeUpdate` + `transition.mode: knowledge`)하고 자기 완료가 Ready를 쓸 때까지 유지하며, 다른 실행이 잡은 기록이면 멈춘다. Setup은 Knowledge 선점 위에서 일반 갱신·one-way 복구·검증 완료·localhost 전진 수선(`--repair-plan`/`--forward-repair`)을 하지 않는다. 전진 수선은 검토한 기록에서, 첫 변경 직전 재확인에서, 그리고 수선 기록 쓰기마다 Knowledge 선점을 거절한다. 검토한 기록 digest는 그 기록을 봤다는 증거일 뿐 Knowledge 작업의 종료나 양도가 아니다. 판정 함수(`claimStatus`, `isKnowledgeClaim`)는 Console의 `knowledge-installation.cjs` 계약에서 받은 사본을 쓴다.

**공급자·소비자 적합성:** Console은 한 방향 migration을 `packages/contracts/runtime/one-way-migrations.json`에 선언하고, manifest의 ID·key·hash를 `test/fixtures/one-way-migrations-v1.json`으로 보낸다(`sync-one-way-migrations.mjs --setup-root`). `test/one-way-conformance.test.mjs`는 Setup이 인식하는 목록이 그 선언과 정확히 같은지 확인한다. 구 설치기가 이 release를 적용하지 못하게 막는 것은 RKE2·edge 전에 따로 닫는다.
- **실패 뒤:** 원장을 다시 읽는다. 이번 실행이 건너려던 한 방향 migration이 적용됐거나, 원장을 읽을 수 없거나, 사슬과 어긋나거나, 전에 있던 행이 사라졌으면 이전 release를 설치하지 않고 옛 lock을 복원하지 않으며 자원을 정리하지 않는다. 대상 lock·inventory를 두고 기록을 `Failed`(`one-way-migration-recovery-required` 또는 `one-way-migration-state-unknown`)와 `transition.outcome`으로 남긴다. 적용되지 않았음이 확인된 실패만 rollback한다.
- **통합 rollback의 migration 사슬:** 통합 release의 rollback은 이전 release의 설치기를 다시 돌리고, 그 설치기는 받은 사슬에서 원장에 없는 migration을 모두 적용한다. 대상 사슬을 주면 한 방향 migration 앞의 rollback이 그 migration을 적용해 버린다. 그래서 대상에 아직 적용되지 않은 한 방향 migration이 있으면, 첫 변경 전에 이전 release를 **자기 사슬**로 따로 준비하고 그 사슬이 지금 원장과 정확히 같은지 확인한다. 판정은 한 곳에서 한다: rollback 준비가 쓰는 것과 같은 출처·검증으로 읽은 사슬(`readRollbackMigrationChain`)을 원장과 대조해 `fits`(적용할 것 없음)·`would-apply`(설치기가 더 적용함)·`database-ahead`(그 release가 DB를 받지 못함)·`diverged`로 가른다. `fits`가 아니면 이유를 적고 바꾸기 전에 멈춘다. 준비된 rollback의 사슬이 판정한 사슬과 다르면 역시 멈춘다. 사슬이나 원장을 읽지 못하면 판정이 아니라 별도 오류로 멈춘다. migration 소유 구성요소들의 사슬(`readReleaseMigrationManifests`)은 "이전 release가 이미 지난 한 방향 migration을 포함하는가"라는 다른 질문에만 쓴다. 실패 뒤 원장이 시작 때와 같으면 그 준비로 rollback한다. 설치기는 아무 migration도 적용하지 않는다. 대상 migration 일부가 들어갔지만 한 방향 migration은 들어가지 않았으면, 어느 설치기도 그것을 건너지 않고는 돌아갈 수 없으므로 rollback하지 않는다. 대상을 두고 `Failed`(`partial-migration-recovery-required`, `transition.outcome.appliedMigrations`·`reason`)로 남기며, 복구는 `--one-way-recovery`로 앞으로만 간다. component release의 rollback은 전처럼 migration을 적용하지 않는다(`applyMigrations: false`).
- **복구:** `upgrade --lock <대상> --one-way-recovery-plan`으로 기록 digest·상태·원장을 조회하고, 검토한 digest로 `--one-way-recovery`를 실행한다. 통합 release만 대상이다. 복구는 이전 release를 가져오거나 설치하지 않고 대상으로만 간다. 다시 실패해도 되돌리지 않고 `Failed`로 남는다. 기록이 `Ready`이고 그 release가 DB와 맞으면 복구를 거부한다(일반 갱신을 쓴다). 예외는 하나다. 대상에 대기 중인 한 방향 migration이 있는데 위의 판정이 `fits`가 아닌 구체적인 이유(`would-apply`·`database-ahead`·`diverged`)를 내면 일반 갱신은 바꾸기 전에 멈춘다. 이때만 `Ready`에서도 앞으로만 가는 복구를 받는다. 일반 갱신과 복구 허용은 같은 판정을 쓰므로 서로 상대 경로를 안내하며 막히지 않는다. 사슬을 읽지 못한 것은 이유가 아니므로 복구도 받지 않는다.
- **중단된 실행:** 기록의 `transition`이 다른 대상으로 가던 중이고 그 한 방향 migration이 원장에 있거나 확인할 수 없으면 `verify --complete-installation`은 이전 release를 완료로 기록하지 않는다.

Canonical 19개:

```text
console
consoleApi
extensionController
registry
osaaGateway
r2d2HermesWorker
osdst
osaaGovernedAdapter
notificationDispatcher
gitea
giteaPostgres
supabasePostgres
supabaseAuth
supabaseRest
supabaseStorage
recovery
beszelHub
beszelAgent
beszelBootstrap
```

`r2d2HermesWorker`(`opensphere-console-r2d2-hermes-worker`)는 `opensphere-console-osaa-gateway` Deployment의 `hermes-worker` sidecar다. Setup은 Console 원본에 `__OPENSPHERE_R2D2_HERMES_WORKER_IMAGE__` 자리가 있을 때만 이 digest를 렌더링하고, native installer에는 lock에 이 구성요소가 있을 때만 `-R2d2HermesWorkerImage`를 넘긴다. 이 구성요소가 없는 기존 18개 lock은 설치된 upgrade/rollback 기준으로만 받는다. 기존 설치에는 integrated upgrade(`upgrade --release edge` 또는 명시 `--lock`)로 추가하며, component lock으로는 추가할 수 없다.

Auxiliary 4개:

```text
cliArtifacts
osShellControl
osShellRuntime
consoleIndexContent
```

Setup fresh bootstrap은 canonical 중 13개 bootstrap core와 `cliArtifacts`만 배포한다. `osaaGateway`, `osdst`, `osaaGovernedAdapter`, `notificationDispatcher`, `recovery` 5개는 Console이 설치 후 활성화하는 available module이다. `osShellControl`과 `osShellRuntime`도 Console에서 활성화하지만, Console이 mutable `:edge`를 다시 해석하지 않도록 exact digest를 최초 installation lock에 보존한다.

DUPA의 target control-plane 책임은 `extensionController`에 통합되었다. legacy `backend`와 `dupaController` 이름은 현행 canonical 집합이 아니며 과거 lock 복구와 명시적 정리 경로에서만 해석한다. Kanidm, 구형 Auth BFF, 별도 Console PostgreSQL, RustFS와 CBS image set도 release 구성요소가 아니다.

## 발행

`edge`와 promotion release의 빌드 권위는 분리한다.

- `edge`: Windows Docker Desktop의 `OpenSphere-Console/scripts/Publish-LocalEdge.ps1`이 host-native 이미지를 build/push한다. KST `yyyyMMddHHmm` immutable release tag를 검증한 뒤 non-anchor와 Console anchor 순서로 `edge`를 이동한다. canonical에는 `io.opensphere.release-scope=canonical`, auxiliary에는 `io.opensphere.release-scope=auxiliary`가 있어야 한다.
- `candidate`: `OpenSphere-Console/.github/workflows/publish-candidate-images.yml`이 clean multi-architecture build, provenance, SPDX SBOM과 signed Release BOM을 만든다.
- `stable`/GA promotion: `OpenSphere-Console/.github/workflows/promote-release.yml`이 검증된 candidate release를 승격한다. 존재하지 않는 별도 GA image-build workflow를 신뢰하지 않는다.

Console anchor는 어떤 채널에서도 마지막에 이동한다. Setup은 부분 발행 중 혼합 revision, edge-local 결과의 승격, retired edge workflow의 attestation을 승인하지 않는다. 과거 GitHub Actions edge lock은 정확한 rollback baseline으로만 읽을 수 있으며 새 target release, 재발행, 승격에는 사용할 수 없다.

Setup CLI는 OpenSphere OS image release와 분리된 공개 immutable GitHub Release에서 발행한다. `publish-platforms.yml`은 public visibility를 확인하고 5개 플랫폼 포터블 아카이브, Windows 포터블 실행기 `opensphere-setup.exe`, `SHA256SUMS`를 발행한다. Setup을 호스트에 설치하거나 PATH를 등록하지 않는다. Windows 실행기는 검증된 ZIP과 압축 해제한 런타임을 EXE 옆의 opensphere-setup-runtime/<tag>에 보관하고 같은 버전에서는 재다운로드·재압축 해제 없이 재검증하여 실행한다. 작은 채널·Release 메타데이터 조회는 계속 수행하며 Windows 설치·PATH 등록은 하지 않는다. 압축형 패키지는 사용자가 푼 자리에서 실행한다. 실행 계약은 `docs/PORTABLE-EXECUTION-CONTRACT.md`다. `package.json`의 `private: true`는 npm 오발행을 막는다. Setup 공개 여부와 Console GHCR 접근 정책은 분리한다.

Setup CLI package 실행 버전 선택은 OCI image 채널과 별도다. `--version <semver>`는 `setup-v<semver>` immutable GitHub Release를 직접 선택한다. `--channel edge|candidate|stable`은 public `main`의 `channels/<channel>` 포인터를 한 번 읽고 그 exact immutable Release로 고정한다. `edge`는 `setup-v<semver>-edge.<sequence>`, `candidate`는 `setup-v<semver>-candidate.<sequence>`, `stable`은 prerelease suffix 없는 `setup-v<semver>`만 허용한다. 미준비 채널은 `HOLD`로 명시하며 fallback하지 않는다. Release workflow는 package version, channel pointer와 GitHub prerelease flag가 일치하지 않으면 발행을 거부한다. 이 package selector는 Console의 `--release` 또는 signed `--lock`을 대체하지 않는다.

## 소비

Setup은 다음을 모두 만족해야 release lock을 반환한다.

- channel: `edge`, `candidate`, `stable`, `ga` 중 하나
- Console anchor가 공식 GHCR repository
- Release BOM predicate: `https://opensphere.io/attestations/release-bom/v1`
- candidate/stable/GA signer workflow와 OIDC issuer가 채널 trust root와 일치
- source repository와 40자리 source revision 일치
- canonical component 정확히 19개, 추가나 누락 없음(설치된 18개 lock은 upgrade·rollback 기준으로만)
- auxiliary artifact 정확히 4개, 추가나 누락 없음(index 렌더러 계약이 없는 이전 release는 3개)
- 모든 image가 공식 repository의 `@sha256:<64 hex>`
- candidate/stable/GA canonical component에 provenance와 SPDX SBOM attestation
- 지원 platform이 `linux/amd64`, `linux/arm64`
- 계산한 canonical release digest가 BOM/lock과 일치

component upgrade lock은 공통 항목과 함께 base digest, 동일 channel/trust, 동일한 canonical 19개와 auxiliary 4개 집합, 명시된 변경 외 byte-for-byte 계승을 추가 검증한다.

Setup은 그 source revision에서 manifest, installer와 SQL migration을 받는다. manifest의 모든 image는 lock digest로 치환되며 tag-only, upstream registry 또는 미해결 placeholder가 남으면 설치를 중단한다. signed BOM의 migration manifest SHA-256, set digest와 latest global ID도 materialized Console API installer에 전달해 SQL bytes와 lineage를 fail-closed 검증한다.

## 채널 선택

```powershell
opensphere-setup resolve --release edge --lock .\edge-lock.json
opensphere-setup bootstrap --release edge --lock .\edge-lock.json
```

- fresh install: 명령 시점의 채널을 한 번 resolve하고 lock 생성
- resume: 채널을 재조회하지 않고 클러스터 lock 사용
- explicit lock: 설치 입력 자체이며 cache hint가 아님
- upgrade: target과 현재 rollback artifact를 모두 사전 검증한 뒤 적용

현재 `edge`만 개발 설치 경로다. `candidate`, `stable`, `ga`는 Supabase PostgreSQL/Storage 및 Gitea/PostgreSQL의 격리 복구 drill, 그리고 Beszel의 governed multi-architecture promotion 증거가 충족될 때까지 HOLD다.

## GHCR 접근

공개 package는 anonymous pull Secret을 생성한다. 비공개 package는 paired stdin 계약만 허용한다.

```powershell
$env:GHCR_TOKEN | opensphere-setup resolve `
  --release edge `
  --registry-username <github-login> `
  --registry-token-stdin
```

토큰은 URL, argv, release lock, ConfigMap 또는 로그에 저장하지 않는다. Kubernetes에는 Setup 소유 namespace별 `opensphere-ghcr-pull` Secret으로만 전달한다.

## 실패 정책

다음은 자동 복구 또는 추정 없이 fail-closed한다.

- BOM, attestation 또는 trust root 불일치
- integrated/BOM release의 source revision 혼합
- component release의 base digest 불일치, 숨은 component 변경 또는 허위 변경 목록
- canonical/auxiliary artifact 누락 또는 추가
- mutable/tag-only 이미지
- 지원 node architecture 부재
- Setup 소유 target namespace와 installation lock의 소유권 불일치
- 구형 아키텍처 lock의 in-place 변환
- target 검증 실패 후 이전 release 재검증 실패

구형 설치 데이터 이관은 release 선택 기능이 아니다. 별도 승인된 export/import migration이 필요하며 fresh Supabase bootstrap이 구형 권위와 자동으로 병합하지 않는다.
