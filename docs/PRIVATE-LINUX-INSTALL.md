# 비공개 Linux 노드 설치

## 배포 원칙

`opensphere-setup` Linux 실행 파일은 공개 npm, 공개 URL 또는 컨테이너 이미지로 배포하지
않는다. 정본은 비공개 GitHub 저장소
`opensphere-platform/OpenSphere-Setup-CLI`의 GitHub Release asset이다.

GitHub 저장소의 `Contents: read` 권한이 있는 사용자 또는 fine-grained token만 다운로드할 수
있다. 실행 파일은 Node.js runtime과 Setup 인증서 생성 asset을 포함하는 단일 Node SEA
실행 파일이다. 대상 Linux 노드에는 Node.js나 Setup 저장소 clone이 필요하지 않다.

지원 플랫폼:

| Linux 아키텍처 | Release asset |
|---|---|
| `x86_64` | `opensphere-setup-linux-amd64` |
| `aarch64`, `arm64` | `opensphere-setup-linux-arm64` |

## 사전 요구 사항

- Kubernetes API에 접근 가능한 Linux 관리 노드
- `kubectl`
- PowerShell 7 명령 `pwsh`
- GitHub CLI 명령 `gh`
- GitHub 및 GHCR로 나갈 수 있는 HTTPS 네트워크
- 대상 Kubernetes context와 동적 StorageClass
- 비공개 GHCR image를 사용하는 release라면 별도의 package read token

GitHub 로그인 상태를 확인한다.

```bash
gh auth status
gh repo view opensphere-platform/OpenSphere-Setup-CLI --json visibility,viewerPermission
```

서버에서 대화형 로그인이 어렵다면 fine-grained token을 표준입력으로 전달한다. 토큰에는 해당
비공개 저장소의 `Contents: read` 권한만 부여한다.

```bash
printf '%s' "$OPENSPHERE_GITHUB_TOKEN" | gh auth login --hostname github.com --with-token
unset OPENSPHERE_GITHUB_TOKEN
```

## 실행 파일 다운로드

아키텍처를 판별하고 릴리스 asset을 선택한다.

```bash
case "$(uname -m)" in
  x86_64) asset=opensphere-setup-linux-amd64 ;;
  aarch64|arm64) asset=opensphere-setup-linux-arm64 ;;
  *) echo "지원하지 않는 아키텍처: $(uname -m)" >&2; exit 1 ;;
esac
```

설치할 private release tag를 지정한 뒤 실행 파일과 체크섬을 인증 다운로드한다.

```bash
release=setup-v0.4.0-edge.2
download_dir="$(mktemp -d)"

gh release download "$release" \
  --repo opensphere-platform/OpenSphere-Setup-CLI \
  --pattern "$asset" \
  --pattern SHA256SUMS \
  --dir "$download_dir"
```

체크섬을 검증하고 시스템 명령으로 설치한다.

```bash
(
  cd "$download_dir"
  grep "  $asset\$" SHA256SUMS | sha256sum --check -
)

sudo install -o root -g root -m 0755 \
  "$download_dir/$asset" \
  /usr/local/bin/opensphere-setup

opensphere-setup version
rm -rf -- "$download_dir"
```

예상 버전:

```text
opensphere-setup 0.4.0-edge.2
```

`SHA256SUMS`는 인증된 동일 Release에서 함께 받아 전송 손상이나 asset 혼합을 차단한다.
토큰을 URL, shell history 또는 명령 인자로 넣지 않는다.

## 실제 Kubernetes 설치

먼저 context, 노드와 StorageClass를 확인한다.

```bash
kubectl config get-contexts
kubectl --context <production-context> get nodes
kubectl --context <production-context> get storageclass
```

현재 개발 채널을 새 클러스터에 설치하는 예:

```bash
opensphere-setup bootstrap \
  --release edge \
  --context <production-context> \
  --storage-class <storage-class> \
  --console https://console.example.internal \
  --auth-environment development \
  --no-open-browser
```

`candidate`와 `stable`은 현재 복구 drill gate가 해제될 때까지 의도적으로 HOLD 상태다. 실제
운영 클러스터에 `edge/development`를 사용하는 것은 개발 검증 목적에만 적합하다.

비공개 GHCR package token이 필요한 release는 토큰을 표준입력으로만 전달한다.

```bash
printf '%s' "$GHCR_TOKEN" | opensphere-setup bootstrap \
  --release edge \
  --context <production-context> \
  --storage-class <storage-class> \
  --console https://console.example.internal \
  --registry-username <github-login> \
  --registry-token-stdin \
  --no-open-browser
unset GHCR_TOKEN
```

설치 후 검증:

```bash
opensphere-setup verify \
  --context <production-context> \
  --console https://console.example.internal \
  --require-zero-restarts
```

## 업그레이드

새 private Setup CLI release를 같은 절차로 다운로드·체크섬 검증 후
`/usr/local/bin/opensphere-setup`에 원자적으로 교체한다. 그다음 OS release를 업그레이드한다.

```bash
opensphere-setup upgrade \
  --release edge \
  --context <production-context> \
  --console https://console.example.internal
```

Setup 실행 파일 버전과 설치되는 OpenSphere OS release는 별도 잠금이다. Setup binary를
교체해도 클러스터 이미지는 자동 변경되지 않으며, `upgrade`를 명시해야 한다.

## 보안 및 운영 주의

- GitHub 저장소 또는 Release가 public이면 발행 workflow가 즉시 실패한다.
- GitHub token은 Kubernetes Secret이나 release lock에 저장하지 않는다.
- GitHub 저장소 접근 token과 GHCR package token은 용도와 권한을 분리한다.
- 다운로드한 실행 파일은 반드시 같은 Release의 `SHA256SUMS`로 확인한다.
- 설치 작업은 전용 관리 노드에서 수행하고 일반 Kubernetes worker에 도구를 상주시킬 필요는 없다.
- Console TLS, DNS, StorageClass와 복구 정책은 대상 환경에 맞게 사전에 결정한다.
