#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 - <<PY
import json
from pathlib import Path
pkg = json.loads(Path("$ROOT_DIR/package.json").read_text())
print(pkg.get("version", "0.0.0"))
PY
)"

if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "rpmbuild no esta instalado. Instala rpm-build para generar RPM." >&2
  exit 1
fi

RPM_BUILD_DIR="$ROOT_DIR/build/rpm"
STAGE_DIR="$ROOT_DIR/build/stage"
rm -rf "$RPM_BUILD_DIR" "$STAGE_DIR"
mkdir -p "$RPM_BUILD_DIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  npm ci --prefix "$ROOT_DIR"
fi

npm run build --prefix "$ROOT_DIR"

mkdir -p "$STAGE_DIR"
cp "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$STAGE_DIR/"
npm ci --omit=dev --prefix "$STAGE_DIR"

SPEC_FILE="$RPM_BUILD_DIR/SPECS/edu-hub.spec"

cat > "$SPEC_FILE" << EOF
Name:       edu-hub
Version:    $VERSION
Release:    1%{?dist}
Summary:    Hub de Educacion Cooperativa
License:    Proprietary
BuildArch:  x86_64
Requires:   nodejs, ca-certificates

%description
Servicio central de sockets y autenticacion para la plataforma.

%prep
# No preparation needed

%build
# No build steps needed

%install
mkdir -p %{buildroot}/opt/edu-hub
mkdir -p %{buildroot}/usr/lib/systemd/system
mkdir -p %{buildroot}/etc/edu-hub

cp -r $ROOT_DIR/dist %{buildroot}/opt/edu-hub/dist
cp $ROOT_DIR/package.json %{buildroot}/opt/edu-hub/
cp -r $STAGE_DIR/node_modules %{buildroot}/opt/edu-hub/node_modules

install -m 644 $ROOT_DIR/packaging/edu-hub.service %{buildroot}/usr/lib/systemd/system/edu-hub.service
install -m 644 $ROOT_DIR/packaging/hub.env %{buildroot}/etc/edu-hub/hub.env

%files
/opt/edu-hub
/usr/lib/systemd/system/edu-hub.service
%config(noreplace) /etc/edu-hub/hub.env

%post
if ! getent group edu-hub >/dev/null 2>&1; then
  groupadd --system edu-hub
fi
if ! id -u edu-hub >/dev/null 2>&1; then
  useradd --system --gid edu-hub --home /opt/edu-hub --shell /usr/sbin/nologin edu-hub
fi
chown -R edu-hub:edu-hub /opt/edu-hub
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  systemctl enable edu-hub.service || true
  systemctl restart edu-hub.service || true
fi
EOF

rpmbuild --define "_topdir $RPM_BUILD_DIR" -bb "$SPEC_FILE"
echo "RPM generado en $RPM_BUILD_DIR/RPMS/"
