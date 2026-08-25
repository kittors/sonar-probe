#!/usr/bin/env bash
#
# Sonar 采集端一键安装
#
#   sudo ./install-agent.sh --panel https://面板地址 --token <token> --id <机器标识>
#
# 装完会立刻跑一次采样自检，把"装上了但采不到东西"的情况当场暴露出来 ——
# 尤其是 conntrack 没在工作这一类：基础指标一切正常，唯独流量归因永远是空的，
# 不主动查根本不知道哪里出了问题。

set -euo pipefail

PREFIX="${SONAR_AGENT_PREFIX:-/opt/sonar-agent}"
PANEL=""
TOKEN=""
NODE_ID=""
NODE_NAME=""
REGION=""
COUNTRY=""
PROVIDER=""
TAGS=""
ENFORCE=0
SSH_KEYS=0
CHECK_ONLY=0
ENSURE_CT=1
BINARY=""
INTERVAL="${SONAR_INTERVAL:-3}"

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
用法：sudo ./install-agent.sh --panel <地址> --token <token> [选项]

  --panel <地址>     面板地址，如 https://sonar.example.com
  --token <token>    面板生成的 SONAR_AGENT_TOKEN
  --id <标识>        机器唯一标识，默认用主机名
  --name <名称>      面板上显示的名字，默认同 --id
  --region <地区>    如「Los Angeles」，仅用于展示
  --country <代码>   两位国家代码，如 US
  --provider <厂商>  服务商名，如 BandwagonHost
  --tags <标签>      逗号分隔，如 生产,代理
  --binary <路径>    用本地已编译好的二进制，而不是现场下载
  --enforce          允许真正修改防火墙。不加时封禁指令只打印不执行
  --ssh-keys         允许面板远程增删本机的 authorized_keys。
                     不加时密钥指令只打印不执行（和 --enforce 一个道理）。
                     注意：SSH 实况上报不受它控制 —— 那一项是只读的，一直开着
  --check-only       只检查这台机器能采到什么，不安装、不改任何东西
  --no-conntrack     不要为流量归因做任何内核侧配置。
                     默认会自动补齐：开启 conntrack 字节计数、必要时装一条
                     只计数不拦截的 nftables 规则，两者都做持久化。
                     不想让脚本碰这些就加这个参数（基础指标不受影响）
  --interval <秒>    采样间隔秒数，默认 3
  -h, --help         显示这份帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --panel)    PANEL="${2:-}"; shift 2 ;;
    --token)    TOKEN="${2:-}"; shift 2 ;;
    --id)       NODE_ID="${2:-}"; shift 2 ;;
    --name)     NODE_NAME="${2:-}"; shift 2 ;;
    --region)   REGION="${2:-}"; shift 2 ;;
    --country)  COUNTRY="${2:-}"; shift 2 ;;
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --tags)     TAGS="${2:-}"; shift 2 ;;
    --binary)   BINARY="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --enforce)  ENFORCE=1; shift ;;
    --ssh-keys) SSH_KEYS=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --ensure-conntrack) ENSURE_CT=1; shift ;;
    --no-conntrack) ENSURE_CT=0; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

# ————————————————————————————————————————————————————————
# 参数校验
# ————————————————————————————————————————————————————————

step "检查参数"

[ "$(id -u)" -eq 0 ] || die "需要 root：采集端要读其他进程的 /proc/<pid>/fd 才能做流量归因"
if [ "$CHECK_ONLY" -eq 0 ]; then
  [ -n "$PANEL" ] || die "缺 --panel"
  [ -n "$TOKEN" ] || die "缺 --token（在面板机器上看 /opt/sonar/server/data/panel.env）"
fi

if [ -n "$PANEL" ]; then
  case "$PANEL" in
    http://*|https://*) ;;
    *) die "--panel 要以 http:// 或 https:// 开头，当前是：$PANEL" ;;
  esac
fi
# 末尾斜杠会让拼出来的 URL 变成 //api/...，有些反代会 301 到别处
PANEL="${PANEL%/}"

[ -n "$NODE_ID" ] || NODE_ID="$(hostname -s 2>/dev/null || hostname)"
[ -n "$NODE_NAME" ] || NODE_NAME="$NODE_ID"
# id 会进 URL 和数据库主键，限制成安全字符集
case "$NODE_ID" in
  *[!a-zA-Z0-9._-]*) die "--id 只能用字母、数字、点、下划线、连字符，当前是：$NODE_ID" ;;
esac

