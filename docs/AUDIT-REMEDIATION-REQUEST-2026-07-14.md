# OpenSphere Console edge — 시정 재감사 요청서

- 작성일: 2026-07-14
- 요청 범위: 2026-07-14 통합 기술감사(`INT-AUD-001`~`016`)의 P0/P1 시정 기준선
- 구현 기준선: `OpenSphere-console@4c44bbb`, `OpenSphere-Setup-CLI@b0261be`
- 대상 채널: `edge` (개발·검증 채널)
- 판정 요청: 시정 항목의 독립 재검증. 이 문서는 `candidate` 승격이나 운영 사용 승인이 아니다.

## 1. 변경 불변식

1. 설치 대상은 9개 OpenSphere 이미지의 **digest lock**이다. tag만으로 설치하지 않는다.
2. 각 이미지는 GHCR에 결박된 GitHub Actions provenance와 SPDX SBOM을 모두 검증해야 한다. 하나라도 실패하면 설치·업그레이드·rollback은 중단한다.
3. `audit_log`의 런타임 role `console`은 `NOSUPERUSER`, `NOBYPASSRLS`, 비소유자이며 `SELECT, INSERT`만 가진다. 소유자 `opensphere_audit_owner`는 `NOLOGIN`이고 append-only trigger는 `ENABLE ALWAYS`이다.
4. Setup은 Console Service의 loopback port-forward를 사용해 bootstrap 결과와 Console-native `os`를 검증한다. Docker Desktop의 LoadBalancer 주소를 성공 조건으로 사용하지 않는다.
5. `candidate`/`stable`은 운영자가 제공한 외부 CA TLS와 외부 S3 호환 백업 대상 없이는 클러스터를 변경하지 않고 실패한다. 두 조건은 `edge`에 완화되지 않는다.
6. `edge`는 각 구성요소가 개별적으로 끝난 시점에 이동하지 않는다. 9개 불변 `sha-*` 이미지를 provenance/SBOM까지 발행한 뒤, 하나의 release job이 동일 source revision을 재확인하고 채널 태그를 전환한다. Setup은 그 짧은 태그 전파 구간에도 혼합 revision을 lock하거나 설치하지 않는다.

## 2. 자동화 증거

| 증거 | 결과 | 확인 범위 |
|---|---|---|
| Console 회귀·채널 발행 검증 | 91/91 통과 | extension uninstall 수렴, native CLI·인증 경계, 채널을 모든 불변 이미지가 준비된 뒤에만 전환하는 workflow 계약 |
| Console publish run `29328006030` | 성공 | 9개 `linux/amd64,linux/arm64` 이미지, GitHub provenance와 SPDX SBOM, 마지막 `publish-edge` release 전환 |
| Setup 단위·계약 테스트 | 70/70 통과 | provenance/SBOM, lock 무결성, 권한·백업·TLS·service credential 게이트, multi-arch, port-forward, redacted 증적 수집 |
| GitHub Actions run `29327502987` (attempt 2) | 성공 | `edge` 해석, development/production 새 kind clean bootstrap, 과거 서명 lock → 현재 lock upgrade → 과거 lock rollback |
| clean-cluster 라이브 결과 | 성공 | 모든 설치 경로에서 12 Pod / 11 Service, digest lock, PostgreSQL backup 및 비파괴 restore drill 완료 |
| 보존 증적 | 성공 | 90일 GitHub Actions artifact에 release inventory, 명시적 ClusterRole/Binding, network policy, endpoint, redacted PostgreSQL 권한 경계 보존 |

검증 실행 링크: <https://github.com/opensphere-platform/OpenSphere-console/actions/runs/29328006030>, <https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/29327502987>

## 3. 감사 지적별 시정 상태

