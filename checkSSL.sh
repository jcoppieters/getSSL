#!/bin/bash

# checkSSL.sh - Verify SSL certificates from Combell (getSSL) and Let's Encrypt (certbot)
#
# Usage:
#   ./checkSSL.sh                   Check all certificate FILES on disk
#   ./checkSSL.sh <cert-name>       Check one certificate file
#   ./checkSSL.sh --live            Check what nginx actually SERVES for every server_name
#   ./checkSSL.sh --live <host>...  Check what is served for specific hostnames
#
# The file checks tell you whether the certificate on disk is sound. The live
# checks open a real TLS connection and verify what a browser actually receives:
# the right certificate for that hostname, not expired, and a trusted chain.
#
# Those two can disagree. A perfect file is useless if its server block has no
# "listen 443 ssl" - nginx then quietly serves the DEFAULT server's certificate
# for that hostname instead, and visitors get a name-mismatch warning while
# every file on disk still looks fine. Only --live catches that.

CERT_DIR="${NGINX_CERT_DIR:-/etc/nginx/certs}"
LETSENCRYPT_DIR="${LETSENCRYPT_DIR:-/etc/letsencrypt/live}"
SITES_DIR="${NGINX_SITES_ENABLED_DIR:-/etc/nginx/sites-enabled}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/nginx.conf}"
LIVE_PORT="${LIVE_PORT:-443}"
LIVE_TIMEOUT="${LIVE_TIMEOUT:-10}"

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# fetch_sclient <hostname>
# Prints the raw `openssl s_client` output for a host, or nothing on failure.
# A filtered port would otherwise block forever (openssl has no connect
# timeout of its own), so the call is always bounded: timeout(1) when present,
# and a kill-the-child fallback for platforms without it, such as macOS.
fetch_sclient() {
    local host=$1

    if command -v timeout >/dev/null 2>&1; then
        echo | timeout "$LIVE_TIMEOUT" openssl s_client -servername "$host" \
                   -connect "$host:$LIVE_PORT" 2>/dev/null
        return
    fi

    local tmp_out
    tmp_out=$(mktemp) || return
    echo | openssl s_client -servername "$host" -connect "$host:$LIVE_PORT" \
        >"$tmp_out" 2>/dev/null &
    local pid=$!
    ( sleep "$LIVE_TIMEOUT"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
    local watcher=$!
    wait "$pid" 2>/dev/null
    kill -9 "$watcher" 2>/dev/null
    wait "$watcher" 2>/dev/null
    cat "$tmp_out"
    rm -f "$tmp_out"
}

# cert_names <cert_file>
# Prints every hostname the certificate claims: the subject CN plus all DNS
# SANs, deduplicated (the CN is normally repeated as a SAN).
cert_names() {
    local cert_file=$1
    {
        openssl x509 -in "$cert_file" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *//p'
        openssl x509 -in "$cert_file" -noout -ext subjectAltName 2>/dev/null \
            | grep -o 'DNS:[^,]*' | sed 's/DNS://' | tr -d ' '
    } | awk 'NF && !seen[$0]++'
}

# host_matches_cert <hostname> <names...>
# Returns 0 if the hostname is covered, honouring wildcards the way browsers do:
# *.example.com matches one label (a.example.com) but not a.b.example.com.
host_matches_cert() {
    local host=$1
    shift
    local name
    for name in "$@"; do
        [ -z "$name" ] && continue
        if [ "$name" = "$host" ]; then
            return 0
        fi
        case "$name" in
            \*.*)
                local suffix="${name#\*}"
                local host_parent=".${host#*.}"
                if [ "$host_parent" = "$suffix" ] && [ "$host" != "${host#*.}" ]; then
                    return 0
                fi
                ;;
        esac
    done
    return 1
}

