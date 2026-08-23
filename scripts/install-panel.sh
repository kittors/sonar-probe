#!/usr/bin/env bash
#
# Sonar 面板一键安装
#
#   curl -fsSL https://raw.githubusercontent.com/<你的仓库>/main/scripts/install-panel.sh | sudo bash
#
# 或者克隆仓库后本地跑：
#
#   sudo ./scripts/install-panel.sh --from-source .
#
# 做的事：装运行时 → 放产物 → 建专用用户 → 写 systemd → 生成密钥 → 起服务。
# 幂等：重复执行只会更新产物和配置，不会重置数据库，也不会重新生成已有的密钥。

set -euo pipefail

# ————————————————————————————————————————————————————————
# 可调参数
# ————————————————————————————————————————————————————————

PREFIX="${SONAR_PREFIX:-/opt/sonar}"
SERVICE_USER="${SONAR_USER:-sonar}"
PORT="${SONAR_PORT:-8787}"
BIND="${SONAR_HOST:-127.0.0.1}"
NODE_VERSION="${SONAR_NODE_VERSION:-24.4.0}"
NODE_PREFIX="${SONAR_NODE_PREFIX:-/opt/node}"

SOURCE_DIR=""
DIST_DIR=""
DO_NGINX=0
PANEL_DOMAIN=""

# ————————————————————————————————————————————————————————
# 输出
# ————————————————————————————————————————————————————————

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_B=""; C_0=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C_OK" "$C_0" "$C_B" "$1" "$C_0"; }
info() { printf '    %s\n' "$1"; }
dim()  { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_0"; }
warn() { printf '%s [警告]%s %s\n' "$C_WARN" "$C_0" "$1" >&2; }
die()  { printf '%s [失败]%s %s\n' "$C_ERR" "$C_0" "$1" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法：sudo ./install-panel.sh [选项]

  --from-source <目录>   从源码构建（需要 Node 和 pnpm；目录是仓库根）
  --from-dist <目录>     用已经构建好的产物（目录里要有 server/ 和 web/）
  --domain <域名>        同时配置 nginx 反代 + Let's Encrypt 证书
  --port <端口>          面板监听端口，默认 8787
  --prefix <路径>        安装目录，默认 /opt/sonar
  -h, --help             显示这份帮助

不带 --from-* 时，脚本会在当前目录找仓库；找不到就报错退出。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from-source) SOURCE_DIR="${2:-}"; shift 2 ;;
    --from-dist)   DIST_DIR="${2:-}"; shift 2 ;;
    --domain)      PANEL_DOMAIN="${2:-}"; DO_NGINX=1; shift 2 ;;
    --port)        PORT="${2:-}"; shift 2 ;;
    --prefix)      PREFIX="${2:-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

# ————————————————————————————————————————————————————————
# 环境检查
# ————————————————————————————————————————————————————————

step "检查环境"

[ "$(id -u)" -eq 0 ] || die "需要 root：请用 sudo 运行"

command -v systemctl >/dev/null 2>&1 || die "没找到 systemd。这个脚本只支持 systemd 系统（Debian/Ubuntu/CentOS/Rocky 等）"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) die "不支持的架构：$ARCH" ;;
esac

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  info "系统：${PRETTY_NAME:-未知} ($ARCH)"
else
  warn "读不到 /etc/os-release，继续，但包安装可能失败"
fi

PKG=""
for candidate in apt-get dnf yum apk; do
  if command -v "$candidate" >/dev/null 2>&1; then PKG="$candidate"; break; fi
done
[ -n "$PKG" ] || warn "没找到已知的包管理器，缺依赖时需要你手动装"

pkg_install() {
  case "$PKG" in
    apt-get) DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" >/dev/null ;;
    dnf)     dnf install -y "$@" >/dev/null ;;
    yum)     yum install -y "$@" >/dev/null ;;
    apk)     apk add --no-cache "$@" >/dev/null ;;
    *)       return 1 ;;
  esac
}

step "安装基础依赖"
for bin in curl tar; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    info "安装 $bin"
    pkg_install "$bin" || die "装不上 $bin，请手动安装后重试"
  fi
done
dim "curl、tar 就绪"

# ————————————————————————————————————————————————————————
# Node.js
#
# 必须 >= 22：面板用的是内置的 node:sqlite，省掉了 better-sqlite3 那种
# 需要编译原生模块的依赖（在没有编译器的小机器上装它是场灾难）。
# ————————————————————————————————————————————————————————

step "准备 Node.js 运行时"

node_ok() {
  local bin="$1"
  [ -x "$bin" ] || return 1
  local major
  major="$("$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 22 ] 2>/dev/null
}

