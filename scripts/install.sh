#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# YOS One-Click Installer
#
# Usage (installs the latest release of yoyooai/yos-core):
#   curl -fsSL <install-script-url> | bash
#
# Install from a different release repository:
#   curl -fsSL <install-script-url> | YOS_RELEASE_REPO=owner/repository bash
#
# Install from a specific branch:
#   curl -fsSL <install-script-url> | YOS_REPO=<git-url> bash -s -- --branch <tag-or-branch>
#
# Full non-interactive deployment:
#   curl -fsSL .../install.sh | bash -s -- -y --setup-token sk-ant-oat01-xxx --domain example.com --https
#
# Install with Codex runtime:
#   curl -fsSL .../install.sh | bash -s -- -y --runtime codex --domain example.com --https
#
# Install with custom API base URLs:
#   curl -fsSL .../install.sh | bash -s -- -y --base-url https://claude-proxy.example.com
#   curl -fsSL .../install.sh | bash -s -- -y --runtime codex --codex-base-url https://proxy.example.com/v1
#
# Install environment only (no init):
#   curl -fsSL .../install.sh | bash -s -- --no-init
#
# Supported platforms: Linux (Debian/Ubuntu/RHEL), macOS
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# Wrap entire script in a block so bash must read all of it
# before executing anything — protects against partial downloads
# when piped via curl | bash.
_main() {

# ── Parse Arguments ───────────────────────────────────────────
BRANCH=""
NO_INIT=false
INIT_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --branch|-b)
      if [ -z "${2:-}" ]; then
        echo "[yos] Error: --branch requires a value" >&2
        exit 1
      fi
      BRANCH="$2"
      shift 2
      ;;
    --no-init)
      NO_INIT=true
      shift
      ;;
    # Flags that take a value — forward both flag and value to yos init
    --timezone|--setup-token|--api-key|--codex-api-key|--base-url|--codex-base-url|--domain|--web-password|--runtime)
      if [ -z "${2:-}" ]; then
        echo "[yos] Error: $1 requires a value" >&2
        exit 1
      fi
      INIT_ARGS+=("$1" "$2")
      shift 2
      ;;
    # Boolean flags — forward as-is to yos init
    -y|--yes|-q|--quiet|--https|--no-https|--caddy|--no-caddy|-h|--help)
      INIT_ARGS+=("$1")
      shift
      ;;
    # Combined short flags (e.g., -yq) — only allow [yqh] characters
    -[yqh][yqh]|-[yqh][yqh][yqh])
      INIT_ARGS+=("$1")
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# ── Configuration ─────────────────────────────────────────────
YOS_REPO="${YOS_REPO:-}"
# Default source of record. Keeping it here — rather than only in the copy we
# host on the download page — means the hosted copy is a byte-identical copy of
# this file, so the two cannot drift apart unnoticed.
YOS_RELEASE_REPO="${YOS_RELEASE_REPO:-yoyooai/yos-core}"

# Distribution mirror. Everything this script must download is served from here,
# because GitHub is not reliably reachable where YOS gets installed (measured
# 2026-08-05 from a mainland-China host: raw.githubusercontent 8/8 timeouts,
# `git clone` 2 of 3 timing out at 45s, release assets unusable). GitHub remains
# the source of record and is still tried as a fallback.
# Keep the default in sync with cli/lib/dist-origin.js — one dash, so that an
# explicitly empty value disables the mirror instead of restoring the default.
YOS_DIST_BASE="${YOS_DIST_BASE-https://yoyooai.com/dist}"

# Node.js is pinned and SHA-256 verified rather than installed through nvm:
# nvm's own installer lives on raw.githubusercontent and then clones from
# GitHub, so it cannot bootstrap a machine that has no GitHub access.
NODE_VERSION="${YOS_NODE_VERSION:-24.19.0}"
MIN_NODE_MAJOR=20
NODE_MIRROR="${YOS_NODE_MIRROR:-https://cdn.npmmirror.com/binaries/node}"
DOWNLOAD_CONNECT_TIMEOUT="${YOS_DOWNLOAD_CONNECT_TIMEOUT:-8}"
DOWNLOAD_MAX_TIME="${YOS_DOWNLOAD_MAX_TIME:-120}"
NODE_ARCHIVE_MAX_BYTES=134217728
NODE_SHASUMS_MAX_BYTES=262144