| 감사 ID | 시정 상태 | 재감사에서 확인할 핵심 |
|---|---|---|
| `INT-AUD-001` P0 | 구현 및 clean-cluster 라이브 검증 완료 | 보존 artifact에서 런타임 `console` role의 `superuser=false`, `bypassrls=false`, audit writer 권한 false를 직접 확인 |
| `INT-AUD-002` P1 | 구현 및 CI 검증 완료 | 9개 이미지 모두 OCI-bound provenance와 SPDX SBOM을 fail-closed로 검증하고, complete release가 되기 전 `edge`를 전환하지 않는지 확인 |
| `INT-AUD-003` P1 | 구현·회귀 테스트 완료 | `/api/identity`를 포함한 관리 표면이 매 요청 introspection 결과의 활성 상태·현재 역할을 쓰는지, 강등/폐기 직후 거부되는지 실증 |
| `INT-AUD-004` P1 | edge backup/restore drill 구현·CI 검증 완료; 승격 채널 외부 저장소 증거는 미제출 | candidate/stable에서 외부 S3 대상, CA trust, backup 및 restore drill을 실제 운영 엔드포인트로 검증 |
| `INT-AUD-005` P1 | 구현·clean kind 검증 완료 | Service port-forward 기반 verify와 `linux/amd64`, `linux/arm64` 검증; 기본 runtime은 12 Pod/11 Service이며, 별도 원격 지원 K8s에서 독립 재현 권고 |
| `INT-AUD-006` P1 | 구현·회귀 테스트 완료 | service credential TTL, Secret의 stdin 전달, 만료 전 rotate 명령 및 실제 회전 후 구 자격 폐기를 검증 |
| `INT-AUD-008` P2 | 승격 채널 gate 구현·회귀 테스트 완료 | candidate/stable이 production 인증 프로파일(TOTP 강제) 외 값을 거부하는지 확인 |
| `INT-AUD-009` P2 | 구현 완료 | 감사 레코드에 GUI/CLI 출처가 non-null로 남는지 확인 |
| `INT-AUD-010` P2 | P0 role 분리와 함께 시정 | `BackboneClaim`/Secret이 owner가 아닌 런타임 최소권한 role을 배포하는지 확인 |
| `INT-AUD-011` P2 | 구현 완료 | `/bff/healthz`가 CBS 준비 상태를 반영해 503을 반환하는지 장애 주입으로 확인 |
| `INT-AUD-012` P2 | 구현·회귀 테스트 완료 | CLI discovery/registry의 content-type 및 schema fail-closed 검증 확인 |
| `INT-AUD-016` P2 | 구현·회귀 테스트 완료 | Setup Secret material이 process argv/stderr에 노출되지 않는지 확인 |

## 4. 승격 보류 항목

아래는 구현된 차단 규칙만으로 대체할 수 없는 **외부 운영 증거**다. 증거가 제출되고 독립 재감사를 통과하기 전까지 `candidate` 승격과 운영 사용은 계속 **HOLD**다.

1. 운영자가 관리하는 외부 CA의 TLS Secret. Console URL의 hostname, 완전한 issuer chain, 키 일치 및 `opensphere.io/shell-tls-profile=external-ca-v1` annotation이 필요하다.
2. 클러스터 밖의 S3 호환 백업 대상. endpoint, bucket, access key, secret key, CA bundle과 실제 restore 결과가 필요하다.
3. 운영 StorageClass의 `durable-v1`, encryption-at-rest, 다중 장애 도메인, `Retain`, 확장 가능 속성 검증.
4. 실제 지원 원격 Kubernetes에서 clean bootstrap, 최초 관리자 onboarding, TOTP, service credential rotation, backup/restore 및 CLI 제어를 독립 수행한 증거.

참고 설치 형태(실행 전 운영자가 Secret과 저장소를 제공해야 함):

```powershell
opensphere-setup bootstrap --release candidate --backup-target-secret platform-secrets/opensphere-audit-backup --shell-tls-secret platform-secrets/opensphere-console-public-tls
```

## 5. 아직 미시정인 UI·접근성 범위

`INT-AUD-013`~`015` 및 P3 UI 항목은 이번 기준선에 포함하지 않는다. 이유는 화면 컴포넌트 변경에는 제품 소유자의 사전 선택이 필요하기 때문이다. 특히 자작 drawer/notification/prompt를 Clarity v18의 어느 승인 컴포넌트로 교체할지와 사용 흐름을 확정한 뒤 별도 변경·브라우저 접근성 검증으로 처리한다.

## 6. 재감사 요청 판정

1. `INT-AUD-001`~`006`의 시정 여부를 새 기준선과 위 CI 원본으로 독립 검증한다.
2. 외부 운영 증거가 없는 경우 `candidate`/운영 사용을 승인하지 않는다.
3. P2 UI·접근성 항목은 후속 범위로 명시하고, 이번 재감사에서 미해결로 유지한다.
4. 모든 재현 결과는 release lock digest, source revision, Kubernetes context 및 timestamp와 함께 보존한다.