NODE_BIN=""
if node_ok "$NODE_PREFIX/bin/node"; then
  NODE_BIN="$NODE_PREFIX/bin/node"
  dim "已安装：$("$NODE_BIN" -v)（$NODE_PREFIX）"
elif node_ok "$(command -v node || echo /nonexistent)"; then
  NODE_BIN="$(command -v node)"
  dim "使用系统 Node：$("$NODE_BIN" -v)"
else
  info "下载 Node ${NODE_VERSION}（${NODE_ARCH}）"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL "$URL" -o "$TMP/node.tar.xz" || die "下载失败：$URL"
  mkdir -p "$NODE_PREFIX"
  tar -xJf "$TMP/node.tar.xz" -C "$NODE_PREFIX" --strip-components=1
  NODE_BIN="$NODE_PREFIX/bin/node"
  node_ok "$NODE_BIN" || die "Node 安装后仍然不可用"
  dim "已安装：$("$NODE_BIN" -v) → $NODE_PREFIX"
fi

# ————————————————————————————————————————————————————————
# 产物
# ————————————————————————————————————————————————————————

step "准备面板产物"

if [ -z "$SOURCE_DIR" ] && [ -z "$DIST_DIR" ]; then
  if [ -f "./package.json" ] && [ -d "./apps/server" ]; then
    SOURCE_DIR="."
    dim "在当前目录找到仓库"
  else
    die "不知道从哪拿产物。用 --from-source <仓库目录> 或 --from-dist <产物目录>"
  fi
fi

if [ -n "$SOURCE_DIR" ]; then
  [ -d "$SOURCE_DIR/apps/server" ] || die "$SOURCE_DIR 看起来不是 Sonar 仓库（缺 apps/server）"
  command -v pnpm >/dev/null 2>&1 || {
    info "安装 pnpm"
    "$NODE_PREFIX/bin/npm" install -g pnpm >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1 ||
      die "装不上 pnpm，请手动安装后重试"
  }
  info "构建中（首次会久一点）"
  ( cd "$SOURCE_DIR" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null ) ||
    die "构建失败，先在本地跑一遍 pnpm build 看错误"
  SRC_SERVER="$SOURCE_DIR/apps/server/dist"
  SRC_WEB="$SOURCE_DIR/apps/dashboard/dist"
  SRC_PKG="$SOURCE_DIR/apps/server/package.json"
else
  [ -d "$DIST_DIR/server" ] && [ -d "$DIST_DIR/web" ] || die "$DIST_DIR 里要有 server/ 和 web/ 两个目录"
  SRC_SERVER="$DIST_DIR/server"
  SRC_WEB="$DIST_DIR/web"
  SRC_PKG="$DIST_DIR/package.json"
fi

[ -f "$SRC_SERVER/index.js" ] || die "产物不完整：$SRC_SERVER/index.js 不存在"

# ————————————————————————————————————————————————————————
# 用户与目录
# ————————————————————————————————————————————————————————

step "创建用户和目录"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  # 系统用户、不给登录 shell、不建家目录 —— 它只需要跑一个进程
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null ||
    useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER" ||
    die "创建用户 $SERVICE_USER 失败"
  dim "已创建系统用户 $SERVICE_USER"
else
  dim "用户 $SERVICE_USER 已存在"
fi

mkdir -p "$PREFIX/server/dist" "$PREFIX/web" "$PREFIX/server/data"

info "同步服务端产物"
cp -r "$SRC_SERVER/." "$PREFIX/server/dist/"
[ -f "$SRC_PKG" ] && cp "$SRC_PKG" "$PREFIX/server/package.json"

info "同步前端产物"
# --delete 语义：先清空再拷，避免旧版本的哈希文件永远留着
find "$PREFIX/web" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -r "$SRC_WEB/." "$PREFIX/web/"

# node_modules：服务端有 fastify 等运行时依赖
if [ -n "$SOURCE_DIR" ] && [ -d "$SOURCE_DIR/apps/server/node_modules" ]; then
  info "同步运行时依赖"
  rm -rf "$PREFIX/server/node_modules"
  cp -r "$SOURCE_DIR/apps/server/node_modules" "$PREFIX/server/node_modules"
fi

# ————————————————————————————————————————————————————————
# 密钥
#
# 已存在就不动 —— 重跑安装脚本不该让所有 agent 需要重新配 token。
# ————————————————————————————————————————————————————————

step "配置密钥"

ENV_FILE="$PREFIX/server/data/panel.env"

gen_secret() { head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40; }

if [ -f "$ENV_FILE" ]; then
  dim "沿用已有的 $ENV_FILE"