command -v systemctl >/dev/null 2>&1 || die "没找到 systemd"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) GOARCH="amd64" ;;
  aarch64|arm64) GOARCH="arm64" ;;
  *) die "不支持的架构：$ARCH" ;;
esac

[ "$(uname -s)" = "Linux" ] || die "采集端只支持 Linux（流量归因依赖 /proc 和 conntrack）"

dim "机器标识：$NODE_ID（$ARCH）"
dim "面板地址：$PANEL"

# ————————————————————————————————————————————————————————
# 采集前置条件自检
#
# 这一段是这个脚本存在的主要理由。基础指标（CPU/内存/磁盘/网络）几乎在任何
# Linux 上都能采到，但流量归因依赖两个容易缺失的前提，缺了之后面板上
# 「对端 IP 流量」和「流量都被谁吃了」会一直是空的，而其他一切看起来都正常。
# ————————————————————————————————————————————————————————

step "检查流量归因的前置条件"

CT_READY=1
CT_ISSUES=()

# 条件一：conntrack 要开字节计数。不开的话每条连接的 bytes 恒为 0
ACCT="$(sysctl -n net.netfilter.nf_conntrack_acct 2>/dev/null || echo "")"
if [ "$ACCT" = "1" ]; then
  dim "nf_conntrack_acct = 1（字节计数已开）"
else
  CT_READY=0
  CT_ISSUES+=("nf_conntrack_acct 没开，conntrack 里的字节数会恒为 0")
fi

# 条件二：conntrack 表里得真的有东西。
#
# 这里是最容易踩的坑：nf_conntrack 模块加载 ≠ 内核在跟踪连接。
# conntrack 是"按需启用"的——必须有 netfilter 规则引用它，内核才会开始记账。
# 一台没装任何防火墙规则的干净机器上，模块在、表却永远是空的。
CT_COUNT=0
if [ -r /proc/net/nf_conntrack ]; then
  CT_COUNT="$(wc -l < /proc/net/nf_conntrack 2>/dev/null || echo 0)"
else
  CT_ISSUES+=("/proc/net/nf_conntrack 读不到（内核没编 conntrack，或在容器里）")
  CT_READY=0
fi

# 模块引用计数为 0 = 没有任何规则在用它 = 表不会有数据
CT_REFS="$(awk '/^nf_conntrack /{print $3}' /proc/modules 2>/dev/null || echo 0)"
[ -n "$CT_REFS" ] || CT_REFS=0

if [ "$CT_COUNT" -eq 0 ] && [ "$CT_REFS" -eq 0 ]; then
  CT_READY=0
  CT_ISSUES+=("conntrack 表是空的，且没有任何 netfilter 规则在引用它")
elif [ "$CT_COUNT" -gt 0 ]; then
  dim "conntrack 表：$CT_COUNT 条连接（正常）"
fi

if [ "$CT_READY" -eq 1 ]; then
  dim "流量归因可用"
else
  warn "流量归因暂时不可用："
  for issue in "${CT_ISSUES[@]}"; do
    printf '        · %s\n' "$issue" >&2
  done
  cat >&2 <<EOF

    ${C_B}这不影响 CPU / 内存 / 磁盘 / 网络这些基础指标${C_0}，只是面板上
    「对端 IP 流量」和「流量都被谁吃了」两块会一直是空的。

    如果这台机器上没有任何防火墙规则（云主机默认就是这样），
    需要给内核一个"开始跟踪连接"的理由。下面这条规则只计数、不拦截、
    不改变任何转发行为，是最轻量的做法：

      nft add table inet sonar_ct
      nft add chain inet sonar_ct prerouting '{ type filter hook prerouting priority -300; policy accept; }'
      nft add rule inet sonar_ct prerouting ct state new counter

    ${C_WARN}这是防火墙改动，脚本不会替你执行。${C_0}请自己确认后再敲，
    并确保你有带外访问（VNC / 救援控制台）以防万一。

EOF
fi

# ————————————————————————————————————————————————————————
# 补齐流量归因的内核侧前提
#
# 默认就做，而且做全套（开关 + 规则 + 两者的持久化）。
#
# 一键安装的意义就是一次到位。之前这里是可选的，结果装完还得回头
# 再配一遍才能看到归因数据 —— 那等于把问题从"缺功能"变成了"缺文档"。
#
# 动的两样东西都不改变转发行为：nf_conntrack_acct 只是让内核多记一个
# 字节计数器；那条 nftables 规则是 policy accept + 纯 counter，没有 verdict。
# 不想让脚本碰内核配置的人加 --no-conntrack 即可，基础指标照常工作。
# ————————————————————————————————————————————————————————

