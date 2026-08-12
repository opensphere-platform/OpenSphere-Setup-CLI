# OpenSphere Release Distribution and Version Selection

Status: Supabase/Gitea architecture, Setup CLI 0.5

## 결정

OpenSphere 설치 입력은 mutable tag 목록이 아니라, Console anchor digest에 첨부된 서명
`OpenSphereReleaseBOM`이다. BOM은 한 source revision에서 빌드된 13개 필수 이미지를 하나의
원자적 release로 묶는다.

`integrated` lock은 위 BOM과 동일한 통합 release다. 로컬 `edge`의 영향을 받은 이미지만
다시 빌드하는 경우에는 `component` lock을 사용한다. component lock도 13개 전체 목록을
가진 원자적 설치 상태이며, 부분 목록이 아니다. 다음 전이 증명을 release digest에 결속한다.

- `baseReleaseDigest`: 현재 클러스터에 설치된 직전 lock
- `changedComponents`: 이번에 실제로 다시 빌드한 component의 정렬된 집합
- 목록에 없는 component: 직전 lock의 repository·image digest·source revision·registry
  요구를 byte-for-byte 계승
- 목록에 있는 component: 새 source revision과 digest를 사용하며 실제로 직전 lock과 달라야 함

component lock은 localhost `edge`의 **upgrade 전용** 계약이다. fresh bootstrap,
`candidate`/`stable`, signed Release BOM 승격에는 사용할 수 없다. 실패하면 직전의 완전한
base lock과 사전 확보한 artifact로 rollback한 뒤 그 상태를 다시 검증한다.

필수 컴포넌트:

```text
console
backend
dupaController
oaaGateway
oaaGovernedAdapter
notificationDispatcher
gitea
supabasePostgres
supabaseAuth
supabaseRest
supabaseStorage
giteaPostgres
recovery
```

Kanidm, 구형 Auth BFF, 별도 Console PostgreSQL, RustFS와 CBS image set은 release 구성요소가
아니다.

## 발행

`edge`와 GA의 빌드 권위는 다르며 하나의 Workflow로 섞지 않는다.

- `edge`: Windows Docker Desktop의 `OpenSphere-console/scripts/Publish-LocalEdge.ps1`만
  `linux/amd64`로 build/push한다. KST `yyyyMMddHHmm` immutable tag를 검증한 뒤
  non-anchor와 Console anchor 순서로 `edge`를 이동한다. lock에는
  `localhost-edge/v1` trust와 `build-authority=localhost`만 기록한다.
- `candidate`, `stable`, `ga`: GitHub Actions의
  `OpenSphere-console/.github/workflows/publish-ga-images.yml`만 clean multi-architecture
  rebuild, provenance, SPDX SBOM, signed Release BOM을 수행한다. v2 attestation trust는
  이 GA Workflow만 신뢰한다.

Console anchor는 어떤 채널에서도 마지막에 이동한다. Setup은 부분 발행 중의 혼합 revision,
edge-local 결과의 승격, 또는 retired edge Workflow의 attestation을 승인하지 않는다.
이미 설치된 retired GitHub Actions edge Lock은 provenance/SBOM 기록이 보존된 정확한 rollback
baseline으로만 읽을 수 있으며, 새 target release·재발행·승격에는 사용할 수 없다.

Setup CLI 자체는 OpenSphere OS image release와 별도로 비공개 GitHub Release에서 발행한다.
`OpenSphere-Setup-CLI/.github/workflows/publish-private-platforms.yml`은 저장소 visibility가
`private`인지 먼저 확인하고, Windows `amd64`, Linux `amd64`/`arm64`, macOS
`amd64`/`arm64` 자체 포함 아카이브와 `SHA256SUMS`를 Release asset으로 발행한다. 각
아카이브에는 Node SEA, PowerShell, kubectl과 플랫폼별 필수 runtime이 들어간다. 공개 npm
발행과 공개 download URL은 사용하지 않는다.

## 소비

Setup은 다음을 모두 만족해야 release lock을 반환한다.

- channel: `edge`, `candidate`, `stable`, `ga` 중 하나
- Console anchor가 공식 GHCR repository
- Release BOM predicate:
  `https://opensphere.io/attestations/release-bom/v1`
- promotion/GA는 signer workflow와 OIDC issuer가 GA trust root와 일치
- source repository와 40자리 source revision 일치
- 정확히 13개 component, 추가/누락 없음
- component image가 공식 repository의 `@sha256:<64 hex>`
- promotion/GA의 모든 component에 provenance와 SPDX SBOM attestation
- 지원 platform이 `linux/amd64`, `linux/arm64`
- 계산한 canonical release digest가 BOM/lock과 일치

component upgrade lock은 위 공통 항목과 함께 base digest 일치, 동일 channel/trust,
동일한 13개 component 집합, 명시된 변경 외의 byte-for-byte 계승을 추가로 검증한다.

Setup은 그 source revision에서 manifest, installer와 SQL migration을 받는다. manifest의 모든
image는 BOM digest로 치환되고 tag-only, upstream registry 또는 미해결 placeholder가 남으면
설치를 중단한다.

## 채널 선택

```powershell
opensphere-setup resolve --release edge --lock .\edge-lock.json
opensphere-setup bootstrap --release edge --lock .\edge-lock.json
```

- fresh install: 명령 시점의 채널을 한 번 resolve하고 lock 생성
- resume: 채널을 재조회하지 않고 클러스터 lock 사용
- explicit lock: 설치 입력 자체이며 cache hint가 아님
- upgrade: target과 현재 rollback artifact를 모두 사전 검증한 뒤 적용

현재 `edge`만 개발 설치 경로다. `candidate`, `stable`, `ga`는 Supabase PostgreSQL/Storage 및
Gitea/PostgreSQL의 격리 복구 drill·증거 승격 계약이 구현되기 전까지 HOLD다.

## GHCR 접근

공개 package는 anonymous pull Secret을 생성한다. 비공개 package는 paired stdin 계약만
허용한다.

```powershell
$env:GHCR_TOKEN | opensphere-setup resolve `
  --release edge `
  --registry-username <github-login> `
  --registry-token-stdin
```

토큰은 URL, argv, release lock, ConfigMap 또는 로그에 저장하지 않는다. Kubernetes에는
namespace별 `opensphere-ghcr-pull` Secret으로만 전달한다.

## 실패 정책

다음은 자동 복구 또는 추정 없이 fail-closed한다.

- BOM/attestation 부재 또는 trust root 불일치
- integrated/BOM release의 source revision 혼합
- component release의 base digest 불일치, 숨은 component 변경 또는 허위 변경 목록
- 누락·추가 component
- mutable/tag-only 이미지
- 지원 node architecture 부재
- release lock 없는 기존 OpenSphere namespace
- 구형 아키텍처 lock의 in-place 변환
- target 검증 실패 후 이전 release 재검증 실패

구형 설치 데이터 이관은 release 선택 기능이 아니다. 별도 승인된 export/import migration이
필요하며, fresh Supabase bootstrap이 구형 권위와 자동으로 병합하지 않는다.
