#!/bin/bash
set -e

PCAP_FILE="/tmp/traffic.pcap"
DNS_LOG="/tmp/dns.log"
CONN_LOG="/tmp/connections.log"
SNI_LOG="/tmp/sni.log"

echo "========================================"
echo "  OPENCODE TRAFFIC ANALYSIS TEST"
echo "========================================"
echo ""

# ── 1. Start packet capture on all interfaces ──
echo "[1/5] Starting packet capture (tcpdump)..."
tcpdump -i any -w "$PCAP_FILE" -U 2>/dev/null &
TCPDUMP_PID=$!
sleep 1

# ── 2. Resolve openrouter.ai to know expected IPs ──
echo "[2/5] Resolving openrouter.ai..."
OPENROUTER_IPS=$(dig +short openrouter.ai A 2>/dev/null | sort)
echo "  OpenRouter IPs: $(echo $OPENROUTER_IPS | tr '\n' ' ')"
echo ""

# ── 3. Run opencode with a simple prompt ──
echo "[3/5] Running opencode (non-interactive mode)..."
echo ""

export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_PURE=1

# Run opencode in non-interactive mode with a simple test prompt
timeout 120 opencode run \
  -m "openrouter/google/gemini-2.0-flash-001" \
  --pure \
  --print-logs \
  --log-level WARN \
  "Say exactly: TRAFFIC_TEST_OK. Nothing else. Do not use any tools." \
  2>/tmp/opencode-stderr.log && echo "  opencode exited successfully" || echo "  opencode exited with code $?"

echo ""

# ── 4. Stop capture and analyze ──
echo "[4/5] Stopping capture and analyzing traffic..."
sleep 2
kill "$TCPDUMP_PID" 2>/dev/null || true
wait "$TCPDUMP_PID" 2>/dev/null || true
sleep 1

# -- DNS queries --
echo ""
echo "========================================="
echo "  DNS QUERIES"
echo "========================================="
if command -v tshark &>/dev/null; then
  tshark -r "$PCAP_FILE" -Y "dns.qr == 0" -T fields -e dns.qry.name 2>/dev/null | sort -u | grep -v '^$' | tee "$DNS_LOG"
else
  echo "  (tshark not available)"
  touch "$DNS_LOG"
fi

# -- Outbound TCP SYN (new connections) --
echo ""
echo "========================================="
echo "  OUTBOUND TCP CONNECTIONS (SYN packets)"
echo "========================================="
if command -v tshark &>/dev/null; then
  tshark -r "$PCAP_FILE" -Y "tcp.flags.syn == 1 && tcp.flags.ack == 0" \
    -T fields -e ip.dst -e tcp.dstport 2>/dev/null | sort -u | \
    grep -vE '^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.|255\.)' | tee "$CONN_LOG"
else
  tcpdump -r "$PCAP_FILE" -n 'tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0' 2>/dev/null | \
    grep -oP '\d+\.\d+\.\d+\.\d+\.\d+' | sort -u | tee "$CONN_LOG"
fi

# -- TLS SNI --
echo ""
echo "========================================="
echo "  TLS SNI (Server Name Indication)"
echo "========================================="
if command -v tshark &>/dev/null; then
  tshark -r "$PCAP_FILE" -Y "tls.handshake.type == 1" \
    -T fields -e tls.handshake.extensions_server_name 2>/dev/null | sort -u | grep -v '^$' | tee "$SNI_LOG"
else
  echo "  (tshark not available)"
  touch "$SNI_LOG"
fi

# -- HTTP/HTTPS Host headers (for non-TLS or h2c) --
echo ""
echo "========================================="
echo "  HTTP HOST HEADERS"
echo "========================================="
if command -v tshark &>/dev/null; then
  tshark -r "$PCAP_FILE" -Y "http.host" \
    -T fields -e http.host 2>/dev/null | sort -u | grep -v '^$' || echo "  (none)"
fi

# ── 5. Verdict ──
echo ""
echo ""
echo "╔════════════════════════════════════════╗"
echo "║            V E R D I C T              ║"
echo "╚════════════════════════════════════════╝"
echo ""

VIOLATIONS=""

# Check DNS for non-openrouter lookups
if [ -f "$DNS_LOG" ] && [ -s "$DNS_LOG" ]; then
  while IFS= read -r domain; do
    [ -z "$domain" ] && continue
    # skip reverse DNS lookups and local
    echo "$domain" | grep -qE '\.in-addr\.arpa$|\.local$' && continue
    if ! echo "$domain" | grep -qiE 'openrouter\.ai$'; then
      VIOLATIONS="${VIOLATIONS}  [DNS]  ${domain}\n"
    fi
  done < "$DNS_LOG"
fi

# Check TLS SNI for non-openrouter hosts
if [ -f "$SNI_LOG" ] && [ -s "$SNI_LOG" ]; then
  while IFS= read -r host; do
    [ -z "$host" ] && continue
    if ! echo "$host" | grep -qiE 'openrouter\.ai$'; then
      VIOLATIONS="${VIOLATIONS}  [TLS]  ${host}\n"
    fi
  done < "$SNI_LOG"
fi

# Check outbound IPs
if [ -f "$CONN_LOG" ] && [ -s "$CONN_LOG" ]; then
  DNS_SERVERS=$(grep nameserver /etc/resolv.conf 2>/dev/null | awk '{print $2}' | sort -u)

  while IFS= read -r line; do
    ip=$(echo "$line" | awk '{print $1}')
    port=$(echo "$line" | awk '{print $2}')
    [ -z "$ip" ] && continue

    IS_ALLOWED=false

    for allowed in $OPENROUTER_IPS; do
      [ "$ip" = "$allowed" ] && IS_ALLOWED=true && break
    done

    # DNS servers (port 53) are expected
    if [ "$port" = "53" ]; then
      IS_ALLOWED=true
    fi

    for dns in $DNS_SERVERS; do
      [ "$ip" = "$dns" ] && IS_ALLOWED=true && break
    done

    if [ "$IS_ALLOWED" = false ]; then
      HOST=$(dig +short -x "$ip" 2>/dev/null | head -1 || echo "unknown")
      VIOLATIONS="${VIOLATIONS}  [TCP]  ${ip}:${port} (${HOST:-unknown})\n"
    fi
  done < "$CONN_LOG"
fi

if [ -z "$VIOLATIONS" ]; then
  echo "  PASS: All network traffic goes ONLY to openrouter.ai"
  echo "        No telemetry, no phone-home, no other connections."
  echo ""
else
  echo "  VIOLATIONS DETECTED:"
  echo "  Connections to non-OpenRouter hosts found:"
  echo ""
  echo -e "$VIOLATIONS"
fi

# Print opencode output
echo ""
echo "========================================="
echo "  OPENCODE STDERR (last 40 lines)"
echo "========================================="
tail -40 /tmp/opencode-stderr.log 2>/dev/null || echo "(empty)"

echo ""
echo "========================================="
echo "  RAW PACKET STATS"
echo "========================================="
TOTAL=$(tcpdump -r "$PCAP_FILE" -q 2>/dev/null | wc -l)
echo "  Total packets captured: $TOTAL"

echo ""
echo "Done."
