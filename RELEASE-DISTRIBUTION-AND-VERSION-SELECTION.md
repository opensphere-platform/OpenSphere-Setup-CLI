# OpenSphere Release Distribution and Version Selection

Status: Supabase + Gitea + Beszel backbone, Setup CLI 0.5 target contract

## 결정

OpenSphere 설치 입력은 mutable tag 목록이 아니라 Console anchor digest에 첨부된 서명 `OpenSphereReleaseBOM`이다. BOM은 한 source revision에서 빌드된 **18개 canonical component**를 하나의 원자적 release로 묶는다. 설치 lock은 같은 release tag와 source revision에 결속된 **3개 auxiliary artifact**도 반드시 보존한다.

`integrated` lock은 BOM과 동일한 통합 release다. 로컬 `edge`의 영향을 받은 이미지만 다시 빌드하는 경우에는 `component` lock을 사용할 수 있다. 이 lock도 canonical 18개와 auxiliary 3개의 전체 목록을 갖는 완전한 설치 상태이며 부분 목록이 아니다. 다음 전이 증명을 release digest에 결속한다.

- `baseReleaseDigest`: 현재 클러스터에 설치된 직전 lock
- `changedComponents`: 이번에 실제로 다시 빌드한 canonical component의 정렬된 집합
- 목록에 없는 canonical component: 직전 lock의 repository, image digest, source revision과 registry 요구를 byte-for-byte 계승
- 목록에 있는 canonical component: 새 source revision과 digest를 사용하며 실제로 직전 lock과 달라야 함
- auxiliary artifact: 같은 immutable release tag에서 해석하며 repository, digest, source revision과 `io.opensphere.release-scope=auxiliary`를 검증

component lock은 localhost `edge`의 **upgrade 전용** 계약이다. fresh bootstrap, `candidate`/`stable`, signed Release BOM 승격에는 사용할 수 없다. 실패하면 직전의 완전한 base lock과 사전 확보한 artifact로 rollback한 뒤 그 상태를 다시 검증한다.

Canonical 18개:

```text
console
consoleApi
extensionController
registry
osaaGateway
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

Auxiliary 3개:

```text
cliArtifacts
osShellControl
osShellRuntime
```

Setup fresh bootstrap은 canonical 중 13개 bootstrap core와 `cliArtifacts`만 배포한다. `osaaGateway`, `osdst`, `osaaGovernedAdapter`, `notificationDispatcher`, `recovery` 5개는 Console이 설치 후 활성화하는 available module이다. `osShellControl`과 `osShellRuntime`도 Console에서 활성화하지만, Console이 mutable `:edge`를 다시 해석하지 않도록 exact digest를 최초 installation lock에 보존한다.

DUPA의 target control-plane 책임은 `extensionController`에 통합되었다. legacy `backend`와 `dupaController` 이름은 현행 canonical 집합이 아니며 과거 lock 복구와 명시적 정리 경로에서만 해석한다. Kanidm, 구형 Auth BFF, 별도 Console PostgreSQL, RustFS와 CBS image set도 release 구성요소가 아니다.

## 발행

`edge`와 promotion release의 빌드 권위는 분리한다.

- `edge`: Windows Docker Desktop의 `OpenSphere-Console/scripts/Publish-LocalEdge.ps1`이 host-native 이미지를 build/push한다. KST `yyyyMMddHHmm` immutable release tag를 검증한 뒤 non-anchor와 Console anchor 순서로 `edge`를 이동한다. canonical에는 `io.opensphere.release-scope=canonical`, auxiliary에는 `io.opensphere.release-scope=auxiliary`가 있어야 한다.
- `candidate`: `OpenSphere-Console/.github/workflows/publish-candidate-images.yml`이 clean multi-architecture build, provenance, SPDX SBOM과 signed Release BOM을 만든다.
- `stable`/GA promotion: `OpenSphere-Console/.github/workflows/promote-release.yml`이 검증된 candidate release를 승격한다. 존재하지 않는 별도 GA image-build workflow를 신뢰하지 않는다.

Console anchor는 어떤 채널에서도 마지막에 이동한다. Setup은 부분 발행 중 혼합 revision, edge-local 결과의 승격, retired edge workflow의 attestation을 승인하지 않는다. 과거 GitHub Actions edge lock은 정확한 rollback baseline으로만 읽을 수 있으며 새 target release, 재발행, 승격에는 사용할 수 없다.

Setup CLI는 OpenSphere OS image release와 분리된 공개 immutable GitHub Release에서 발행한다. `publish-platforms.yml`은 public visibility를 확인하고 5개 플랫폼 포터블 아카이브, Windows 단일 온라인 실행기 `opensphere-setup.exe`, `SHA256SUMS`를 발행한다. Setup을 호스트에 설치하거나 PATH를 등록하지 않는다. Windows 실행기는 검증된 런타임을 TEMP에서 실행한 뒤 정리한다. 압축형 패키지는 사용자가 푼 자리에서 실행한다. 실행 계약은 `docs/PORTABLE-EXECUTION-CONTRACT.md`다. `package.json`의 `private: true`는 npm 오발행을 막는다. Setup 공개 여부와 Console GHCR 접근 정책은 분리한다.

Setup CLI package 실행 버전 선택은 OCI image 채널과 별도다. `--version <semver>`는 `setup-v<semver>` immutable GitHub Release를 직접 선택한다. `--channel edge|candidate|stable`은 public `main`의 `channels/<channel>` 포인터를 한 번 읽고 그 exact immutable Release로 고정한다. `edge`는 `setup-v<semver>-edge.<sequence>`, `candidate`는 `setup-v<semver>-candidate.<sequence>`, `stable`은 prerelease suffix 없는 `setup-v<semver>`만 허용한다. 미준비 채널은 `HOLD`로 명시하며 fallback하지 않는다. Release workflow는 package version, channel pointer와 GitHub prerelease flag가 일치하지 않으면 발행을 거부한다. 이 package selector는 Console의 `--release` 또는 signed `--lock`을 대체하지 않는다.

## 소비

Setup은 다음을 모두 만족해야 release lock을 반환한다.

- channel: `edge`, `candidate`, `stable`, `ga` 중 하나
- Console anchor가 공식 GHCR repository
- Release BOM predicate: `https://opensphere.io/attestations/release-bom/v1`
- candidate/stable/GA signer workflow와 OIDC issuer가 채널 trust root와 일치
- source repository와 40자리 source revision 일치
- canonical component 정확히 18개, 추가나 누락 없음
- auxiliary artifact 정확히 3개, 추가나 누락 없음
- 모든 image가 공식 repository의 `@sha256:<64 hex>`
- candidate/stable/GA canonical component에 provenance와 SPDX SBOM attestation
- 지원 platform이 `linux/amd64`, `linux/arm64`
- 계산한 canonical release digest가 BOM/lock과 일치

component upgrade lock은 공통 항목과 함께 base digest, 동일 channel/trust, 동일한 canonical 18개와 auxiliary 3개 집합, 명시된 변경 외 byte-for-byte 계승을 추가 검증한다.

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
