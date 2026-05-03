# Desbloqueo administrativo del NAS para desplegar PostgreSQL 17

Ejecutar estos pasos **en la consola local del NAS** o en un canal administrativo que ya funcione. No guardar contraseñas en este archivo.

## 1. Verificar SSH

```bash
sudo systemctl status ssh --no-pager
sudo ss -tulpen | grep ':22' || true
sudo ufw status verbose || true
```

Si SSH no está activo:

```bash
sudo systemctl enable --now ssh
```

Si UFW bloquea SSH por NetBird/LAN, permitir solo redes internas conocidas. Ejemplo para NetBird:

```bash
sudo ufw allow from 100.98.0.0/16 to any port 22 proto tcp
```

## 2. Confirmar usuario administrativo

Usar el usuario real que deba administrar Docker/ZFS, por ejemplo `nas` o `nass`:

```bash
id nas || true
id nass || true
getent group docker
```

Si el usuario correcto no pertenece a `docker` y se desea operar Docker sin sudo:

```bash
sudo usermod -aG docker <usuario>
```

Cerrar y reabrir sesión después de modificar grupos.

## 3. Autorizar llave de ubuntu-raid

Para el usuario administrativo elegido:

```bash
sudo install -d -m 700 -o <usuario> -g <usuario> /home/<usuario>/.ssh
printf '%s\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID6dHGmWGDFlNvlnlzz+8eZpcjDoDFYomlE5TsEnKDYk stev@ubuntu-raid' | sudo tee -a /home/<usuario>/.ssh/authorized_keys >/dev/null
sudo chown <usuario>:<usuario> /home/<usuario>/.ssh/authorized_keys
sudo chmod 600 /home/<usuario>/.ssh/authorized_keys
```

## 4. Revisar bloqueos por intentos fallidos

```bash
sudo fail2ban-client status 2>/dev/null || true
sudo journalctl -u ssh --since '30 minutes ago' --no-pager | tail -n 80
```

Si hay bloqueo temporal contra `ubuntu-raid` o la IP de NetBird, desbloquearlo según la jail correspondiente.

## 5. Prueba esperada desde la VM

Desde `ws-humanizar`, la prueba debe devolver `nass-stev` y el usuario elegido:

```bash
ssh stev@10.88.88.1 "ssh <usuario>@100.98.67.189 'hostname && whoami && docker compose version'"
```

Cuando eso funcione, ejecutar el paquete preparado en `ops/nas-postgres17/`.
