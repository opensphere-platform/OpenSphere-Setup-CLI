# Registry 인증·운영 권한 인계 — registry-auth/v1

> 현재 설치 오류 및 edge.22 수정 상태는 [설치 복구 기록](CONSOLE-INSTALL-RECOVERY-EDGE22.md)을 따른다. 아래 edge.21 발행 당시 관측은 이력이다. GHCR manifest 접근은 이후 실제 doctor에서 통과했으며 현재 장애는 Console installer SQL이다.

2026-09-03. **Setup edge.21 공개 발행 완료 / Console 운영 인계는 로컬 구현·미발행 / Kubernetes 미적용.** 실제 발행 상태는 [발행 기록](OAUTH-EDGE21-PUBLICATION-STATUS.md)을 따른다. OAuth 로그인·갱신은 실측 통과했으나 private GHCR manifest 접근은 실패했으며 opt-in 시험 기능으로 유지한다.

## 책임과 경계

| 주체 | 책임 | 맡지 않는 책임 |
|---|---|---|
| Setup CLI | 명시적 GitHub device 인증 또는 stdin credential 검사, identity·read:packages 검증, 고정 digest 접근 검사, 초기 Secret 인계, Console 관측 확인 | Windows 설치, 로그인 토큰 로컬 캐시, 사용자 전체 권한 복제, 기존 runtime refresh authority 덮어쓰기 |
| Console credential broker | 승인된 운영 credential만 보관·갱신·전파하고 만료/철회/Unknown 상태 제공 | 권한 자체의 영구 보장, 철회된 조직 권한 자동 복구, 임의 registry/namespace 접근 |
| Kubernetes kubelet | namespace의 imagePullSecret으로 이미지 다운로드 | GitHub OAuth 로그인 또는 refresh-token 갱신 |
| 운영자 | OAuth 앱 승인, 조직/SSO 권한 승인, 필요 시 재인증, PAT 수동 교체 | 정상적인 자동 갱신마다 Setup 실행 |

2026-09-03 사용자가 여섯 Secret에 한정한 get/update 권한 예외를 승인했다. C_API 배포 원본에 5개 namespace Role/RoleBinding, 600초 projected ServiceAccount token, registry-auth/v1 활성화 환경 변수와 필수 egress를 반영했다. automount는 false를 유지한다. Console의 클러스터 적용 및 운영 인계 이미지 발행은 아직 하지 않았다. Setup edge.21 OAuth 시험판은 별도로 공개 발행했다. 기존 C_REG의 catalog/read-model 책임과 C_EXT의 Extension 실행 책임은 유지한다. 추가 repository/process/datastore/framework/dependency는 없다.

## 저장 계약

- owner Secret: `opensphere-console/opensphere-registry-auth`, Opaque, `state.json`. 접근 토큰·refresh token·device_code·generation·관측·진행 중 작업을 저장한다. public Client ID만 별도 `oauth-client-id` key로 제공할 수 있다.
- pull Secret: 5개 관리 namespace의 `opensphere-ghcr-pull`. `.dockerconfigjson`에는 접근 토큰만 들어간다. refresh token, device_code, 사용자 session cookie, Supabase 키, GitHub repo/write 권한은 넣지 않는다.
- namespace: opensphere-console-data, opensphere-console-change, opensphere-monitoring, opensphere-console, opensphere-system.
- pull Secret generation annotation: `opensphere.io/credential-generation`. owner Secret과 동일 generation을 전부 다시 읽은 후에만 전파 완료로 관측한다.
- Kubernetes Secret의 base64는 암호화가 아니다. 실제 보호는 RBAC·TLS·클러스터 저장 암호화 및 backup 접근 통제에 달려 있다. 이번 코드가 etcd 암호화를 자동 설정한다고 주장하지 않는다.
- owner Secret은 Setup이 초기 생성한다. runtime은 정해진 Secret의 get/update만 필요하며 list/create/delete, wildcard Secret, ClusterRole은 필요하지 않다.
- Setup release lock, portable cache, stdout, 감사 원장, API 응답에는 토큰을 저장하지 않는다. provider 오류 본문도 노출하지 않는다.

## 인증과 실제 접근 판정

`--registry-auth auto|oauth|pat|anonymous`. 기본 auto는 기존 credential이 있으면 검사하고, 없으면 anonymous로 시도한다. OAuth는 명시적 선택이며 무인 실행에서 임의의 브라우저 로그인을 시작하지 않는다.

작업본 시험 명령:

```powershell
node src/cli.mjs doctor --release edge --context docker-desktop --registry-auth oauth
```

