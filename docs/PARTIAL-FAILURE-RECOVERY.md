# 부분 실패 진단과 복구

같은 release·context·StorageClass·Console origin으로 재실행하는 것이 기본 복구 방법이다.
Secret은 누락된 키만 보완하며 정상 재개 과정에서 암묵적으로 회전하지 않는다. 데이터 PVC를
삭제하거나 다른 StorageClass로 바꾸는 작업은 이 Runbook의 자동 재개 범위가 아니다.

## 상태별 판단

| 상태 | 확인 | 조치 |
|---|---|---|
| 로컬 도구·포트·Release 검증 실패 | OpenSphere namespace 없음 | 원인을 수정하고 `doctor`를 다시 실행한다. 클러스터 정리는 필요 없다. |
| 로컬 release lock만 존재 | `.opensphere-setup/<channel>-release-lock.json`만 존재 | 같은 bootstrap 명령을 다시 실행한다. 서명 검증된 lock을 재사용할 수 있다. |
| installation lock과 namespace 존재, workload 일부 미완료 | `opensphere-installation-lock` 존재 | 동일 옵션으로 bootstrap을 다시 실행한다. 다른 release는 `upgrade`만 허용한다. |
| 별도로 실행한 `install-cli`만 실패 | Pod·Service 정상, 명시적 호스트 CLI 설치 실패 | bootstrap 성공과 구분한다. 원인을 해결한 뒤 필요한 경우에만 install-cli를 다시 실행한다. |
| namespace는 있으나 installation lock 없음 | bootstrap이 소유권을 증명하지 못함 | 자동 설치·제거를 중단한다. 데이터 소유권을 조사하고 명시적 보존/정리 결정을 내린다. |
| PVC StorageClass가 installation config와 다름 | `verify`가 PVC별 불일치를 출력 | PVC의 `storageClassName`은 불변이다. snapshot/backup과 복원 검증을 포함한 별도 데이터 마이그레이션을 수행한다. |
| 설치 증거 ConfigMap 없음 | `verify` 미완료 또는 실패 | 오류를 수정하고 `opensphere-setup verify`를 완료한다. 성공하면 ConfigMap이 생성된다. |

## 진단 명령

```bash
opensphere-setup doctor \
  --release edge \
  --context docker-desktop \
  --storage-class hostpath \
  --console https://localhost:1114

kubectl --context docker-desktop -n opensphere-console \
  get configmap opensphere-installation-lock -o yaml

kubectl --context docker-desktop get pods,pvc -A

opensphere-setup verify \
  --context docker-desktop \
  --console https://localhost:1114
```

installation lock의 Secret 값이나 인증 토큰을 지원 자료에 복사하지 않는다.

## 안전한 재개

```bash
opensphere-setup bootstrap \
  --release edge \
  --context docker-desktop \
  --storage-class hostpath \
  --console https://localhost:1114
```

클러스터 lock이 있으면 mutable edge tag를 다시 선택하지 않고 저장된 immutable release
digest를 사용한다. 설치된 StorageClass·Console origin·release digest와 다른 값은 즉석에서
덮어쓰지 않는다.

## 데이터 삭제가 필요한 경우

데이터를 폐기하는 것이 명시적으로 승인된 경우에만 관리 제거 명령을 사용한다.

```bash
opensphere-setup uninstall \
  --context docker-desktop \
  --purge-data \
  --confirm DELETE-OPENSPHERE
```

이 명령은 유효한 installation lock이 소유권을 증명할 때만 동작한다. lock이 없는 namespace를
추측으로 삭제하지 않는다. 관리 namespace 종료 뒤에도 target CRD의 cluster-wide 인스턴스가 남아
있으면 공유 중인 리소스로 보고 CRD 삭제를 거부한다.