# ── Colors (disabled if not a terminal) ───────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  BCYAN='\033[1;36m'
  DIM='\033[2m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BCYAN='' DIM='' BOLD='' NC=''
fi

info()  { printf "${CYAN}[yos]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[yos]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[yos]${NC} %s\n" "$*"; }
fail()  { printf "${RED}[yos]${NC} %s\n" "$*" >&2; exit 1; }

# /dev/tty is a device node that is always present, so testing for its existence
# says nothing about whether a terminal is reachable: with no controlling
# terminal it exists but cannot be opened. Unattended installs (CI, cloud-init,
# nohup, setsid) land exactly there — reading from /dev/tty then fails, which
# either aborts the install or skips a step while still reporting success.
# Every place that wants to talk to the user must ask this, not test existence.
_tty_readable() { (: < /dev/tty) 2>/dev/null; }

# ── Distribution mirror ───────────────────────────────────────
# A credential-free HTTPS URL with no query string or fragment: artifact URLs
# have to stay copy-pasteable, cacheable and safe to print in a log. Plain http
# is accepted for loopback only, which is how an acceptance run serves a copy of
# the mirror locally — the same exception cli/lib/dist-origin.js makes.
validate_dist_base() {
  [[ "$1" =~ ^https://[^/@?#[:space:]]+(/[^@?#[:space:]]*)?$ ]] && return 0
  [[ "$1" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/[^@?#[:space:]]*)?$ ]]
}

if [ -n "$YOS_DIST_BASE" ] && ! validate_dist_base "$YOS_DIST_BASE"; then
  fail "YOS_DIST_BASE must be a credential-free HTTPS URL without query parameters or fragments. Repair: export YOS_DIST_BASE=https://yoyooai.com/dist && retry."
fi

# Print the mirror URL for a path, or fail (status 1) when no mirror is set.
dist_url() {
  [ -n "$YOS_DIST_BASE" ] || return 1
  printf '%s/%s\n' "${YOS_DIST_BASE%/}" "$1"
}

download_to() {
  local url="$1" output="$2" max_bytes="$3"
  curl -fL --silent --show-error --retry 2 --retry-delay 1 \
    --connect-timeout "$DOWNLOAD_CONNECT_TIMEOUT" --max-time "$DOWNLOAD_MAX_TIME" \
    --max-redirs 5 --max-filesize "$max_bytes" --proto '=https' --proto-redir '=https' \
    -o "$output" "$url"
}

# Resolve the newest published release into LATEST_TAG.
# Mirror first, GitHub second, and a loud failure last: the previous version of
# this script resolved the tag inside a command substitution under `set -e`, so
# an unreachable GitHub killed the install with no message at all and exit 7.
LATEST_TAG=""
resolve_latest_tag() {
  local url raw tag
  LATEST_TAG=""

  if url="$(dist_url "${YOS_RELEASE_REPO}/releases/latest.json")"; then
    if ! raw="$(curl -fsSL --connect-timeout "$DOWNLOAD_CONNECT_TIMEOUT" \
      --max-time "$DOWNLOAD_MAX_TIME" "$url" 2>/dev/null)"; then
      raw=""
      warn "Could not read $url — trying GitHub" >&2
    fi
    tag="$(printf '%s' "$raw" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
    if [ -n "$tag" ]; then
      LATEST_TAG="$tag"
      return 0
    fi
  fi

  if ! raw="$(curl -fsSL --connect-timeout "$DOWNLOAD_CONNECT_TIMEOUT" \
    --max-time "$DOWNLOAD_MAX_TIME" \
    "https://api.github.com/repos/${YOS_RELEASE_REPO}/releases/latest" 2>/dev/null)"; then
    raw=""
  fi
  tag="$(printf '%s' "$raw" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  if [ -n "$tag" ]; then
    warn "Resolved the latest release from GitHub — the distribution mirror did not answer" >&2
    LATEST_TAG="$tag"
    return 0
  fi
  return 1
}

# ── Resolve install ref ───────────────────────────────────────
if [ -n "$YOS_RELEASE_REPO" ]; then
  if [[ ! "$YOS_RELEASE_REPO" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    fail "YOS_RELEASE_REPO must use the owner/repository format"
  fi
  if [ -z "$YOS_REPO" ]; then
    YOS_REPO="https://github.com/${YOS_RELEASE_REPO}.git"
  fi
fi

if [ -z "$YOS_REPO" ]; then
  fail "No YOS source configured. Set YOS_RELEASE_REPO=owner/repository or YOS_REPO=<git-url>."
fi

if [ -z "$BRANCH" ]; then
  if [ -z "$YOS_RELEASE_REPO" ]; then
    fail "No release repository configured. Pass --branch <tag-or-branch> with YOS_REPO."
  fi
  if resolve_latest_tag; then
    BRANCH="$LATEST_TAG"
  else
    fail "Could not resolve the latest YOS release from ${YOS_DIST_BASE:-(no mirror)} or GitHub. Repair: check network access, or pass --branch <tag-or-branch> to install a known version."
  fi
fi

# ── OS Detection ──────────────────────────────────────────────
detect_os() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)  OS="linux" ;;
    Darwin) OS="macos" ;;
    *)      fail "Unsupported operating system: $OS. Try installing via SSH: claude --ssh user@linux-server" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)  ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)             fail "Unsupported architecture: $ARCH" ;;
  esac

  info "Detected: $OS ($ARCH)"
}

# ── Package Manager ───────────────────────────────────────────
APT_UPDATED=false

install_system_package() {
  local pkg="$1"
  info "Installing $pkg..."

  if [ "$OS" = "macos" ]; then
    if ! command -v brew &>/dev/null; then
      fail "Homebrew not found. Install it first: https://brew.sh"
    fi
    brew install "$pkg"
  elif [ "$OS" = "linux" ]; then
    # Use sudo if not root; skip if already root (e.g., Docker containers)
    local SUDO=""
    if [ "$(id -u)" -ne 0 ]; then
      if ! command -v sudo &>/dev/null; then
        fail "sudo not found and not running as root. Please install $pkg manually as root, then re-run this script."
      fi
      SUDO="sudo"
    fi
    if command -v apt-get &>/dev/null; then
      if [ "$APT_UPDATED" = false ]; then
        $SUDO apt-get update -qq
        APT_UPDATED=true
      fi
      $SUDO apt-get install -y -qq "$pkg"
    elif command -v dnf &>/dev/null; then
      $SUDO dnf install -y "$pkg"
    elif command -v yum &>/dev/null; then
      $SUDO yum install -y "$pkg"
    else
      fail "No supported package manager found (apt-get, dnf, yum). Please install $pkg manually."
    fi
  fi
}

# ── Prerequisite: curl ────────────────────────────────────────
ensure_curl() {
  if command -v curl &>/dev/null; then
    return
  fi
  install_system_package curl
  ok "curl: installed"
}

# ── Prerequisite: git ─────────────────────────────────────────
ensure_git() {
  if command -v git &>/dev/null; then
    ok "git: $(git --version | head -1)"
    return
  fi
  install_system_package git
  ok "git: installed"
}

# ── Prerequisite: tmux ────────────────────────────────────────
ensure_tmux() {
  if command -v tmux &>/dev/null; then
    ok "tmux: $(tmux -V)"
    return
  fi
  install_system_package tmux
  ok "tmux: installed"
}

# ── Prerequisite: xz (Linux Node.js archives are .tar.xz) ────
xz_package_name() {
  if command -v apt-get &>/dev/null; then
    printf '%s\n' 'xz-utils'
  else
    printf '%s\n' 'xz'
  fi
}

xz_repair_command() {
  local prefix=''
  if [ "$(id -u)" -ne 0 ]; then
    prefix='sudo '
  fi
  if command -v apt-get &>/dev/null; then
    printf '%sapt-get install -y xz-utils\n' "$prefix"
  elif command -v dnf &>/dev/null; then
    printf '%sdnf install -y xz\n' "$prefix"
  elif command -v yum &>/dev/null; then
    printf '%syum install -y xz\n' "$prefix"
  else
    printf '%s\n' 'install the xz command with the system package manager'
  fi
}

ensure_xz() {
  if [ "$OS" != "linux" ]; then
    return
  fi
  if command -v xz &>/dev/null; then
    return
  fi
  local package repair
  package="$(xz_package_name)"
  repair="$(xz_repair_command)"
  install_system_package "$package"
  if ! command -v xz &>/dev/null; then
    fail "xz is required to extract the Linux Node.js archive, but it is still unavailable after installing $package. Repair: $repair, then retry."
  fi
  ok "xz: installed ($package)"
}

file_sha256() {
  local file_path="$1"
  if command -v sha256sum &>/dev/null; then
    sha256sum "$file_path" | cut -d' ' -f1
  else
    shasum -a 256 "$file_path" | cut -d' ' -f1
  fi
}

# ── Prerequisite: Node.js (verified binary, no GitHub) ───────
persist_node_path() {
  local marker='# yos-managed: Node.js PATH'
  # shellcheck disable=SC2016
  local export_line='export PATH="$HOME/.local/node-current/bin:$PATH"'
  mkdir -p "$HOME"
  if ! grep -Fqx "$export_line" "$HOME/.profile" 2>/dev/null; then
    if ! grep -Fqx "$marker" "$HOME/.profile" 2>/dev/null; then
      printf '\n%s\n' "$marker" >> "$HOME/.profile"
    fi
    printf '%s\n' "$export_line" >> "$HOME/.profile"
  fi
  export PATH="$HOME/.local/node-current/bin:$PATH"
}

install_node_binary() {
  if ! validate_dist_base "$NODE_MIRROR"; then
    fail "YOS_NODE_MIRROR must be a credential-free HTTPS URL without query parameters or fragments. Repair: export YOS_NODE_MIRROR=https://cdn.npmmirror.com/binaries/node && retry."
  fi
  local platform archive_ext archive_name base_url work_dir archive shasums
  local expected_sha actual_sha archive_listing extraction_repair
  local install_root version_dir extracted_dir link_path
  case "$OS" in
    linux) platform="linux"; archive_ext="tar.xz" ;;
    macos) platform="darwin"; archive_ext="tar.gz" ;;
    *) fail "No Node.js binary bootstrap is available for $OS/$ARCH." ;;
  esac
  if [ "$OS" = "linux" ]; then
    ensure_xz
    extraction_repair="$(xz_repair_command)"
  else
    extraction_repair='verify that tar and gzip are available, then retry'
  fi

  archive_name="node-v${NODE_VERSION}-${platform}-${ARCH}.${archive_ext}"
  base_url="${NODE_MIRROR%/}/v${NODE_VERSION}"
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/yos-node.XXXXXX")"
  archive="$work_dir/$archive_name"
  shasums="$work_dir/SHASUMS256.txt"

  info "Downloading Node.js v${NODE_VERSION} checksums from ${base_url}/SHASUMS256.txt"
  if ! download_to "${base_url}/SHASUMS256.txt" "$shasums" "$NODE_SHASUMS_MAX_BYTES"; then
    rm -rf "$work_dir"
    fail "Could not download Node.js checksums. Repair: export YOS_NODE_MIRROR=https://your-reachable-mirror.example/binaries/node and retry."
  fi
  expected_sha="$(awk -v file="$archive_name" '$2 == file || $2 == "*" file { print $1 }' "$shasums")"
  if [[ ! "$expected_sha" =~ ^[a-f0-9]{64}$ ]]; then
    rm -rf "$work_dir"
    fail "Node.js checksum list has no single valid SHA-256 entry for $archive_name; nothing was installed."
  fi

  info "Downloading Node.js v${NODE_VERSION} from ${base_url}/${archive_name}"
  if ! download_to "${base_url}/${archive_name}" "$archive" "$NODE_ARCHIVE_MAX_BYTES"; then
    rm -rf "$work_dir"
    fail "Could not download Node.js. Repair: export YOS_NODE_MIRROR=https://your-reachable-mirror.example/binaries/node and retry."
  fi
  if [ ! -s "$archive" ]; then
    rm -rf "$work_dir"
    fail "Node.js archive is empty; nothing was installed."
  fi
  actual_sha="$(file_sha256 "$archive")"
  if [ "$actual_sha" != "$expected_sha" ]; then
    rm -rf "$work_dir"
    fail "Node.js archive SHA-256 verification failed; nothing was installed."
  fi

  extracted_dir="$work_dir/node-v${NODE_VERSION}-${platform}-${ARCH}"
  archive_listing="$work_dir/archive.list"
  if ! tar -tf "$archive" > "$archive_listing"; then
    rm -rf "$work_dir"
    fail "Node.js archive could not be read by tar. Repair: $extraction_repair."
  fi
  if ! awk -v root="node-v${NODE_VERSION}-${platform}-${ARCH}/" \
    'index($0, root) != 1 { bad=1 } END { exit bad }' "$archive_listing"; then
    rm -rf "$work_dir"
    fail "Node.js archive contains paths outside its expected directory; nothing was installed."
  fi
  if ! tar -xf "$archive" -C "$work_dir"; then
    rm -rf "$work_dir"
    fail "Node.js archive extraction failed after its paths passed validation. Repair: $extraction_repair."
  fi
  if [ ! -x "$extracted_dir/bin/node" ] || [ ! -x "$extracted_dir/bin/npm" ]; then
    rm -rf "$work_dir"
    fail "Verified Node.js archive is missing executable node or npm files; nothing was installed."
  fi

  install_root="$HOME/.local"
  version_dir="$install_root/node-v${NODE_VERSION}-${platform}-${ARCH}"
  link_path="$install_root/node-current"
  mkdir -p "$install_root"
  if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
    rm -rf "$work_dir"
    fail "$link_path already exists and is not a symlink; move it aside and retry."
  fi
  if [ -e "$version_dir" ] && [ ! -d "$version_dir" ]; then
    rm -rf "$work_dir"
    fail "$version_dir already exists and is not a directory; move it aside and retry."
  fi
  if [ -d "$version_dir" ]; then
    if [ ! -x "$version_dir/bin/node" ] || [ ! -x "$version_dir/bin/npm" ] \
      || [ "$("$version_dir/bin/node" -v 2>/dev/null)" != "v${NODE_VERSION}" ]; then
      rm -rf "$work_dir"
      fail "$version_dir exists but is not a complete Node.js v${NODE_VERSION} installation; move it aside and retry."
    fi
  else
    mv "$extracted_dir" "$version_dir"
  fi
  ln -sfn "$version_dir" "$link_path"
  rm -rf "$work_dir"
  persist_node_path
  ok "node: $(node -v) (verified SHA-256: $actual_sha)"
}