else
  AGENT_TOKEN="$(gen_secret)"
  umask 077
  cat > "$ENV_FILE" <<EOF
# Sonar 面板配置。修改后需要 systemctl restart sonar

# 采集端上报凭据。装 agent 时要用同一个值
SONAR_AGENT_TOKEN=$AGENT_TOKEN

# 演示数据默认就是关的，这里写出来只是让它显式可见。
# 想在本地看效果可以改成 1，生产别动。
SONAR_SIMULATOR=0

# GitHub 登录（可选）。第一个登录成功的人自动成为管理员。
# 回调地址填 https://<你的域名>/api/auth/github/callback
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=

# 面板自己的公网地址，用于阻止误封导致 agent 失联
# SONAR_PANEL_IP=

# 免封白名单，逗号分隔，支持 CIDR。建议放办公网出口和跳板机
# SONAR_ALLOWLIST=

# 关闭访客登录
# SONAR_DISABLE_GUEST=1
EOF
  umask 022
  dim "已生成 $ENV_FILE"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"
chmod 700 "$PREFIX/server/data"
chmod 600 "$ENV_FILE"

# ————————————————————————————————————————————————————————
# systemd
# ————————————————————————————————————————————————————————

step "写入 systemd 服务"

cat > /etc/systemd/system/sonar.service <<EOF
[Unit]
Description=Sonar 探针面板
Documentation=https://github.com/your/sonar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$PREFIX/server
Environment=NODE_ENV=production
Environment=SONAR_PORT=$PORT
Environment=SONAR_HOST=$BIND
Environment=SONAR_DB=$PREFIX/server/data/sonar.db
Environment=SONAR_DATA_DIR=$PREFIX/server/data
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN dist/index.js
Restart=always
RestartSec=3

# —— 沙箱 ——
# 面板只需要读自己的产物、写自己的 data 目录，别的一概不给。
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$PREFIX/server/data
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
# 面板不需要任何特权能力：它自己不碰防火墙，那是 agent 的事
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sonar >/dev/null 2>&1
systemctl restart sonar

sleep 2
if systemctl is-active --quiet sonar; then
  dim "服务已启动"
else
  warn "服务没起来，看日志：journalctl -u sonar -n 50 --no-pager"
  exit 1
fi

# ————————————————————————————————————————————————————————
# nginx（可选）
# ————————————————————————————————————————————————————————

if [ "$DO_NGINX" -eq 1 ]; then
  step "配置 nginx 反代（$PANEL_DOMAIN）"

  command -v nginx >/dev/null 2>&1 || pkg_install nginx || die "装不上 nginx"

  NGINX_CONF="/etc/nginx/conf.d/sonar.conf"
  cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $PANEL_DOMAIN;

    location / {
        proxy_pass http://$BIND:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # WebSocket 必须透传这两个头，否则实时数据流连不上
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
EOF

  nginx -t >/dev/null 2>&1 || die "nginx 配置检查不通过，看 nginx -t 的输出"
  systemctl reload nginx
  dim "已写入 $NGINX_CONF"

  if command -v certbot >/dev/null 2>&1; then
    info "申请证书"
    certbot --nginx -d "$PANEL_DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect ||
      warn "证书申请失败，可以稍后手动跑：certbot --nginx -d $PANEL_DOMAIN"
  else
    warn "没装 certbot，暂时只有 HTTP。装完后跑：certbot --nginx -d $PANEL_DOMAIN"
  fi
fi

# ————————————————————————————————————————————————————————
# 收尾
# ————————————————————————————————————————————————————————

TOKEN_VALUE="$(grep '^SONAR_AGENT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"

step "安装完成"

if [ "$DO_NGINX" -eq 1 ]; then
  info "面板地址：https://$PANEL_DOMAIN"
else
  info "面板地址：http://<本机IP>:$PORT"
  dim "当前只监听 $BIND。要从外网访问，请配 nginx 反代（重跑本脚本加 --domain <域名>）"
fi

cat <<EOF

    ${C_B}下一步${C_0}

    1) 装采集端（在每台要监控的机器上跑）：

       sudo ./install-agent.sh --panel <面板地址> --token $TOKEN_VALUE --id <机器标识>

    2) 开启 GitHub 登录（可选，但强烈建议）：

       在 GitHub 建一个 OAuth App，回调地址填
         <面板地址>/api/auth/github/callback
       把 Client ID / Secret 填进 $ENV_FILE，然后
         systemctl restart sonar
       第一个登录成功的人自动成为管理员。

    ${C_DIM}配置文件  $ENV_FILE
    数据库    $PREFIX/server/data/sonar.db
    日志      journalctl -u sonar -f${C_0}

EOF
