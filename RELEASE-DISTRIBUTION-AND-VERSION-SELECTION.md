# OpenSphere Release Distribution and Version Selection

Status: Supabase/Gitea architecture, Setup CLI 0.5

## 결정

OpenSphere 설치 입력은 mutable tag 목록이 아니라, Console anchor digest에 첨부된 서명
`OpenSphereReleaseBOM`이다. BOM은 한 source revision에서 빌드된 12개 필수 이미지를 하나의
원자적 release로 묶는다.

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
```

Kanidm, 구형 Auth BFF, 별도 Console PostgreSQL, RustFS와 CBS image set은 release 구성요소가
아니다.

## 발행

`OpenSphere-console/.github/workflows/publish-edge-images.yml`이 다음 순서로 발행한다.

1. Console 전체 계약 테스트와 production build
2. 12개 이미지를 `linux/amd64`, `linux/arm64`로 build/push
3. 각 digest에 GitHub Actions provenance와 SPDX SBOM attestation
4. 모든 digest와 `io.opensphere.source-revision` 재검증
5. 12개 컴포넌트 BOM 생성
6. Console anchor digest에 BOM attestation
7. non-anchor `edge` tag 이동
8. Console anchor `edge` tag를 마지막에 이동
9. 모든 mutable/immutable tag가 BOM digest와 일치하는지 재검증

Console anchor가 마지막에 이동하므로 Setup은 부분 발행 중 혼합 revision을 승인하지 않는다.

Setup CLI 자체는 OpenSphere OS image release와 별도로 비공개 GitHub Release에서 발행한다.
`OpenSphere-Setup-CLI/.github/workflows/publish-private-platforms.yml`은 저장소 visibility가
`private`인지 먼저 확인하고, Windows `amd64`, Linux `amd64`/`arm64`, macOS
`amd64`/`arm64` 자체 포함 아카이브와 `SHA256SUMS`를 Release asset으로 발행한다. 각
아카이브에는 Node SEA, PowerShell, kubectl과 플랫폼별 필수 runtime이 들어간다. 공개 npm
발행과 공개 download URL은 사용하지 않는다.

## 소비

Setup은 다음을 모두 만족해야 release lock을 반환한다.

- channel: `edge`, `candidate`, `stable` 중 하나
- Console anchor가 공식 GHCR repository
- Release BOM predicate:
  `https://opensphere.io/attestations/release-bom/v1`
- signer workflow와 OIDC issuer가 embedded trust root와 일치
- source repository와 40자리 source revision 일치
- 정확히 12개 component, 추가/누락 없음
- component image가 공식 repository의 `@sha256:<64 hex>`
- 모든 component에 provenance와 SPDX SBOM attestation
- 지원 platform이 `linux/amd64`, `linux/arm64`
- 계산한 canonical release digest가 BOM/lock과 일치

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

현재 `edge`만 개발 설치 경로다. `candidate`와 `stable`은 Supabase PostgreSQL/Storage 및
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
- source revision 혼합
- 누락·추가 component
- mutable/tag-only 이미지
- 지원 node architecture 부재
- release lock 없는 기존 OpenSphere namespace
- 구형 아키텍처 lock의 in-place 변환
- target 검증 실패 후 이전 release 재검증 실패

구형 설치 데이터 이관은 release 선택 기능이 아니다. 별도 승인된 export/import migration이
필요하며, fresh Supabase bootstrap이 구형 권위와 자동으로 병합하지 않는다.