ensure_node() {
  # An existing Node.js that meets the minimum is left alone.
  if command -v node &>/dev/null && command -v npm &>/dev/null; then
    local current_major
    current_major="$(node -v | sed 's/v//' | cut -d. -f1)"
    if [[ "$current_major" =~ ^[0-9]+$ ]] && [ "$current_major" -ge "$MIN_NODE_MAJOR" ]; then
      ok "node: $(node -v) (meets >= v${MIN_NODE_MAJOR} requirement)"
      return
    fi
    warn "node: $(node -v) is below minimum v${MIN_NODE_MAJOR}, installing a verified Node.js binary..."
  elif command -v node &>/dev/null; then
    warn "node found but npm is missing, installing a verified Node.js binary..."
  fi

  install_node_binary
}

# ── Ensure PATH in shell profile ─────────────────────────────
# Auto-add necessary bin directories to the user's shell profile so
# yos, pm2, and claude are available in new terminal sessions.
# Called independently of yos init — acts as a safety net.
_ensure_path_in_profile() {
  # Determine shell rc file (fish uses a different config mechanism)
  local shell_rc is_fish=false
  case "${SHELL:-}" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
    */fish) is_fish=true ;;
    *)      shell_rc="$HOME/.profile" ;;
  esac

  mkdir -p "$HOME/.local/bin" "$HOME/yos/bin"

  if [ "$is_fish" = true ]; then
    # Fish uses a different syntax and config path
    local fish_conf_dir="$HOME/.config/fish/conf.d"
    mkdir -p "$fish_conf_dir"
    local fish_conf="$fish_conf_dir/yos.fish"
    if [ ! -f "$fish_conf" ]; then
      cat > "$fish_conf" <<'FISH_EOF'
