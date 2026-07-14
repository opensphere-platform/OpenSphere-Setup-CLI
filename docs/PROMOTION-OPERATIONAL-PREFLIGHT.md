# OpenSphere candidate/stable 운영 사전검증 Runbook

이 절차는 **클러스터를 변경하지 않고** candidate/stable 설치에 필요한 외부 운영 조건을 검증한다. `edge`의 kind·로컬 검증을 candidate 또는 운영 승인으로 바꾸지 않는다.

## 1. 운영자 준비물

1. 지원되는 원격 Kubernetes context와 `kubectl` 권한
2. 스토리지 운영자가 보증한 StorageClass
   - `opensphere.io/backbone-storage-profile=durable-v1`
   - `opensphere.io/encryption-at-rest=true`
   - `opensphere.io/failure-domain=multi-node`, `zone-redundant` 또는 `region-redundant`
   - `reclaimPolicy=Retain`, `allowVolumeExpansion=true`
3. 클러스터 밖 HTTPS S3-compatible endpoint, bucket, access key, secret key, CA bundle
4. Console public hostname을 포함하는 외부 CA leaf + issuer chain과 대응 private key

StorageClass annotation은 단순한 사용자 선언이 아니라 CSI·암호화·장애 도메인 보장을 가진 스토리지 운영자의 인증이어야 한다.

## 2. 사용자 소유 Secret 준비

비밀값을 명령행 literal, Git, 로그 또는 설치 lock에 넣지 않는다. 보안 파일에서 Secret을 만들고, 설치 전과 후에도 `platform-secrets` namespace는 운영자가 소유한다.

```powershell
kubectl --context <production-context> create namespace platform-secrets

kubectl --context <production-context> -n platform-secrets create secret generic opensphere-audit-backup `
  --from-file=endpoint=./endpoint.txt `
  --from-file=bucket=./bucket.txt `
  --from-file=access_key=./access-key.txt `
  --from-file=secret_key=./secret-key.txt `
  --from-file=ca.crt=./backup-ca.crt `
  --from-file=region=./region.txt

kubectl --context <production-context> -n platform-secrets create secret tls opensphere-console-public-tls `
  --cert=./console-fullchain.pem --key=./console.key
kubectl --context <production-context> -n platform-secrets annotate secret opensphere-console-public-tls `
  opensphere.io/shell-tls-profile=external-ca-v1
```

`console-fullchain.pem`은 non-CA leaf 뒤에 issuer chain을 포함해야 한다. `localhost` self-signed certificate나 in-cluster RustFS endpoint는 candidate/stable에서 거부된다.

## 3. 읽기 전용 preflight

아래 명령은 API·node·권한·StorageClass와 두 Secret 계약을 검사한다. Secret 값은 출력하지 않는다. S3 credential의 실제 put/restore 검증은 bootstrap 중 recovery drill이 수행한다.

```powershell
opensphere-setup preflight --release candidate `
  --context <production-context> `
  --storage-class <durable-storage-class> `
  --console https://console.example.com `
  --backup-target-secret platform-secrets/opensphere-audit-backup `
  --shell-tls-secret platform-secrets/opensphere-console-public-tls
```

성공 출력에는 Kubernetes version/node 수, 선택 StorageClass, S3 endpoint·bucket·region, TLS hostname·만료일, production/TOTP 정책만 포함된다.

## 4. candidate 설치와 독립 증적

```powershell
opensphere-setup bootstrap --release candidate `
  --context <production-context> `
  --storage-class <durable-storage-class> `
  --console https://console.example.com `
  --backup-target-secret platform-secrets/opensphere-audit-backup `
  --shell-tls-secret platform-secrets/opensphere-console-public-tls

opensphere-setup verify --context <production-context> `
  --console https://console.example.com --require-zero-restarts
```

독립 감사자는 최초 관리자 onboarding, production TOTP, service credential 회전, 외부 backup object와 restore drill, `os` CLI 제어, immutable release lock, hostname TLS chain을 재현해야 한다. 이 증적과 재감사 승인 전에는 stable 승격 또는 운영 사용을 주장하지 않는다.
