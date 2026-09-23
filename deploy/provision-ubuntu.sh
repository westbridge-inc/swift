#!/usr/bin/env bash
# One-time or repeatable host preparation for an Ubuntu 24.04 STAGING server.
# Run locally on that host as root with the deploy user's PUBLIC key file.
# No host access is performed by this repository script during development.
set -euo pipefail

DEPLOY_USER=swift-deploy
PUBKEY_FILE="${1:-}"
MIN_FREE_KIB=$((40 * 1024 * 1024))
SWAPFILE=/swapfile

die() { echo "FATAL: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root on the staging host"
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] ||
  die "this script supports Ubuntu 24.04 only"
[ -f "$PUBKEY_FILE" ] || die "pass the deploy user's SSH public key file"

FREE_KIB="$(df -Pk / | awk 'NR==2 {print $4}')"
[ "$FREE_KIB" -ge "$MIN_FREE_KIB" ] ||
  die "at least 40 GiB free on / is required before installing pilot services"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl openssh-client openssh-server ufw unattended-upgrades \
  postgresql-client git openssl libdigest-sha-perl python3 snapd
# Ubuntu 24.04 ships no awscli apt package. Install AWS CLI v2 from the
# official snap and expose it on the default service PATH, because systemd
# units (the nightly backup) do not search /snap/bin.
snap list aws-cli >/dev/null 2>&1 || snap install aws-cli --classic
ln -sf /snap/bin/aws /usr/local/bin/aws
/usr/local/bin/aws --version >/dev/null 2>&1 || die "AWS CLI is not usable after install"
ssh-keygen -lf "$PUBKEY_FILE" >/dev/null || die "invalid SSH public key"
KEY="$(head -1 "$PUBKEY_FILE")"
[[ "$KEY" == ssh-*' '* ]] || die "invalid SSH public key format"

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
HOME_DIR="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
chmod 0600 "$HOME_DIR/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$HOME_DIR/.ssh/authorized_keys"
grep -Fxq -- "$KEY" "$HOME_DIR/.ssh/authorized_keys" ||
  printf '%s\n' "$KEY" >> "$HOME_DIR/.ssh/authorized_keys"
# Root SSH login is removed below, so the deploy user needs an audited root
# path first; otherwise a run that stops later leaves the host unmanageable.
SUDOERS_FILE=/etc/sudoers.d/90-swift-deploy
SUDOERS_TMP="$(mktemp)"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$DEPLOY_USER" > "$SUDOERS_TMP"
visudo -cf "$SUDOERS_TMP" >/dev/null || { rm -f "$SUDOERS_TMP"; die "sudoers entry failed validation"; }
install -m 0440 -o root -g root "$SUDOERS_TMP" "$SUDOERS_FILE"
rm -f "$SUDOERS_TMP"
sudo -l -U "$DEPLOY_USER" >/dev/null 2>&1 || die "deploy user has no working sudo path"

# Keep an existing drop-in available for rollback if sshd rejects the change.
SSHD_DROPIN=/etc/ssh/sshd_config.d/99-swift-pilot.conf
SSHD_PREVIOUS="$(mktemp)"
if [ -f "$SSHD_DROPIN" ]; then cp "$SSHD_DROPIN" "$SSHD_PREVIOUS"; else : > "$SSHD_PREVIOUS"; fi
cat > "$SSHD_DROPIN" <<'SSH'
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AuthenticationMethods publickey
SSH
chmod 0644 "$SSHD_DROPIN"
# Ubuntu 24.04 starts sshd through ssh.socket, so the privilege separation
# directory may not exist yet; `sshd -t` refuses to validate without it.
install -d -m 0755 -o root -g root /run/sshd
restore_sshd_and_die() {
  if [ -s "$SSHD_PREVIOUS" ]; then cp "$SSHD_PREVIOUS" "$SSHD_DROPIN"; else rm -f "$SSHD_DROPIN"; fi
  rm -f "$SSHD_PREVIOUS"
  die "sshd rejected the key-only configuration; previous file restored"
}
# Read each effective configuration once, then match it. Piping `sshd -T`
# into `grep -q` under `set -o pipefail` fails whenever grep stops reading
# early and sshd dies of SIGPIPE, which rejected a correct configuration.
/usr/sbin/sshd -t || restore_sshd_and_die
DEPLOY_EFFECTIVE="$(/usr/sbin/sshd -T -C "user=$DEPLOY_USER,host=localhost,addr=127.0.0.1")" || restore_sshd_and_die
ROOT_EFFECTIVE="$(/usr/sbin/sshd -T -C 'user=root,host=localhost,addr=127.0.0.1')" || restore_sshd_and_die
for expected in 'passwordauthentication no' 'kbdinteractiveauthentication no' \
                'pubkeyauthentication yes' 'permitrootlogin no' 'authenticationmethods publickey'; do
  grep -qxF -- "$expected" <<< "$DEPLOY_EFFECTIVE" || restore_sshd_and_die