사용자가 등록 후 제공한 공개 Client ID `Ov23lijzo43hyJMnNcMb`를 Setup에 내장했다. 기본 실행에 별도 ID 입력은 필요 없고 `--github-client-id`는 명시적 override다. Client ID는 공개 식별자다. device flow에 client_secret을 넣거나 다른 앱의 Client ID를 빌리지 않는다. 브라우저에서 github.com/login/device와 일회용 user code를 승인하며 device_code는 사용자 화면에 출력하지 않는다.

요청 scope는 `read:packages offline_access`. 응답 scope와 /user의 X-OAuth-Scopes를 확인해 repo/write:packages/delete:packages 등 추가 권한이 있으면 거부한다. 일반 gh login에 추가 scope를 붙인 토큰은 repo 권한 등이 남으므로 runtime 인계 대상이 아니다. 전용 읽기 token을 사용한다.

/user identity와 GHCR /token 성공만으로 충분하지 않다. 공급망 검증된 release의 각 private image digest에 대해 manifest HEAD가 성공하고 Docker-Content-Digest가 일치해야 한다. 조직/SSO 제한과 패키지별 접근 차이는 실제 검사 결과로 드러난다.

GitHub GHCR 문서는 PAT classic을 공식 사용자 인증 수단으로 안내한다. OAuth 문서의 device/refresh 지원과 GHCR 지원은 별도 판정이다. 등록 앱을 사용한 실제 GHCR 시험 전에는 OAuth 운영 지원 완료를 주장하지 않는다. 공개 이미지에 인증을 강제하지 않는다.

## 런타임 시나리오

1. Setup: 인증 → scope/identity 검사 → signed release 검증 → 대상 Console의 활성 registry-auth/v1 계약 확인 → 초기 state/pull Secret 생성 → 핵심 rollout → Console이 같은 generation과 5개 namespace를 관측한 것 확인. 미지원 Console에는 OAuth refresh 권한을 쓰지 않는다. doctor는 Kubernetes 쓰기를 하지 않는다.
2. 갱신: 만료 15분 전 resourceVersion CAS로 작업권을 획득 → 감사 accepted → provider refresh → 새 pair를 owner Secret에 먼저 영속화 → 다음 reconcile에서 identity/digest 검사 → 접근 토큰만 전파 → 5개 Secret 재관측 → 감사 결과 → Ready.
3. 다중 replica: owner resourceVersion 및 pull Secret resourceVersion을 함께 검사한다. 오래된 작업자가 후임 generation을 덮어쓰지 못한다. HA 분산 상태 단위 검증이며 실제 HA 클러스터 검증 완료 주장은 아니다.
4. 갱신 중 네트워크 단절/재시작: provider가 old refresh/access token을 폐기했을 수 있으므로 동일 refresh token을 무작정 재사용하지 않는다. 120초 이상 남은 작업 fence는 Unknown/재인증 필요로 처리한다.
5. 재인증: Console 기존 GHCR 화면 → 최근 MFA/console.registry.manage/CSRF/idempotency/reason → durable operation → device code 시작 → 브라우저 승인 → 현재 사용자 권한과 최근 MFA 재검증 → 새 credential 인계. code는 요청한 사용자에게만 표시한다. 권한이 철회됐거나 MFA 유효 시간이 지나면 완료하지 않는다.
6. PAT: 자동 refresh가 없으며 manual로 표시한다. 관측 가능한 만료 일시를 표시하고 거부/만료를 감지하면 재인증 또는 token 교체를 요구한다. 만료 정보가 없으면 없음으로 표시하며 영구 권한이라고 부르지 않는다.
7. 제거: 현재 권한과 exact confirmation 확인 후 refresh token을 포함한 owner credential을 비우고 모든 pull Secret을 anonymous로 동기화한다. GitHub 계정 전체 앱 권한을 자동 철회하지 않는다. 실행 중인 컨테이너 종료를 의미하지 않는다.
8. 기존 설치: Setup은 Console이 소유하는 credential을 교체하지 않는다. upgrade용 인증과 runtime 재인증을 구분한다. edge.22의 OAuth upgrade는 임시 credential을 기존/대상 공급망 검증에만 사용하고 기존 owner/pull Secret을 보존한다. 운영 credential 자체를 바꾸는 경우에만 Console 재인증 또는 별도 복구 절차가 필요하다.

## 상태·검증 의미

Pending / AwaitingAuthorization / Ready / Degraded / Stale / ReauthorizationRequired / Removing / Anonymous. Ready는 provider identity + 필요한 manifest 접근 + Secret generation 전파 관측을 뜻한다. kubelet의 신규 cold-pull이나 모든 workload rollout을 이 값 하나로 입증하지 않는다. 마지막 검증이 20분 넘으면 Stale로 표시한다. accepted 작업과 설치 완료를 구분한다.