# Added by yos installer
fish_add_path -g $HOME/.local/bin
fish_add_path -g $HOME/yos/bin
FISH_EOF
      ok "PATH configured in conf.d/yos.fish"
    fi
  else
    # 1. ~/.local/bin — claude installs here
    #    Idempotency: grep for uncommented ".local/bin" (skip commented-out lines)
    # shellcheck disable=SC2016
    local local_bin_export='export PATH="$HOME/.local/bin:$PATH"'
    if ! grep -q '^[^#]*\.local/bin' "$shell_rc" 2>/dev/null; then
      printf '\n# Added by yos installer\n%s\n' "$local_bin_export" >> "$shell_rc"
    fi

    # 2. ~/yos/bin — component CLIs (caddy, etc.)
    #    Idempotency: grep for "yos-managed: bin PATH" marker (matches init.js pattern)
    local yos_marker='# yos-managed: bin PATH'
    local yos_bin_export="export PATH=\"\$HOME/yos/bin:\$PATH\""

    # Write to ~/.profile (login shells + non-interactive shells)
    if ! grep -q 'yos-managed: bin PATH' "$HOME/.profile" 2>/dev/null; then
      printf '\n%s\n%s\n' "$yos_marker" "$yos_bin_export" >> "$HOME/.profile"
    fi
    # Write to shell rc file (interactive shells)
    if [ "$shell_rc" != "$HOME/.profile" ]; then
      if ! grep -q 'yos-managed: bin PATH' "$shell_rc" 2>/dev/null; then
        printf '\n%s\n%s\n' "$yos_marker" "$yos_bin_export" >> "$shell_rc"
      fi
    fi

    ok "PATH configured in $(basename "$shell_rc")"
  fi

  # Export for the running script (so yos init can find binaries)
  export PATH="$HOME/.local/bin:$HOME/yos/bin:$PATH"
}

