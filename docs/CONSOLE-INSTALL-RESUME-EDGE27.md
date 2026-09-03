# Setup CLI 0.5.0-edge.27

Console 초기 설치와 기존 설치의 이어서 진행을 위한 수정이다.

- Extension Controller에 PostgreSQL TCP 5432 접근을 허용한다. 다른 Pod에 대한 기본 차단 정책은 유지한다.
- Console Registry는 공통 Extension 신뢰 키를 사용한다. 아직 설치하지 않은 Foundation의 API 부재는 NotInstalled로 표시하며, 권한 오류·통신 장애·필수 입력 누락은 계속 차단한다.
- Supabase Storage 검증은 폐기된 애플리케이션 버킷에 의존하지 않는다. 크기가 제한된 임시 비공개 버킷에서 쓰기·읽기·공개 접근 차단을 확인하고 검증 데이터를 삭제한다. 기존 버킷 정책은 바꾸지 않는다.
- 업그레이드와 롤백은 Installing 상태에서 실제 검증을 수행하고, 검증 증거가 생성된 뒤에만 Ready를 기록한다.
- Console 이미지 발행기는 불변 이미지 준비와 edge 채널 승격을 분리할 수 있다. 검증한 이미지의 동일 digest를 승격하므로 재빌드는 필요하지 않다.

실행 파일은 기존과 동일한 portable launcher이다. Windows 설치·PATH 변경·상주 서비스 등록은 하지 않는다. OAuth 인증과 Console의 운영용 GHCR 자격 증명 인계 정책은 유지한다.

기존 설치를 지우는 변경은 포함하지 않는다. 최초 관리자 비밀번호는 Console 시작 화면에서 운영자가 설정한다.
Gitea 설치 검증은 현재 C_API가 실제로 사용하는 control/review token을 검증한다. 옛 Backend 전용 webhook/reconciler credential을 생성해 검사만 통과시키지 않는다. 현재 C_API의 post-merge owner는 미구현이므로 설치 증거에서도 `managementReady=false`와 `postMergeReconciliation=NotImplementedInConsoleApi`를 명시한다. 기본 설치 Ready는 이 관리 기능의 구현 완료를 뜻하지 않는다.

Beszel bootstrap Job의 성공 판정은 Job 고유의 Complete 조건과 성공 횟수를 확인한다. Deployment용 observedGeneration이 없다는 이유로 완료된 Job을 실패 처리하지 않는다. 서비스 workload에는 기존 세대·replica 검증을 그대로 적용한다.