# report_expiry <cert_file>
# Prints the expiry line, colour-coded. Returns 1 when the certificate expired.
report_expiry() {
    local cert_file=$1
    local expiry expiry_timestamp current_timestamp days_until_expiry

    expiry=$(openssl x509 -in "$cert_file" -noout -enddate 2>/dev/null | cut -d= -f2)
    expiry_timestamp=$(date -d "$expiry" +%s 2>/dev/null || date -j -f "%b %d %H:%M:%S %Y %Z" "$expiry" +%s 2>/dev/null)
    current_timestamp=$(date +%s)
    days_until_expiry=$(( ($expiry_timestamp - $current_timestamp) / 86400 ))

    if [ $days_until_expiry -lt 0 ]; then
        echo -e "${RED}✗ Certificate EXPIRED on: $expiry${NC}"
        return 1
    elif [ $days_until_expiry -lt 30 ]; then
        echo -e "${YELLOW}⚠ Certificate expires soon: $expiry ($days_until_expiry days)${NC}"
    else
        echo -e "${GREEN}✓ Certificate valid until: $expiry ($days_until_expiry days)${NC}"
    fi
    return 0
}

# report_identity <cert_file>
# Prints subject, SANs, issuer and which CA the certificate came from.
report_identity() {
    local cert_file=$1
    local subject sans issuer

    subject=$(openssl x509 -in "$cert_file" -noout -subject 2>/dev/null | sed 's/subject=//')
    echo "  Subject: $subject"

    sans=$(openssl x509 -in "$cert_file" -noout -ext subjectAltName 2>/dev/null | grep -v "X509v3 Subject Alternative Name" | tr -d ' ')
    if [ -n "$sans" ]; then
        echo "  SANs: $sans"
    fi

    issuer=$(openssl x509 -in "$cert_file" -noout -issuer 2>/dev/null | sed 's/issuer=//')
    echo "  Issuer: $issuer"
    if echo "$issuer" | grep -qi "Let's Encrypt\|ISRG"; then
        echo -e "  Source: ${GREEN}Let's Encrypt (self-generated)${NC}"
    else
        echo -e "  Source: ${GREEN}Combell${NC}"
    fi
}

# find_certificate_usage <key_file> <full_file>
# Prints the (space-separated) list of active nginx config files that
# reference this certificate, or nothing if none found. Matches on the
# full file path, not just the basename - Let's Encrypt certs all share
# the same basenames (privkey.pem/fullchain.pem), so only the full path
# uniquely identifies which domain's certificate is referenced. Backup
# config files (containing ".bak") are ignored since they aren't active.
find_certificate_usage() {
    local key_file=$1
    local full_file=$2

    if [ ! -d "$SITES_DIR" ]; then
        return
    fi

    local found_in=""
    for pattern in "$key_file" "$full_file"; do
        while IFS= read -r file; do
            if [ -n "$file" ] && [[ "$found_in" != *"$file "* ]]; then
                found_in+="$file "
            fi
        done < <(grep -rlF -- "$pattern" "$SITES_DIR" 2>/dev/null | grep -v '\.bak')
    done

    echo "$found_in"
}

# sites_include_glob
# The filename pattern nginx actually loads from SITES_DIR. Some setups include
# "*.conf" and others plain "*", which decides whether a file like "site.bak" or
# "example.be" is live config or just sitting there. Reading the wrong set would
# report hostnames nginx never answers for.
sites_include_glob() {
    local pattern
    pattern=$(grep -hE '^[[:space:]]*include[[:space:]]+[^#]*sites-enabled' "$NGINX_CONF" 2>/dev/null \
        | head -1)
    pattern=${pattern##*sites-enabled/}
    pattern=${pattern%%;*}
    pattern=$(echo "$pattern" | tr -d ' \t')
    echo "${pattern:-*}"
}

# collect_server_names
# Every hostname nginx is configured to answer for, from the active configs.
# Skips backups, commented-out lines, the catch-all "_" and wildcard names
# (those cannot be connected to directly).
collect_server_names() {
    [ -d "$SITES_DIR" ] || return

    local glob
    glob=$(sites_include_glob)

    local f
    for f in "$SITES_DIR"/$glob; do
        case "$(basename "$f")" in *.bak*) continue;; esac
        [ -f "$f" ] || continue
        grep -h 'server_name' "$f" 2>/dev/null \
            | sed 's/#.*//' \
            | grep 'server_name' \
            | sed 's/.*server_name//' \
            | tr -d ';'
    done | tr ' \t' '\n\n' \
         | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
         | grep -v '^$' \
         | grep -v '^_$' \
         | grep -v '[*]' \
         | sort -u
}