done
grep -qxF -- 'permitrootlogin no' <<< "$ROOT_EFFECTIVE" || restore_sshd_and_die
rm -f "$SSHD_PREVIOUS"
systemctl reload ssh

# Do not remove unknown firewall rules automatically. `status` omits saved
# rules while inactive, so inspect both the stored and active inventories.
UFW_STORED="$(ufw show added)" || die "UFW stored rules could not be read"
[[ "$UFW_STORED" == 'Added user rules'* ]] || die "UFW stored rules format is unknown"
while IFS= read -r rule; do
  case "$rule" in
    'Added user rules'*|''|'(None)') continue ;;
    'ufw allow 22/tcp'|'ufw allow 80/tcp'|'ufw allow 443/tcp'|\
    'ufw limit 22/tcp'|'ufw limit 80/tcp'|'ufw limit 443/tcp'|\
    'ufw allow 22/tcp (v6)'|'ufw allow 80/tcp (v6)'|'ufw allow 443/tcp (v6)'|\
    'ufw limit 22/tcp (v6)'|'ufw limit 80/tcp (v6)'|'ufw limit 443/tcp (v6)') ;;
    'ufw deny '*|'ufw reject '*) ;;
    *) die "UFW has an unreviewed stored rule: $rule" ;;
  esac
done <<< "$UFW_STORED"

UFW_STATUS="$(ufw status)" || die "UFW active rules could not be read"
[[ "$UFW_STATUS" == 'Status: active'* || "$UFW_STATUS" == 'Status: inactive'* ]] ||
  die "UFW active rules format is unknown"
while IFS= read -r rule; do
  case "$rule" in
    'Status: active'|'Status: inactive'|'') continue ;;
  esac
  if [[ "$rule" =~ ^To[[:space:]]+Action[[:space:]]+From$ ||
        "$rule" =~ ^-+[[:space:]]+-+[[:space:]]+-+$ ]]; then
    continue
  fi
  if [[ "$rule" =~ ^(22|80|443)/tcp([[:space:]]+\(v6\))?[[:space:]]+(ALLOW|LIMIT)([[:space:]]+IN)?[[:space:]]+Anywhere([[:space:]]+\(v6\))?$ ]]; then
    continue
  fi
  if [[ "$rule" =~ [[:space:]]+(DENY|REJECT)([[:space:]]+IN)?[[:space:]]+ ]]; then
    continue
  fi
  die "UFW has an unreviewed active rule: $rule"
done <<< "$UFW_STATUS"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
systemctl enable --now unattended-upgrades
timedatectl set-ntp true

# The official Docker repository is signed with its own keyring. Refuse to
# replace a distribution Docker install implicitly; an operator must review it.
if dpkg-query -W -f='${Status}' docker.io 2>/dev/null | grep -q 'install ok installed'; then
  die "docker.io is installed; review the package transition before using Docker CE"
fi
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
ARCH="$(dpkg --print-architecture)"
cat > /etc/apt/sources.list.d/docker.sources <<DOCKER
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $ARCH
Signed-By: /etc/apt/keyrings/docker.asc
DOCKER
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker compose version >/dev/null
usermod -aG docker "$DEPLOY_USER"

# Create swap only when no active swap exists. Never overwrite an existing
# swapfile or edit an existing fstab entry during a repeat run.
if [ -z "$(swapon --noheadings --show=NAME)" ]; then
  if [ ! -e "$SWAPFILE" ]; then
    fallocate -l 4G "$SWAPFILE"
    chmod 0600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null
  fi
  [ "$(blkid -o value -s TYPE "$SWAPFILE")" = swap ] ||
    die "existing $SWAPFILE is not swap; refusing to overwrite it"
  swapon "$SWAPFILE"
fi
if [ -f "$SWAPFILE" ] && swapon --noheadings --show=NAME | grep -Fxq "$SWAPFILE"; then
  grep -Eq '^/swapfile[[:space:]]' /etc/fstab ||
    printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /opt/swift /var/backups/swift

FREE_KIB="$(df -Pk / | awk 'NR==2 {print $4}')"
[ "$FREE_KIB" -ge "$MIN_FREE_KIB" ] ||
  die "less than 40 GiB free after provisioning; do not start the pilot"
DOCKER_FREE_KIB="$(df -Pk /var/lib/docker | awk 'NR==2 {print $4}')"
[ "$DOCKER_FREE_KIB" -ge "$MIN_FREE_KIB" ] ||
  die "less than 40 GiB free for Docker; do not start the pilot"
echo "Ubuntu staging host prepared; verify a new key-only SSH login before ending this root session."
echo "Docker group membership applies at the deploy user's next login."
