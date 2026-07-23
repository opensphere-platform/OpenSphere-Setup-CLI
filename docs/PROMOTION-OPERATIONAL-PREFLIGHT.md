# OpenSphere candidate/stable 운영 사전검증 Runbook

Status: **promotion HOLD**

이 절차는 candidate/stable에 필요한 외부 운영 조건을 읽기 전용으로 검사한다. 현재 Setup은
Supabase PostgreSQL, Supabase Storage, Gitea와 Gitea PostgreSQL을 함께 복구하는 signed
executor와 격리 drill 증거 계약이 완성되지 않았으므로 candidate/stable bootstrap과 upgrade를
의도적으로 거부한다.

## 사전 조건

1. 지원되는 원격 Kubernetes context
2. 운영자가 보증한 durable StorageClass
   - `opensphere.io/backbone-storage-profile=durable-v1`
   - `opensphere.io/encryption-at-rest=true`
   - `opensphere.io/failure-domain=multi-node|zone-redundant|region-redundant`
   - `reclaimPolicy=Retain`
   - `allowVolumeExpansion=true`
3. 클러스터 밖 HTTPS S3-compatible recovery endpoint와 CA
4. Console public hostname의 외부 CA TLS chain과 private key

## 사용자 소유 Secret

비밀값을 argv, Git, 로그 또는 release lock에 넣지 않는다.

```powershell
kubectl --context <production-context> create namespace platform-secrets

kubectl --context <production-context> -n platform-secrets create secret generic opensphere-recovery-target `
  --from-file=endpoint=./endpoint.txt `
  --from-file=bucket=./bucket.txt `
  --from-file=access_key=./access-key.txt `
  --from-file=secret_key=./secret-key.txt `
  --from-file=ca.crt=./recovery-ca.crt `
  --from-file=region=./region.txt

kubectl --context <production-context> -n platform-secrets create secret tls opensphere-console-public-tls `
  --cert=./console-fullchain.pem --key=./console.key
kubectl --context <production-context> -n platform-secrets annotate secret opensphere-console-public-tls `
  opensphere.io/shell-tls-profile=external-ca-v1
```

## 읽기 전용 preflight

```powershell
opensphere-setup preflight --release candidate `
  --context <production-context> `
  --storage-class <durable-storage-class> `
  --console https://console.example.com `
  --recovery-target-secret platform-secrets/opensphere-recovery-target `
  --shell-tls-secret platform-secrets/opensphere-console-public-tls
```

이 명령은 node/권한/StorageClass, 외부 endpoint 분리와 TLS profile을 검사한다. Secret 값은
출력하지 않는다. 성공은 운영 준비 입력이 형식적으로 유효하다는 뜻일 뿐 설치 승인이나 복구
증거가 아니다.

## HOLD 해제 조건

다음이 signed release에 들어오고 독립 클러스터에서 재현되어야 한다.

- Supabase PostgreSQL point-in-time backup/restore
- Supabase Storage object·metadata 일관 복구와 canary byte 검증
- Gitea DB, repository, LFS와 signing/control-plane 상태 복구
- 격리 namespace 또는 별도 cluster restore
- AAL2와 two-person 승인
- request → Gitea review/merge → executor receipt → Supabase append-only audit correlation
- 실패 주입, RTO/RPO, 원본과 복구 대상 digest/count 비교
- evidence promotion과 보존 정책

이 조건 전에는 `candidate` 또는 `stable` 설치 명령을 실행 경로로 문서화하거나 우회하지 않는다.
