#!/bin/bash

# checkSSL.sh - Verify SSL certificates in /etc/nginx/certs directory
# Usage: ./checkSSL.sh [cert-name]
# If cert-name is provided, checks only that certificate
# Otherwise, checks all certificates in the directory

CERT_DIR="${NGINX_CERT_DIR:-/etc/nginx/certs}"

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_certificate() {
    local cert_name=$1
    local cert_file="$CERT_DIR/$cert_name.cert"
    local key_file="$CERT_DIR/$cert_name.key"
    local ca_file="$CERT_DIR/$cert_name.ca"
    local full_file="$CERT_DIR/$cert_name.full.cert"
    
    echo "=== Checking $cert_name ==="
    
    # Check if files exist
    if [ ! -f "$cert_file" ]; then
        echo -e "${RED}✗ Certificate file not found: $cert_file${NC}"
        return 1
    fi
    
    if [ ! -f "$key_file" ]; then
        echo -e "${RED}✗ Private key file not found: $key_file${NC}"
        return 1
    fi
    
    # Verify certificate is valid
    if ! openssl x509 -in "$cert_file" -noout 2>/dev/null; then
        echo -e "${RED}✗ Invalid certificate format${NC}"
        return 1
    fi
    
    # Verify private key is valid
    if ! openssl rsa -in "$key_file" -check -noout 2>/dev/null; then
        echo -e "${RED}✗ Invalid private key format${NC}"
        return 1
    fi
    
    # Check if certificate and key match
    cert_md5=$(openssl x509 -noout -modulus -in "$cert_file" 2>/dev/null | openssl md5)
    key_md5=$(openssl rsa -noout -modulus -in "$key_file" 2>/dev/null | openssl md5)
    
    if [ "$cert_md5" = "$key_md5" ]; then
        echo -e "${GREEN}✓ Certificate and private key match${NC}"
    else
        echo -e "${RED}✗ Certificate and private key DO NOT match!${NC}"
        return 1
    fi
    
    # Check certificate expiry
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
    
    # Show certificate subject and SANs
    subject=$(openssl x509 -in "$cert_file" -noout -subject 2>/dev/null | sed 's/subject=//')
    echo "  Subject: $subject"
    
    sans=$(openssl x509 -in "$cert_file" -noout -ext subjectAltName 2>/dev/null | grep -v "X509v3 Subject Alternative Name" | tr -d ' ')
    if [ -n "$sans" ]; then
        echo "  SANs: $sans"
    fi
    
    # Verify certificate chain if CA file exists
    if [ -f "$ca_file" ]; then
        if openssl verify -CAfile "$ca_file" "$cert_file" >/dev/null 2>&1; then
            echo -e "${GREEN}✓ Certificate chain is valid${NC}"
        else
            echo -e "${YELLOW}⚠ Certificate chain verification failed (this may be expected for some setups)${NC}"
        fi
    fi
    
    # Verify full chain file if it exists
    if [ -f "$full_file" ]; then
        if openssl x509 -in "$full_file" -noout 2>/dev/null; then
            echo -e "${GREEN}✓ Full chain file is valid${NC}"
        else
            echo -e "${RED}✗ Full chain file is invalid${NC}"
            return 1
        fi
    fi
    
    echo ""
    return 0
}

# Main logic
if [ $# -eq 1 ]; then
    # Check specific certificate
    check_certificate "$1"
    exit $?
else
    # Check all certificates in directory
    if [ ! -d "$CERT_DIR" ]; then
        echo -e "${RED}Certificate directory not found: $CERT_DIR${NC}"
        exit 1
    fi
    
    echo "Checking all certificates in $CERT_DIR"
    echo ""
    
    total=0
    passed=0
    failed=0
    
    # Find all .cert files and extract base names
    for cert_file in "$CERT_DIR"/*.cert; do
        if [ -f "$cert_file" ]; then
            cert_name=$(basename "$cert_file" .cert)
            # Skip full.cert files
            if [[ "$cert_name" != *.full ]]; then
                total=$((total + 1))
                if check_certificate "$cert_name"; then
                    passed=$((passed + 1))
                else
                    failed=$((failed + 1))
                fi
            fi
        fi
    done
    
    if [ $total -eq 0 ]; then
        echo -e "${YELLOW}No certificates found in $CERT_DIR${NC}"
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
