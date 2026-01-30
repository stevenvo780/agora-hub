#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 - <<PY\nimport json\nfrom pathlib import Path\npkg = json.loads(Path(\"$ROOT_DIR/package.json\").read_text())\nprint(pkg.get(\"version\", \"0.0.0\"))\nPY\n)"

BUILD_DIR="$ROOT_DIR/build/deb"
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$ROOT_DIR/build/stage"

rm -rf "$BUILD_DIR" "$STAGE_DIR"
mkdir -p "$BUILD_DIR/DEBIAN" \
  "$BUILD_DIR/opt/edu-hub" \
  "$BUILD_DIR/lib/systemd/system" \
  "$BUILD_DIR/etc/edu-hub" \
  "$BUILD_DIR/usr/share/doc/edu-hub"

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  npm ci --prefix "$ROOT_DIR"
fi

npm run build --prefix "$ROOT_DIR"

mkdir -p "$STAGE_DIR"
cp "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$STAGE_DIR/"
npm ci --omit=dev --prefix "$STAGE_DIR"

cp -r "$ROOT_DIR/dist" "$BUILD_DIR/opt/edu-hub/dist"
cp "$ROOT_DIR/package.json" "$BUILD_DIR/opt/edu-hub/"
cp -r "$STAGE_DIR/node_modules" "$BUILD_DIR/opt/edu-hub/node_modules"

install -m 644 "$ROOT_DIR/packaging/edu-hub.service" "$BUILD_DIR/lib/systemd/system/edu-hub.service"
install -m 644 "$ROOT_DIR/packaging/hub.env" "$BUILD_DIR/etc/edu-hub/hub.env"
install -m 644 "$ROOT_DIR/packaging/hub.env" "$BUILD_DIR/usr/share/doc/edu-hub/hub.env.example"

cat > "$BUILD_DIR/DEBIAN/control" << EOF
Package: edu-hub
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Depends: nodejs, ca-certificates
Maintainer: Educacion Cooperativa
Description: Hub de Educacion Cooperativa
 Servicio central de sockets y autenticacion para la plataforma.
EOF

cat > "$BUILD_DIR/DEBIAN/conffiles" << EOF
/etc/edu-hub/hub.env
EOF

cat > "$BUILD_DIR/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e

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
chmod 755 "$BUILD_DIR/DEBIAN/postinst"

mkdir -p "$DIST_DIR"
dpkg-deb --build "$BUILD_DIR" "$DIST_DIR/edu-hub_${VERSION}_amd64.deb"
echo "Paquete creado: $DIST_DIR/edu-hub_${VERSION}_amd64.deb"
