#!/bin/sh
set -eu

bound_release_tag='__OPENSPHERE_SETUP_RELEASE_TAG__'
canonical_repository='opensphere-platform/OpenSphere-Setup-CLI'
selected_version=''
selected_channel=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ -z "$selected_version" ] && [ "$#" -ge 2 ] || {
        echo '--version must be specified once with a value.' >&2
        exit 1
      }
      selected_version=$2
      shift 2
      ;;
    --channel)
      [ -z "$selected_channel" ] && [ "$#" -ge 2 ] || {
        echo '--channel must be specified once with a value.' >&2
        exit 1
      }
      selected_channel=$2
      shift 2
      ;;
    --help|-h)
      cat <<EOF
OpenSphere Setup CLI installer ${bound_release_tag}

Usage:
  ./install-opensphere-setup.sh
  ./install-opensphere-setup.sh --version <semver>
  ./install-opensphere-setup.sh --channel <edge|candidate|stable>

--version selects one exact immutable Setup CLI release.
--channel resolves the public channel pointer once, then installs that immutable release.
The two selectors are mutually exclusive.
EOF
      exit 0
      ;;
    *) echo "Unknown installer option: $1" >&2; exit 1 ;;
  esac
done

[ -z "$selected_version" ] || [ -z "$selected_channel" ] || {
  echo '--version and --channel are mutually exclusive.' >&2
  exit 1
}

case "$(uname -s)" in
  Linux)
    platform='linux'
    install_base=${OPENSPHERE_SETUP_INSTALL_ROOT:-"${XDG_DATA_HOME:-$HOME/.local/share}/opensphere/setup"}
    ;;
  Darwin)
    platform='darwin'
    install_base=${OPENSPHERE_SETUP_INSTALL_ROOT:-"$HOME/Library/Application Support/OpenSphere/Setup"}
    ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) architecture='amd64' ;;
  arm64|aarch64) architecture='arm64' ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

for command_name in curl tar mktemp awk grep tr; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required host command is missing: $command_name" >&2
    exit 1
  }
done

release_tag=$bound_release_tag
if [ -n "$selected_version" ]; then
  printf '%s\n' "$selected_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || {
    echo "Invalid Setup CLI version: $selected_version" >&2
    exit 1
  }
  release_tag="setup-v${selected_version}"
elif [ -n "$selected_channel" ]; then
  case "$selected_channel" in
    edge|candidate|stable) ;;
    *) echo "Unsupported Setup CLI channel: $selected_channel" >&2; exit 1 ;;
  esac
  channel_url="https://raw.githubusercontent.com/${canonical_repository}/main/channels/${selected_channel}"
  release_tag=$(curl --fail --location --proto '=https' --tlsv1.2 "$channel_url" | tr -d '\r')
  [ "$(printf '%s\n' "$release_tag" | awk 'END { print NR }')" -eq 1 ] || {
    echo "Public Setup CLI channel ${selected_channel} must contain exactly one line." >&2
    exit 1
  }
  [ "$release_tag" != 'HOLD' ] || {
    echo "Setup CLI channel ${selected_channel} is on HOLD and has no installable release." >&2
    exit 1
  }
  case "$selected_channel" in
    edge) printf '%s\n' "$release_tag" | grep -Eq '^setup-v[0-9]+\.[0-9]+\.[0-9]+-edge\.[0-9]+$' ;;
    candidate) printf '%s\n' "$release_tag" | grep -Eq '^setup-v[0-9]+\.[0-9]+\.[0-9]+-candidate\.[0-9]+$' ;;
    stable) printf '%s\n' "$release_tag" | grep -Eq '^setup-v[0-9]+\.[0-9]+\.[0-9]+$' ;;
  esac || {
    echo "Public Setup CLI channel ${selected_channel} has an invalid release pointer." >&2
    exit 1
  }
fi