# ── Install YOS ─────────────────────────────────────────────
install_yos() {
  if command -v yos &>/dev/null; then
    local current_version
    current_version="$(yos --version 2>/dev/null || echo 'unknown')"
    warn "yos is already installed (${current_version}). Upgrading..."
  fi

  # Prefer the packaged release on our mirror. `npm install -g <git-url>` makes
  # npm clone from GitHub, which is the single most likely thing to fail on a
  # customer machine; a tarball over HTTPS from our own domain does not.
  local install_url="${YOS_REPO}#${BRANCH}" source_label="git (${BRANCH})"
  local package_url package_version
  package_version="${BRANCH#v}"
  if package_url="$(dist_url "${YOS_RELEASE_REPO}/package/yos-${package_version}.tgz")"; then
    if curl -fsI --connect-timeout "$DOWNLOAD_CONNECT_TIMEOUT" --max-time 30 \
      -o /dev/null "$package_url" 2>/dev/null; then
      install_url="$package_url"
      source_label="release package (${BRANCH})"
    else
      warn "No release package for ${BRANCH} on the distribution mirror — installing from git, which needs GitHub"
    fi
  fi
  info "Installing yos from ${source_label}..."

  # If npm global prefix is not user-writable (system-installed node),
  # use sudo for npm install -g
  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || echo "")"
  if [ -n "$npm_prefix" ] && [ -w "$npm_prefix" ]; then
    npm install -g --install-links "$install_url"
  else
    warn "npm global directory (${npm_prefix:-unknown}) requires elevated permissions, using sudo..."
    if [ "$(id -u)" -eq 0 ]; then
      npm install -g --install-links "$install_url"
    else
      sudo npm install -g --install-links "$install_url"
    fi
  fi

  ok "yos: $(yos --version 2>/dev/null || echo 'installed')"
}

