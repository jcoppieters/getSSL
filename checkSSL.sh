#!/bin/bash

# checkSSL.sh - Verify SSL certificates from Combell (getSSL) and Let's Encrypt (certbot)
# Usage: ./checkSSL.sh [cert-name]
# If cert-name is provided, checks only that certificate (by Combell name or Let's Encrypt domain)
# Otherwise, checks all certificates found in both locations

CERT_DIR="${NGINX_CERT_DIR:-/etc/nginx/certs}"
LETSENCRYPT_DIR="${LETSENCRYPT_DIR:-/etc/letsencrypt/live}"
SITES_DIR="${NGINX_SITES_ENABLED_DIR:-/etc/nginx/sites-enabled}"

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_certificate_usage() {
    local key_file=$1
    local full_file=$2

    if [ ! -d "$SITES_DIR" ]; then
        return
    fi

    # Search for references to this certificate in nginx configs
    local cert_patterns=(
        "$(basename "$key_file")"
        "$(basename "$full_file")"
    )

    local found_in=""
    for pattern in "${cert_patterns[@]}"; do
        while IFS= read -r line; do
            local file=$(echo "$line" | cut -d: -f1)
            if [ -n "$file" ] && [[ ! "$found_in" =~ "$file" ]]; then
                found_in+="$file "
            fi
        done < <(grep -r "$pattern" "$SITES_DIR" 2>/dev/null)
    done

    if [ -n "$found_in" ]; then
        echo -e "${YELLOW}⚠️  WARNING: This certificate is currently in use!${NC}"
        echo -e "${YELLOW}   Found in nginx config files:${NC}"
        for file in $found_in; do
            echo -e "${YELLOW}   - $file${NC}"
        done
        echo ""
    fi
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
            expiry=$(openssl x509 -in "$full_file" -noout -enddate 2>/dev/null | cut -d= -f2)
            expiry_timestamp=$(date -d "$expiry" +%s 2>/dev/null || date -j -f "%b %d %H:%M:%S %Y %Z" "$expiry" +%s 2>/dev/null)
            current_timestamp=$(date +%s)
            days_until_expiry=$(( ($expiry_timestamp - $current_timestamp) / 86400 ))

            if [ $days_until_expiry -lt 0 ]; then
                echo -e "${RED}✗ Certificate EXPIRED on: $expiry${NC}"
                check_failed=1
            elif [ $days_until_expiry -lt 30 ]; then
                echo -e "${YELLOW}⚠ Certificate expires soon: $expiry ($days_until_expiry days)${NC}"
            else
                echo -e "${GREEN}✓ Certificate valid until: $expiry ($days_until_expiry days)${NC}"
            fi
        fi

        # Show certificate subject, SANs and issuer
        if [ $check_failed -eq 0 ]; then
            subject=$(openssl x509 -in "$full_file" -noout -subject 2>/dev/null | sed 's/subject=//')
            echo "  Subject: $subject"

            sans=$(openssl x509 -in "$full_file" -noout -ext subjectAltName 2>/dev/null | grep -v "X509v3 Subject Alternative Name" | tr -d ' ')
            if [ -n "$sans" ]; then
                echo "  SANs: $sans"
            fi

            issuer=$(openssl x509 -in "$full_file" -noout -issuer 2>/dev/null | sed 's/issuer=//')
            echo "  Issuer: $issuer"
            if echo "$issuer" | grep -qi "Let's Encrypt\|ISRG"; then
                echo -e "  Source: ${GREEN}Let's Encrypt (self-generated)${NC}"
            else
                echo -e "  Source: ${GREEN}Combell${NC}"
            fi
        fi
    fi

    # If any check failed, see if this certificate is in use
    if [ $check_failed -eq 1 ]; then
        check_certificate_usage "$key_file" "$full_file"
    fi

    echo ""
    return $check_failed
}

# Main logic
if [ $# -eq 1 ]; then
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

    echo "================================"
    echo "Summary: $total certificate(s) checked"
    echo -e "${GREEN}Passed: $passed${NC}"
    if [ $failed -gt 0 ]; then
        echo -e "${RED}Failed: $failed${NC}"
        exit 1
    else
        echo -e "${GREEN}All certificates are valid!${NC}"
        echo ""
        echo "You can now safely restart nginx:"
        echo "  sudo systemctl restart nginx"
        echo "or"
        echo "  sudo service nginx restart"
        exit 0
    fi
fi