printf '%s\n' "$release_tag" | grep -Eq '^setup-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || {
  echo 'OpenSphere Setup installer is not bound to a valid release tag.' >&2
  exit 1
}
version=${release_tag#setup-v}
release_base="https://github.com/${canonical_repository}/releases/download/${release_tag}"

if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  echo 'sha256sum or shasum is required to verify the Setup archive.' >&2
  exit 1
fi

archive_name="opensphere-setup-${platform}-${architecture}.tar.gz"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/opensphere-setup-install.XXXXXXXX")
cleanup() {
  case "$temporary_directory" in
    "${TMPDIR:-/tmp}"/opensphere-setup-install.*) rm -rf -- "$temporary_directory" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

echo "[단계 01] 공개 OpenSphere Setup release 다운로드 — ${release_tag}"
curl --fail --location --proto '=https' --tlsv1.2 \
  "${release_base}/${archive_name}" --output "${temporary_directory}/${archive_name}"
curl --fail --location --proto '=https' --tlsv1.2 \
  "${release_base}/SHA256SUMS" --output "${temporary_directory}/SHA256SUMS"

echo '[단계 02] SHA-256 검증'
checksum_count=$(awk -v name="$archive_name" '$2 == name { count += 1 } END { print count + 0 }' "${temporary_directory}/SHA256SUMS")
[ "$checksum_count" -eq 1 ] || {
  echo "SHA256SUMS must contain exactly one ${archive_name} entry." >&2
  exit 1
}
expected_digest=$(awk -v name="$archive_name" '$2 == name { print $1 }' "${temporary_directory}/SHA256SUMS")
actual_digest=$(sha256_file "${temporary_directory}/${archive_name}")
[ "$actual_digest" = "$expected_digest" ] || {
  echo "OpenSphere Setup archive checksum mismatch: ${actual_digest}" >&2
  exit 1
}

echo '[단계 03] 자체 포함 runtime 압축 해제와 실행 검증'
expanded="${temporary_directory}/expanded"
mkdir -p "$expanded"
tar -xzf "${temporary_directory}/${archive_name}" -C "$expanded"
staged_root="${expanded}/opensphere-setup-${platform}-${architecture}"
staged_setup="${staged_root}/opensphere-setup"
[ -x "$staged_setup" ] || {
  echo 'Verified archive does not contain an executable opensphere-setup.' >&2
  exit 1
}
expected_version="opensphere-setup ${version}"
actual_version=$("$staged_setup" version)
[ "$actual_version" = "$expected_version" ] || {
  echo "Staged Setup version mismatch: ${actual_version}" >&2
  exit 1
}

install_directory="${install_base}/${version}"
installation_staging="${install_directory}.installing.$$"
bin_directory=${OPENSPHERE_SETUP_BIN_DIR:-"$HOME/.local/bin"}
command_path="${bin_directory}/opensphere-setup"

echo "[단계 04] 사용자 전용 경로에 설치 — ${install_directory}"
if [ -d "$install_directory" ]; then
  existing_version=$("${install_directory}/opensphere-setup" version 2>/dev/null || true)
  [ "$existing_version" = "$expected_version" ] || {
    echo "Install target already exists but is not the verified release: ${install_directory}" >&2
    exit 1
  }
else
  mkdir -p "$install_base"
  cp -R "$staged_root" "$installation_staging"
  mv "$installation_staging" "$install_directory"
fi

mkdir -p "$bin_directory"
if [ -e "$command_path" ] || [ -L "$command_path" ]; then
  if [ ! -L "$command_path" ]; then
    echo "Refusing to replace a non-symlink command: ${command_path}" >&2
    exit 1
  fi
  previous_target=$(readlink "$command_path")
  case "$previous_target" in
    "$install_base"/*/opensphere-setup) ;;
    *) echo "Refusing to replace an unmanaged symlink: ${command_path}" >&2; exit 1 ;;
  esac
fi
ln -sfn "$install_directory/opensphere-setup" "$command_path"

final_version=$("$command_path" version)
[ "$final_version" = "$expected_version" ] || {
  echo "Installed command verification failed: ${final_version}" >&2
  exit 1
}

echo "[완료] ${final_version}"
echo "Command: ${command_path}"
case ":${PATH}:" in
  *:"${bin_directory}":*) ;;
  *)
    echo "PATH에 다음 경로를 추가하십시오: ${bin_directory}"
    echo "현재 셸에서 실행: export PATH=\"${bin_directory}:\$PATH\""
    ;;
esac
echo '다음 명령: opensphere-setup doctor --release edge --context docker-desktop --storage-class hostpath'
