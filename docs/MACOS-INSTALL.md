# macOS 포터블 Setup 실행 Runbook

이 문서는 Apple Silicon과 Intel macOS 관리 호스트에서 공개 OpenSphere Setup Release를
사용해 Docker Desktop Kubernetes 또는 원격 Kubernetes에 설치하는 절차다. Kubernetes
노드는 macOS가 아니라 `linux/amd64` 또는 `linux/arm64`여야 한다.

## 1. 준비

macOS 기본 `sh`, `curl`, `tar`, `mktemp`, `awk`, `shasum`만 사용한다. 공식 macOS 아카이브는
Node.js, PowerShell과 kubectl을 포함하므로 Homebrew, Git 또는 별도 개발 도구를 요구하지 않는다.

Docker Desktop을 사용하는 경우 Settings → Kubernetes에서 Kubernetes를 활성화하고 적용한다.
클러스터 연결과 상태는 압축 해제 후 `doctor`가 포함된 kubectl로 확인한다.

검증된 Docker Desktop 시작 프로필은 10 CPU와 16GiB RAM이다. 이는 최소값이 아니다.
OpenSphere PVC 요청 합계는 98Gi이므로 Docker Desktop VM 디스크와 선택한 StorageClass가
이를 provision할 수 있어야 한다.

## 2. 공개 GitHub Setup 포터블 실행

`PLATFORM-INSTALL.md`의 SHA256SUMS 검증 절차로 `opensphere-setup-darwin-arm64.tar.gz`(Apple Silicon) 또는 `opensphere-setup-darwin-amd64.tar.gz`(Intel)를 확인하고 압축을 푼다. 사용자 bin 설치나 PATH 등록은 없다.

```bash
tar -xzf opensphere-setup-darwin-arm64.tar.gz
SETUP="$PWD/opensphere-setup-darwin-arm64/opensphere-setup"
"$SETUP" version
```

Intel은 파일과 폴더의 `arm64`를 `amd64`로 바꾼다. 다음 명령에서도 같은 `$SETUP` 경로를 사용한다.

## 3. 무변경 진단

```bash
"$SETUP" doctor \
  --release edge \
  --context docker-desktop \
  --storage-class hostpath \
  --console https://localhost:1114
```

진단이 실패하면 bootstrap을 실행하지 않는다. `doctor`는 Kubernetes를 변경하지 않으며
로컬 필수 명령(`edge`는 `gh` 불필요), Kubernetes v1.30+, 노드 플랫폼·Ready·권한, StorageClass, localhost
포트 1114, GitHub/GHCR 공급망 경로와 41개 필수 manifest·migration·installer의 실제
다운로드·렌더링을 한 번에 검사한다.

## 4. 설치

공개 GHCR package:

```bash
"$SETUP" bootstrap \
  --release edge \
  --context docker-desktop \
  --storage-class hostpath \
  --console https://localhost:1114
```

비공개 GHCR package:

```bash
export GHCR_TOKEN='read-packages-token'
printf '%s' "$GHCR_TOKEN" | "$SETUP" bootstrap \
  --release edge \
  --context docker-desktop \
  --storage-class hostpath \
  --console https://localhost:1114 \
  --registry-username '<github-login>' \
  --registry-token-stdin
unset GHCR_TOKEN
```

토큰을 명령 인자에 직접 넣지 않는다.

## 5. localhost TLS

Setup이 만든 개발 CA는 `shell-tls` Secret의 `ca.crt`에 보존된다. HTTPS를 사용할 때 macOS
로그인 Keychain에 신뢰 CA로 등록한다.

```bash
kubectl --context docker-desktop -n opensphere-console \
  get secret shell-tls -o jsonpath='{.data.ca\.crt}' \
  | base64 --decode > opensphere-local-development-ca.crt

security add-trusted-cert -r trustRoot \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  opensphere-local-development-ca.crt
```

Keychain 암호 확인이 표시될 수 있다. 개발 환경에서 CA 등록을 원하지 않으면 fresh edge
설치에 한해 다음 loopback HTTP origin을 사용할 수 있다.

```bash
"$SETUP" bootstrap \
  --release edge \
  --context docker-desktop \
  --storage-class hostpath \
  --console http://localhost:1114
```

원격 환경과 candidate/stable에는 외부 HTTPS 인증서 Secret이 필요하며 HTTP를 사용하지 않는다.

## 6. 완료 확인

bootstrap은 플랫폼을 검증하고 종료한다. 호스트 os CLI는 자동 설치하지 않는다. 필요한 운영자만 별도로 `"$SETUP" install-cli`를 실행한다.

```bash
"$SETUP" verify \
  --context docker-desktop \
  --console https://localhost:1114

kubectl --context docker-desktop -n opensphere-console \
  get configmap opensphere-installation-evidence

```

Setup은 PATH 등록이 필요 없다. 별도 os CLI 설치를 명시한 경우에만 `install-cli --add-to-path`를 선택할 수 있다. 부분 실패는 [`PARTIAL-FAILURE-RECOVERY.md`](PARTIAL-FAILURE-RECOVERY.md)를 따른다.
