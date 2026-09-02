# macOS private 설치 Runbook

이 문서는 Apple Silicon과 Intel macOS 관리 호스트에서 비공개 OpenSphere Setup 저장소를
사용해 Docker Desktop Kubernetes 또는 원격 Kubernetes에 설치하는 절차다. Kubernetes
노드는 macOS가 아니라 `linux/amd64` 또는 `linux/arm64`여야 한다.

## 1. 준비

필수 외부 도구:

```bash
brew install git gh
git --version
gh --version
```

공식 macOS 아카이브는 Node.js, PowerShell과 kubectl을 포함하므로 이 세 도구를 호스트에
별도로 설치하지 않는다.

Docker Desktop을 사용하는 경우 Settings → Kubernetes에서 Kubernetes를 활성화하고 적용한
뒤 다음 상태를 확인한다.

```bash
kubectl config use-context docker-desktop
kubectl get nodes
kubectl get storageclass
```

검증된 Docker Desktop 시작 프로필은 10 CPU와 16GiB RAM이다. 이는 최소값이 아니다.
OpenSphere PVC 요청 합계는 98Gi이므로 Docker Desktop VM 디스크와 선택한 StorageClass가
이를 provision할 수 있어야 한다.

## 2. 비공개 GitHub 인증과 Setup 다운로드

GitHub 기기 코드는 메일로 발송되는 값이 아니라 `gh auth login`을 실행한 터미널에 표시된다.
저장소 `Contents: read` 권한이 있는 계정 또는 토큰을 사용한다.

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth status
gh repo view opensphere-platform/OpenSphere-Setup-CLI \
  --json visibility,viewerPermission

release=setup-v0.5.0-edge.17
architecture="$(test "$(uname -m)" = arm64 && echo arm64 || echo amd64)"
gh release download "$release" \
  --repo opensphere-platform/OpenSphere-Setup-CLI \
  --pattern "opensphere-setup-darwin-${architecture}.tar.gz" \
  --pattern SHA256SUMS
gh release verify "$release" --repo opensphere-platform/OpenSphere-Setup-CLI
gh release verify-asset "$release" "opensphere-setup-darwin-${architecture}.tar.gz" \
  --repo opensphere-platform/OpenSphere-Setup-CLI
tar -xzf "opensphere-setup-darwin-${architecture}.tar.gz"
SETUP="$PWD/opensphere-setup-darwin-${architecture}/opensphere-setup"
"$SETUP" version
```

## 3. 무변경 진단

```bash
"$SETUP" doctor \
  --release edge \
  --context docker-desktop \
  --storage-class hostpath \
  --console https://localhost:1114
```

진단이 실패하면 bootstrap을 실행하지 않는다. `doctor`는 Kubernetes를 변경하지 않으며
로컬 필수 명령, Kubernetes v1.30+, 노드 플랫폼·Ready·권한, StorageClass, localhost
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

bootstrap은 플랫폼 검증 후 현재 macOS 플랫폼용 Console-native `os` CLI를 내려받아
SHA-256과 서명 manifest를 확인하고 `$HOME/.local/bin/os`에 설치한다.

```bash
"$SETUP" verify \
  --context docker-desktop \
  --console https://localhost:1114

kubectl --context docker-desktop -n opensphere-console \
  get configmap opensphere-installation-evidence

"$HOME/.local/bin/os" version
```

`$HOME/.local/bin`이 PATH에 없다면 shell profile에 추가하거나 bootstrap에 `--add-to-path`를
사용한다. 부분 실패는 [`PARTIAL-FAILURE-RECOVERY.md`](PARTIAL-FAILURE-RECOVERY.md)를 따른다.
