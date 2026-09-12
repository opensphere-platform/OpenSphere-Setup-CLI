# Portable Setup 단계 기록

`doctor`와 `bootstrap`은 옵션 해석 이후부터 실행 디렉터리의 `.opensphere-setup/journal/<runId>.json`에 기록한다. 출력되는 `[설치 기록]` 경로에서 확인한다. 독립 실행 프로그램이며 Windows 서비스·프로그램 설치는 하지 않는다.

기록은 코드에 정의된 단계·시각·정상 반환·실패 여부다. 명령 인자·자격증명·stdout/stderr·예외 원문은 저장하지 않는다. 단계 반환이나 명령 반환은 제품 전체 수용이나 현재 상태가 아니다. 프로세스가 중단되면 Running 기록만 남을 수 있으며 현재 실행 중이라고 해석하면 안 된다.

bootstrap은 관리 namespace·설치 상태 준비 후 고정 `opensphere-console/opensphere-setup-journal` ConfigMap에 마지막 실행 기록을 전달한다. 초기 namespace 생성 전 오류는 로컬에만 남는다. doctor는 이 ConfigMap을 만들지 않는다. 전달 실패는 로컬 기록 보존·제한된 재시도 후 최종 실패로 알린다. C_API에 새 Kubernetes 권한을 부여하는 기능이 아니다.

원자적으로 교체되는 로컬 파일은 실행별로 보존한다. 한 실행은 최근 256개 이벤트·64KiB 이내다. 생략된 이벤트 수를 표시한다. 클러스터에는 마지막 전달본만 남으며 전체 Console 제거로 namespace를 삭제하면 같이 제거된다. 로컬 파일은 사용자가 삭제할 때까지 남는다.

Console 후보의 `console.setup.read`가 현재 사용자 감사 조회 권한으로 8개 이벤트씩 읽는다. 아직 운영 배포·클린 설치 수용은 하지 않았다. 업그레이드·제거 등 다른 명령, 과거 로컬 파일의 원격 수집과 원시 로그 수집은 이번 구현에 포함하지 않는다.

시험의 기본 Console 입력은 `test/fixtures/console-contract-v66`이다. 옆 저장소의 오래된 checkout 대신 해시를 기록한 19개 계약 자료를 사용한다. fixture-manifest는 현재 로컬 후보의 시험 자료이며 배포 승인·실제 릴리스를 뜻하지 않는다. 기존 Core 53개 준비물의 고정 SHA와 권한은 변경하지 않았다. 명시적 공급자 통합 시험에서는 `OPENSPHERE_CONSOLE_SOURCE`로 입력 위치를 선택할 수 있다.