# check_live_certificate <hostname>
# Opens a real TLS connection and checks what is actually served.
check_live_certificate() {
    local host=$1
    local check_failed=0
    local tmp_cert

    echo "=== Live check: $host:$LIVE_PORT ==="

    local sclient
    sclient=$(fetch_sclient "$host")

    if ! echo "$sclient" | grep -q "BEGIN CERTIFICATE"; then
        echo -e "${RED}✗ No certificate received - connection failed, port closed, or not speaking TLS${NC}"
        echo ""
        return 1
    fi

    tmp_cert=$(mktemp) || return 1
    echo "$sclient" | openssl x509 2>/dev/null > "$tmp_cert"

    # 1. Is the chain trusted? (this is what the browser padlock depends on)
    local verify
    verify=$(echo "$sclient" | grep "Verify return code:" | tail -1 | sed 's/.*Verify return code: //')
    if [ "${verify%% *}" = "0" ]; then
        echo -e "${GREEN}✓ Chain trusted ($verify)${NC}"
    else
        echo -e "${RED}✗ Chain NOT trusted: $verify${NC}"
        check_failed=1
    fi

    # 2. Is this the RIGHT certificate for this hostname?
    local names
    IFS=$'\n' read -r -d '' -a names < <(cert_names "$tmp_cert" && printf '\0')
    if host_matches_cert "$host" "${names[@]}"; then
        echo -e "${GREEN}✓ Certificate covers $host${NC}"
    else
        echo -e "${RED}✗ WRONG certificate - it does not cover $host${NC}"
        echo -e "${RED}   served certificate is for: ${names[*]}${NC}"
        echo -e "${YELLOW}   (typically a server block without \"listen 443 ssl\", so nginx${NC}"
        echo -e "${YELLOW}    falls back to the default server's certificate)${NC}"
        check_failed=1
    fi

    # 3. Is it still valid?
    report_expiry "$tmp_cert" || check_failed=1

    report_identity "$tmp_cert"

    rm -f "$tmp_cert"
    echo ""
    return $check_failed
}

# check_certificate <label> <key_file> <full_file>
check_certificate() {
    local label=$1
    local key_file=$2
    local full_file=$3
    local check_failed=0

    echo "=== Checking $label ==="

    # Check if files exist
    if [ ! -f "$full_file" ]; then
        echo -e "${RED}✗ Certificate file not found: $full_file${NC}"
        check_failed=1
    fi

    if [ ! -f "$key_file" ]; then
        echo -e "${RED}✗ Private key file not found: $key_file${NC}"
        check_failed=1
    fi

    # Only continue checks if files exist
    if [ $check_failed -eq 0 ]; then
        # Verify certificate is valid
        if ! openssl x509 -in "$full_file" -noout 2>/dev/null; then
            echo -e "${RED}✗ Invalid certificate format${NC}"
            check_failed=1
        fi

        # Verify private key is valid (works for RSA, EC, etc.)
        if ! openssl pkey -in "$key_file" -noout 2>/dev/null; then
            echo -e "${RED}✗ Invalid private key format${NC}"
            check_failed=1
        fi

        # Check if certificate and key match by comparing public keys
        # (modulus comparison only works for RSA; pubkey comparison works for RSA and EC)
        if [ $check_failed -eq 0 ]; then
            cert_md5=$(openssl x509 -in "$full_file" -noout -pubkey 2>/dev/null | openssl md5)
            key_md5=$(openssl pkey -in "$key_file" -pubout 2>/dev/null | openssl md5)

            if [ "$cert_md5" = "$key_md5" ]; then
                echo -e "${GREEN}✓ Certificate and private key match${NC}"
            else
                echo -e "${RED}✗ Certificate and private key DO NOT match!${NC}"
                check_failed=1
            fi
        fi

        # Check certificate expiry
        if [ $check_failed -eq 0 ]; then
            report_expiry "$full_file" || check_failed=1
        fi

        # Show certificate subject, SANs and issuer
        if [ $check_failed -eq 0 ]; then
            report_identity "$full_file"
        fi
    fi

    # Show which active nginx configs (if any) actually reference this certificate
    where_used=$(find_certificate_usage "$key_file" "$full_file")
    if [ -n "$where_used" ]; then
        if [ $check_failed -eq 1 ]; then
            echo -e "${YELLOW}⚠️  WARNING: This certificate is currently in use!${NC}"
        fi
        echo "  Where used:"
        for file in $where_used; do
            echo "    - $file"
        done
    else
        echo -e "  Where used: ${YELLOW}(not referenced in any active nginx config)${NC}"
    fi

    echo ""
    return $check_failed
}