# ── Entry Point ───────────────────────────────────────────────
echo ""
printf '%b' "${BCYAN}"
echo "  ███████╗██╗   ██╗██╗      ██████╗ ███████╗"
echo "  ╚══███╔╝╚██╗ ██╔╝██║     ██╔═══██╗██╔════╝"
echo "    ███╔╝  ╚████╔╝ ██║     ██║   ██║███████╗"
printf '%b' "${CYAN}"
echo "   ███╔╝    ╚██╔╝  ██║     ██║   ██║╚════██║"
echo "  ███████╗   ██║   ███████╗╚██████╔╝███████║"
echo "  ╚══════╝   ╚═╝   ╚══════╝ ╚═════╝ ╚══════╝"
printf '%b' "${NC}"
echo ""
printf '%b' "  ${BOLD}Give your AI a life.${NC}"
echo ""
echo ""

# Warn if running as root (yos keeps its state under a user's home directory)
if [ "$(id -u)" -eq 0 ]; then
  warn "Running as root is not recommended. YOS works best under a regular user account."
  warn "Press Ctrl+C to abort, or wait 5 seconds to continue..."
  sleep 5
fi

detect_os

if [ "$BRANCH" != "main" ]; then
  info "Branch: ${BRANCH}"
fi

# ── Security Consent ─────────────────────────────────────────
# Show security notice before installing anything. Skip in non-interactive
# mode (-y) or when stdin is not a terminal (piped without /dev/tty).
_has_yes_flag() {
  for arg in "${INIT_ARGS[@]+"${INIT_ARGS[@]}"}"; do
    case "$arg" in -y|--yes|-yq|-qy|-yqh|-qyh|-hyq|-hqy|-yhq|-qhy) return 0 ;; esac
  done
  return 1
}