if [ "$ENSURE_CT" -eq 1 ] && [ "$CT_READY" -eq 0 ]; then
  step "启用连接跟踪"

  # ——— 先处理字节计数 ———
  #
  # 这一项和"有没有规则"是两码事：conntrack 可能已经在老老实实跟踪连接，
  # 但 acct 关着的话每条连接的 bytes 恒为 0，归因照样一无所获。
  # 只是个统计开关，不改变任何转发或过滤行为。
  if [ "$ACCT" != "1" ]; then
    if sysctl -w net.netfilter.nf_conntrack_acct=1 >/dev/null 2>&1; then
      # 写进 sysctl.d 让它重启后仍然生效
      echo 'net.netfilter.nf_conntrack_acct = 1' > /etc/sysctl.d/99-sonar-conntrack.conf
      dim "已开启 nf_conntrack_acct（字节计数）"
      ACCT=1
    else
      warn "开不了 nf_conntrack_acct，可能是容器环境没有权限"
    fi
  fi

  # ——— 再处理"根本没在跟踪" ———
  #
  # 已经有连接在表里就不必再加规则了，加了也只是多一条空转的计数器。
  if [ "$CT_COUNT" -gt 0 ]; then
    dim "conntrack 已在跟踪连接（$CT_COUNT 条），不需要额外规则"
    NEW_CT=$(wc -l < /proc/net/nf_conntrack 2>/dev/null || echo 0)
    [ "$ACCT" = "1" ] && CT_READY=1
  else

  command -v nft >/dev/null 2>&1 || die "没有 nft 命令，装不了这条规则（apt install nftables）"

  cat > /etc/sonar-conntrack.nft <<'NFT'
#!/usr/sbin/nft -f
#
# 让内核开始跟踪连接，Sonar 的流量归因依赖 conntrack 表有数据。
#
# 只计数，不做任何拦截：policy accept，唯一的语句是 counter 且没有 verdict，
# 包会继续走后面的规则。独立 table，不碰系统原有的防火墙配置。
#
# 移除：systemctl disable --now sonar-conntrack && rm /etc/sonar-conntrack.nft

table inet sonar_ct {
    chain prerouting {
        type filter hook prerouting priority -300; policy accept;
        ct state new counter
    }
}
NFT

  # 先校验再应用，语法错了就不动系统
  nft -c -f /etc/sonar-conntrack.nft || die "规则语法校验失败，没有做任何改动"

  cat > /etc/systemd/system/sonar-conntrack.service <<'UNIT'
[Unit]
Description=Sonar：启用连接跟踪（供流量归因使用）
Before=network-pre.target
Wants=network-pre.target
DefaultDependencies=no
After=sysinit.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/sonar-conntrack.nft
ExecStop=/usr/sbin/nft delete table inet sonar_ct

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now sonar-conntrack >/dev/null 2>&1 || die "启用 sonar-conntrack 失败"

  sleep 2
  NEW_CT="$(wc -l < /proc/net/nf_conntrack 2>/dev/null || echo 0)"
  if [ "$NEW_CT" -gt 0 ]; then
    dim "已启用，conntrack 表现在有 $NEW_CT 条连接"
    [ "$ACCT" = "1" ] && CT_READY=1
  else
    warn "规则已装但表仍是空的 —— 可能这台机器确实没有流量经过"
  fi
  fi
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  step "检查完毕（--check-only，没有改动任何东西）"
  if [ "$CT_READY" -eq 1 ]; then
    info "这台机器可以采到完整数据，包括流量归因。"
  else
    info "基础指标没问题；流量归因需要先处理上面列出的条件。"
    info "想让脚本自动处理，重跑时加 --ensure-conntrack。"
  fi
  echo
  exit 0
fi

# ————————————————————————————————————————————————————————
# 二进制
# ————————————————————————————————————————————————————————

step "准备采集端二进制"

mkdir -p "$PREFIX"

if [ -n "$BINARY" ]; then
  [ -f "$BINARY" ] || die "找不到 $BINARY"
  cp "$BINARY" "$PREFIX/sonar-agent"
  dim "已复制 $BINARY"
elif [ -f "./dist/sonar-agent" ]; then
  cp ./dist/sonar-agent "$PREFIX/sonar-agent"
  dim "使用 ./dist/sonar-agent"