print_summary() {
    local total=$1 passed=$2 failed=$3

    echo "================================"
    echo "Summary: $total check(s)"
    echo -e "${GREEN}Passed: $passed${NC}"
    if [ $failed -gt 0 ]; then
        echo -e "${RED}Failed: $failed${NC}"
        return 1
    fi
    echo -e "${GREEN}All checks passed!${NC}"
    return 0
}

# Main logic
if [ "$1" = "--live" ]; then
    shift

    hosts=("$@")
    if [ ${#hosts[@]} -eq 0 ]; then
        echo "Live-checking every server_name found in $SITES_DIR"
        echo ""
        IFS=$'\n' read -r -d '' -a hosts < <(collect_server_names && printf '\0')
    fi

    if [ ${#hosts[@]} -eq 0 ]; then
        echo -e "${YELLOW}No hostnames to check${NC}"
        exit 0
    fi

    total=0
    passed=0
    failed=0
    failed_hosts=""

    for host in "${hosts[@]}"; do
        total=$((total + 1))
        if check_live_certificate "$host"; then
            passed=$((passed + 1))
        else
            failed=$((failed + 1))
            failed_hosts+="    - $host\n"
        fi
    done

    if [ $failed -gt 0 ]; then
        echo "Hostnames serving a bad certificate:"
        echo -ne "${RED}$failed_hosts${NC}"
        echo ""
    fi

    print_summary $total $passed $failed
    exit $?

elif [ $# -eq 1 ]; then
    # Check a specific certificate - try Combell naming first, then Let's Encrypt
    cert_name=$1
    combell_key="$CERT_DIR/$cert_name.key"
    combell_full="$CERT_DIR/$cert_name.full.cert"
    le_key="$LETSENCRYPT_DIR/$cert_name/privkey.pem"
    le_full="$LETSENCRYPT_DIR/$cert_name/fullchain.pem"

    if [ -f "$combell_full" ] || [ -f "$combell_key" ]; then
        check_certificate "$cert_name" "$combell_key" "$combell_full"
        exit $?
    elif [ -f "$le_full" ] || [ -f "$le_key" ]; then
        check_certificate "$cert_name" "$le_key" "$le_full"
        exit $?
    else
        echo -e "${RED}Certificate '$cert_name' not found in $CERT_DIR or $LETSENCRYPT_DIR${NC}"
        exit 1
    fi
else
    # Check all certificates: Combell (getSSL) + Let's Encrypt (certbot)
    total=0
    passed=0
    failed=0

    if [ -d "$CERT_DIR" ]; then
        echo "Checking Combell certificates in $CERT_DIR"
        echo ""

        for cert_file in "$CERT_DIR"/*.full.cert; do
            if [ -f "$cert_file" ]; then
                cert_name=$(basename "$cert_file" .full.cert)
                total=$((total + 1))
                if check_certificate "$cert_name" "$CERT_DIR/$cert_name.key" "$cert_file"; then
                    passed=$((passed + 1))
                else
                    failed=$((failed + 1))
                fi
            fi
        done
    fi

    if [ -d "$LETSENCRYPT_DIR" ]; then
        echo "Checking Let's Encrypt certificates in $LETSENCRYPT_DIR"
        echo ""

        for domain_dir in "$LETSENCRYPT_DIR"/*/; do
            domain_dir="${domain_dir%/}"
            fullchain="$domain_dir/fullchain.pem"
            if [ -f "$fullchain" ]; then
                domain_name=$(basename "$domain_dir")
                total=$((total + 1))
                if check_certificate "$domain_name" "$domain_dir/privkey.pem" "$fullchain"; then
                    passed=$((passed + 1))
                else
                    failed=$((failed + 1))
                fi
            fi
        done
    fi

    if [ $total -eq 0 ]; then
        echo -e "${YELLOW}No certificates found in $CERT_DIR or $LETSENCRYPT_DIR${NC}"
        exit 0
    fi

    if print_summary $total $passed $failed; then
        echo ""
        echo "Files on disk are fine. To check what nginx actually serves:"
        echo "  $0 --live"
        exit 0
    fi
    exit 1
fi
