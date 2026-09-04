# Setup CLI 0.5.0-edge.28

Console Main Index의 빠른 독립 배포와 재부팅 뒤 Kubernetes API 연결 복구를 위한 릴리스다.

- `consoleIndexContent`를 네 번째 governed auxiliary artifact로 release lock에 추가한다.
- 새 Console anchor의 `console-index-renderer/v1` 라벨이 있을 때만 네 번째 artifact를 요구한다. 기존 3-artifact 설치 lock은 rollback과 원자적 전환을 위해 계속 검증한다.
- 최초 도입은 Console renderer component와 index content artifact를 한 component release에서 함께 바꾼다. 이후에는 콘텐츠 artifact만 갱신할 수 있으며, Setup은 같은 Console Deployment를 다시 적용하고 initContainer exact digest까지 검증한다.
- component release lock은 변경한 auxiliary artifact를 명시하며, 숨은 digest 변경·임의 artifact 추가·삭제를 거부한다.
- Extension Controller는 Setup이 먼저 만든 전용 NetworkPolicy만 관리한다. `default/kubernetes` Service와 ready EndpointSlice에서 확인한 `/32` 또는 `/128` 주소만 resourceVersion 조건부 patch하며, 임의 대역 허용이나 새 정책 생성 권한은 갖지 않는다.
- Console API, Extension Controller, Main Index와 Console renderer의 변경을 기존 설치에 원자적으로 적용하고 검증한 뒤에만 installation 상태를 `Ready`로 기록한다.

Windows 실행 파일은 기존과 같은 포터블 launcher다. Windows 설치, PATH 변경, 서비스 등록을 하지 않는다. OAuth credential은 공급망 확인에만 사용하고 portable runtime cache나 release lock에 저장하지 않는다.

이 문서는 구현 계약과 릴리스 의도를 기록한다. 실제 공개 Release와 localhost Kubernetes 배포 완료 여부는 별도 실행 증거로 확인한다.