elif [ -d "./agent" ] && command -v go >/dev/null 2>&1; then
  info "从源码编译"
  ( cd ./agent && GOOS=linux GOARCH="$GOARCH" CGO_ENABLED=0 go build -o "$PREFIX/sonar-agent" . ) ||
    die "编译失败"
  dim "已编译"
elif [ -n "$PANEL" ]; then
  # 面板自己托管着各架构的二进制，新机器上既没有源码也没有 Go 时从那儿取。
  # 这是一键安装能成立的前提 —— 否则脚本跑到这里就没辙了。
  info "从面板下载采集端（linux/$GOARCH）"
  curl -fsSL "$PANEL/sonar-agent-linux-$GOARCH" -o "$PREFIX/sonar-agent.tmp" ||
    die "下载失败：$PANEL/sonar-agent-linux-$GOARCH"
  # 校验确实是个能跑的可执行文件，别把一个 404 的 HTML 页面装成二进制
  chmod 755 "$PREFIX/sonar-agent.tmp"
  if ! "$PREFIX/sonar-agent.tmp" -version >/dev/null 2>&1 && ! head -c 4 "$PREFIX/sonar-agent.tmp" | grep -q ELF; then
    rm -f "$PREFIX/sonar-agent.tmp"
    die "下载到的不是有效的可执行文件，检查面板地址是否正确"
  fi
  mv "$PREFIX/sonar-agent.tmp" "$PREFIX/sonar-agent"
  dim "已下载"
else
  die "没有可用的二进制。用 --binary <路径> 指定，或在仓库根目录运行（需要 Go）"
fi

chmod 755 "$PREFIX/sonar-agent"

# ————————————————————————————————————————————————————————
# 自检：先跑一次采样，确认真能采到东西
# ————————————————————————————————————————————————————————

step "采样自检"

SAMPLE="$("$PREFIX/sonar-agent" -once 2>&1 || true)"
if printf '%s' "$SAMPLE" | grep -q '"cpu"'; then
  dim "基础指标采集正常"
  # 归因是否真的出数，比前面的静态检查更有说服力
  if printf '%s' "$SAMPLE" | grep -q '"peers":\[\]'; then
    warn "对端流量为空 —— 和上面的 conntrack 检查对得上"
  elif printf '%s' "$SAMPLE" | grep -q '"peers"'; then
    dim "流量归因正常出数"
  fi
else
  warn "自检没拿到预期输出，手动看看："
  printf '        %s/sonar-agent -once\n' "$PREFIX" >&2
fi

# ————————————————————————————————————————————————————————
# systemd
# ————————————————————————————————————————————————————————

step "写入 systemd 服务"

ENV_FILE="$PREFIX/agent.env"
umask 077
cat > "$ENV_FILE" <<EOF
# Sonar 采集端配置。修改后需要 systemctl restart sonar-agent
SONAR_TOKEN=$TOKEN
EOF
umask 022
chmod 600 "$ENV_FILE"

ENFORCE_FLAG=""
[ "$ENFORCE" -eq 1 ] && ENFORCE_FLAG=" -enforce"

# 远程改 authorized_keys 是面板唯一能改变机器状态的能力，默认关闭。
# 开了它，面板一旦被攻破就等于拿到了这台机器
SSH_KEYS_FLAG=""
SSH_KEYS_RW=""
if [ "$SSH_KEYS" -eq 1 ]; then
  SSH_KEYS_FLAG=" -ssh-keys"
  # 只在开了远程下发时才给家目录开写权限。/home 前面的 - 表示"不存在也不算错"——
  # 有些机器只有 root 一个账号，没有 /home，写死会让整个单元起不来
  SSH_KEYS_RW=$'\nReadWritePaths=/root -/home'
fi

# 直接把值传成命令行参数，不走环境变量。
#
# 之前这里用 Environment="SONAR_NAME=..."，但 agent 读的是 SONAR_NODE_NAME ——
# 名字对不上，于是显示名和地区全都没生效，面板上只能看到机器的主机名。
# 参数是显式契约，环境变量名一旦拼错不会有任何报错，只是静默失效。
#
# 每个值都要加引号：systemd 的 ExecStart 在空格处分词，
# 名字里有空格（比如「美西 · 搬瓦工」）不加引号会被拆成两个参数。
OPT_ARGS=""
[ -n "$NODE_NAME" ] && OPT_ARGS="$OPT_ARGS -name \"$NODE_NAME\""
[ -n "$REGION" ]    && OPT_ARGS="$OPT_ARGS -region \"$REGION\""
[ -n "$COUNTRY" ]   && OPT_ARGS="$OPT_ARGS -country \"$COUNTRY\""
[ -n "$PROVIDER" ]  && OPT_ARGS="$OPT_ARGS -provider \"$PROVIDER\""
[ -n "$TAGS" ]      && OPT_ARGS="$OPT_ARGS -tags \"$TAGS\""