HTTP: POST `/api/admin/extensions/registry-connections/opensphere-ghcr/oauth`, GET/PUT/DELETE 기존 connection 경로. OpenAPI·JSON Schema·HTTP 테스트가 같은 경로를 고정한다. DB에는 credential 원문 대신 기존 operation digest와 비밀값 없는 lifecycle 감사만 저장한다. migration 0027은 신규 권한 확인/감사 함수 두 개이며 실행 DB 적용은 아직 하지 않았다.

## 승인된 배포 권한과 네트워크

2026-09-03 사용자 발언 “승인한다”는 [활성화 검토 요청](../../OpenSphere-Console/docs/REGISTRY-AUTH-ACTIVATION-REVIEW.md)에 적힌 여섯 Secret 범위에 대한 승인이다. 모든 Secret 접근, 관리자 PAT 이관, 다른 workload 권한, 공개 발행 완료를 의미하지 않는다.

- 각 5개 namespace의 Role/RoleBinding은 opensphere-console-api ServiceAccount 하나에만 연결한다. resourceNames로 pull Secret 5개와 owner Secret 1개를 고정하고 verbs는 get/update뿐이다.
- ServiceAccount와 Pod automount는 false이며 api container에만 읽기 전용 projected token/CA를 마운트한다. 요청 수명은 600초이고 런타임은 매 API 요청마다 token/CA를 다시 읽는다. 장기 ServiceAccount Secret은 생성하지 않는다.
- Setup은 설치·업그레이드의 manifest materialization 단계에서 default/kubernetes Service와 해당 EndpointSlice를 읽는다. Service IP와 Ready endpoint의 각 /32 또는 /128, 실제 HTTPS 포트만 렌더링한다. 주소·포트가 누락되거나 유효하지 않으면 namespace/credential 생성 전에 실패한다. API endpoint 변경 후에는 Setup을 통한 매니페스트 재적용이 필요하며 C_API 자체에 NetworkPolicy 수정 권한을 주지 않는다.
- 공급자 통신에는 TCP/443 egress가 필요하다. 표준 NetworkPolicy는 FQDN 제한을 제공하지 않으므로 다른 443 목적지도 네트워크 계층에서 허용된다. 애플리케이션의 고정 origin·redirect 거부와 별개로 이 잔여 위험을 유지한다. 다른 포트의 광역 egress는 허용하지 않는다.
- 14개 Kubernetes 객체에 대해 실제 localhost API 주소를 사용한 client dry-run과 strict schema 검증이 통과했다. 테스트용 렌더링 파일은 0으로 채운 가상 image digest를 사용하므로 설치용 artifact가 아니다. admission/RBAC 실제 적용, CNI 정책 집행, Pod token rotation, cold-pull을 이 결과로 주장하지 않는다.

## 운영 활성화 전에 남은 실제 검증

- 완료: 사용자 제공 Client ID로 Device Flow 시작과 실제 사용자 승인을 확인했다. read:packages, 8시간 접근 토큰, refresh token 발급, 동일 identity 갱신, 이전 접근 토큰 거부를 실측했다. App 소유 유형은 Client ID만으로 추정하지 않는다.
- 완료: 사용자가 승인한 좁은 Secret 권한 예외를 배포 manifest·설계 trust boundary·배포 검증 규칙에 함께 반영했다. 운영 클러스터의 실제 적용·검증은 별도다.
- 격리 DB에서 migration/RLS/grant·최근 MFA 회귀 검증. 현재 환경에 psql/postgres 실행 파일이 없어 이 시험은 실행하지 못했다.
- 미완료: 등록 앱으로 실제 private GHCR manifest 접근은 갱신 전후 HTTP 404(MANIFEST_UNKNOWN)였다. 패키지·태그 존재와 접근 조건을 별도 확인해야 한다. GitHub Packages org API의 404는 계정 유형(User)에 맞지 않는 경로를 사용한 결과이므로 부재/권한 판단의 근거로 쓰지 않는다. Kubernetes에서 새 노드 cold-pull/재시작/전파/복구는 미실행이다. 설치 잠금이 변경되면 runtime-owned image 목록을 갱신하고 새 digest를 재검증하는 단위 시험은 통과했으며, 실제 release upgrade에서도 확인해야 한다.
- Setup OAuth 시험판과 Console 운영 릴리스를 구분한다. Setup edge.21 발행은 Console image/build/BOM 발행 또는 runtime 활성화를 뜻하지 않는다. 이번 검증으로 GHCR 이미지나 localhost runtime을 변경하지 않았다.

## 근거

- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