if ! _has_yes_flag && { [ -t 0 ] || _tty_readable; }; then
  echo ""
  printf '%b' "${YELLOW}${BOLD}"
  echo "  ◆ Security Notice"
  printf '%b' "${NC}"
  printf '%b' "${DIM}"
  echo "  ┌────────────────────────────────────────────────────────┐"
  echo "  │                                                        │"
  printf '%b' "${NC}"
  printf "  ${DIM}│${NC}  ${DIM}YOS currently assumes a trusted environment.${NC}     ${DIM}│${NC}\n"
  printf "  ${DIM}│${NC}  ${DIM}It runs with full system access as the current${NC}     ${DIM}│${NC}\n"
  printf "  ${DIM}│${NC}  ${DIM}user — it can execute commands, read/write${NC}          ${DIM}│${NC}\n"
  printf "  ${DIM}│${NC}  ${DIM}files, and access the network on your behalf.${NC}      ${DIM}│${NC}\n"
  printf '%b' "${DIM}"
  echo "  │                                                        │"
  printf '%b' "${NC}"
  printf "  ${DIM}│${NC}  ${YELLOW}⚠ Dangerous: If untrusted people can reach${NC}         ${DIM}│${NC}\n"
  printf "  ${DIM}│${NC}  ${YELLOW}this machine or talk to the bot, they can${NC}          ${DIM}│${NC}\n"
  printf "  ${DIM}│${NC}  ${YELLOW}execute anything as your user.${NC}                     ${DIM}│${NC}\n"
  printf '%b' "${DIM}"
  echo "  │                                                        │"
  echo "  └────────────────────────────────────────────────────────┘"
  printf '%b' "${NC}"
  echo ""
  echo "  Only continue if you understand the risks and trust"
  echo "  the environment you are installing on."
  echo ""
  printf '%b' "${BOLD}"
  printf "  I understand and want to continue [Y/n]: "
  printf '%b' "${NC}"
  if _tty_readable; then
    read -r answer < /dev/tty
  else
    read -r answer
  fi
  case "${answer:-Y}" in
    [Yy]*|"")
      # User accepted — tell yos init to skip its own consent prompt
      INIT_ARGS+=("--skip-consent")
      ;;
    *)
      echo ""
      info "Installation cancelled. No changes were made."
      echo ""
      exit 0
      ;;
  esac