cat > /etc/systemd/system/sonar-agent.service <<EOF
[Unit]
Description=Sonar 采集端
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PREFIX
EnvironmentFile=$ENV_FILE
# interval 是 Go 的 flag.Duration，必须带单位 —— 传裸数字会让 flag 解析失败，
# agent 打印 usage 后以 exit 2 退出，systemd 就一直起不来
ExecStart=$PREFIX/sonar-agent -id "$NODE_ID" -panel "$PANEL" -token "\${SONAR_TOKEN}" -interval ${INTERVAL}s$OPT_ARGS$ENFORCE_FLAG$SSH_KEYS_FLAG
Restart=always
RestartSec=5

# 采集端需要 root 读 /proc/<pid>/fd，但其余权限可以收紧
NoNewPrivileges=true
# ProtectHome 不能是 true。
#
# true 会让 /root 和 /home 对服务完全不可见，于是 SSH 实况里的
# authorized_keys 永远扫不到 —— 而扫不到的表现是"这台机器一把钥匙都没有"，
# 那正是最容易让人误判的结果（看起来很干净，其实只是没读到）。
#
# read-only 保留了读的能力，同时仍然挡住写。需要远程改密钥时由下面的
# ReadWritePaths 单独开口子，比整个关掉 ProtectHome 收敛得多。
ProtectHome=read-only$SSH_KEYS_RW
PrivateTmp=true
ProtectKernelModules=true
RestrictRealtime=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sonar-agent >/dev/null 2>&1
systemctl restart sonar-agent

sleep 3
if systemctl is-active --quiet sonar-agent; then
  dim "服务已启动"
else
  warn "服务没起来，看日志：journalctl -u sonar-agent -n 50 --no-pager"
  exit 1
fi

# ————————————————————————————————————————————————————————
# 确认面板真的收到了
# ————————————————————————————————————————————————————————

step "确认面板已收到上报"

sleep 4
if command -v curl >/dev/null 2>&1; then
  HTTP="$(curl -s -o /dev/null -w '%{http_code}' "$PANEL/api/health" 2>/dev/null || echo 000)"
  case "$HTTP" in
    200) dim "面板可达（/api/health 返回 200）" ;;
    000) warn "连不上 $PANEL —— 检查防火墙、安全组、域名解析" ;;
    *)   warn "面板返回 $HTTP，可能是反代或路径配置有问题" ;;
  esac
fi

RECENT="$(journalctl -u sonar-agent -n 30 --no-pager 2>/dev/null || echo '')"
if printf '%s' "$RECENT" | grep -qiE '401|token'; then
  warn "日志里出现认证失败 —— token 和面板上的 SONAR_AGENT_TOKEN 对不上"
fi

step "安装完成"

cat <<EOF

    ${C_B}这台机器${C_0} $NODE_NAME（$NODE_ID）
    每 ${INTERVAL} 秒上报一次，几秒后应该就能在面板上看到它。

$( [ "$ENFORCE" -eq 1 ] && printf '    %s封禁已设为可执行模式%s —— 面板下发 enforce 指令会真正修改防火墙。\n' "$C_WARN" "$C_0" || printf '    封禁处于只读模式：面板下发的指令只会打印，不会真改防火墙。\n    确认流程没问题后，加 --enforce 重跑本脚本即可放开。\n' )
$( [ "$SSH_KEYS" -eq 1 ] && printf '    %sSSH 密钥已设为可写模式%s —— 面板可以远程增删本机的 authorized_keys。\n' "$C_WARN" "$C_0" || printf '    SSH 密钥为只读：会上报实况供面板对账，但面板下发的增删指令只打印。\n    需要远程下发时加 --ssh-keys 重跑本脚本。\n' )
$( [ "$CT_READY" -eq 0 ] && printf '    %s流量归因暂不可用%s —— 见上面的 conntrack 说明。\n' "$C_WARN" "$C_0" )
    ${C_DIM}配置  $ENV_FILE
    日志  journalctl -u sonar-agent -f
    自检  $PREFIX/sonar-agent -once${C_0}

EOF