fi

echo ""
info "Checking prerequisites..."
echo ""

ensure_curl
ensure_git
ensure_tmux
ensure_node

echo ""
install_yos

echo ""
_ensure_path_in_profile
echo ""
ok "Installation complete!"
echo ""

# Detect the user's shell rc file
_detect_shell_rc() {
  case "${SHELL:-}" in
    */zsh)  echo "~/.zshrc" ;;
    */bash) echo "~/.bashrc" ;;
    */fish) echo "" ;;
    *)      echo "~/.profile" ;;
  esac
}

# Show the post-install hint for activating PATH in the current terminal.
# Styled as a separator + prominent command, not a box (avoids clashing with
# yos init's own boxed output).
_show_source_hint() {
  local shell_rc
  shell_rc="$(_detect_shell_rc)"

  echo ""
  printf '%b' "${CYAN}"
  echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  printf '%b' "${NC}"
  echo ""
  if [ -n "$shell_rc" ]; then
    printf '%b' "${BOLD}"
    echo "  To activate yos commands in this terminal:"
    printf '%b' "${NC}"
    echo ""
    printf '%b' "${GREEN}${BOLD}"
    echo "    source $shell_rc"
    printf '%b' "${NC}"
  else
    printf '%b' "${BOLD}"
    echo "  To activate yos commands, open a new terminal."
    printf '%b' "${NC}"
  fi
  echo ""
  info "New terminal sessions will work automatically."
  echo ""
}

if [ "$NO_INIT" = true ]; then
  local shell_rc
  shell_rc="$(_detect_shell_rc)"
  info "Skipping yos init (--no-init)."
  echo ""
  if [ -n "$shell_rc" ]; then
    info "To initialize later, open a new terminal or run:"
    echo ""
    echo "    source $shell_rc && yos init"
  else
    info "To initialize later, open a new terminal and run:"
    echo ""
    echo "    yos init"
  fi
  echo ""
else
  # Always run yos init after installation (environment is ready at this point).
  info "Running yos init..."
  echo ""
  local init_exit=0
  if _tty_readable; then
    yos init ${INIT_ARGS[@]+"${INIT_ARGS[@]}"} < /dev/tty || init_exit=$?
  else
    yos init ${INIT_ARGS[@]+"${INIT_ARGS[@]}"} || init_exit=$?
  fi

  if [ "$init_exit" -eq 0 ]; then
    _show_source_hint
  else
    # yos is installed but unconfigured. Saying so and failing is the whole
    # point: a caller that only checks the exit status must not read this as a
    # finished install, or it will hand over a machine that breaks on first use.
    echo ""
    warn "yos init did not complete (exit code $init_exit)."
    info "yos itself is installed. Finish the setup with:"
    echo ""
    echo "    yos init"
    echo ""
    return "$init_exit"
  fi
fi

} # end of _main — do not remove (partial download guard)

_main "$@"
