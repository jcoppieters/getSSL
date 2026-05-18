#!/bin/bash

# checkSSL.sh - Verify SSL certificates in /etc/nginx/certs directory
# Usage: ./checkSSL.sh [cert-name]
# If cert-name is provided, checks only that certificate
# Otherwise, checks all certificates in the directory

CERT_DIR="${NGINX_CERT_DIR:-/etc/nginx/certs}"
SITES_DIR="${NGINX_SITES_ENABLED_DIR:-/etc/nginx/sites-enabled}"

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_certificate_usage() {
    local cert_name=$1
    
    if [ ! -d "$SITES_DIR" ]; then
        return
    fi
    
    # Search for references to this certificate in nginx configs
    local cert_patterns=(
        "$cert_name.cert"
        "$cert_name.key"
        "$cert_name.ca"
        "$cert_name.full.cert"
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

check_certificate() {
    local cert_name=$1
    local cert_file="$CERT_DIR/$cert_name.cert"
    local key_file="$CERT_DIR/$cert_name.key"
    local ca_file="$CERT_DIR/$cert_name.ca"
    local full_file="$CERT_DIR/$cert_name.full.cert"
    local check_failed=0
    
    echo "=== Checking $cert_name ==="
    
    # Check if files exist
    if [ ! -f "$cert_file" ]; then
        echo -e "${RED}✗ Certificate file not found: $cert_file${NC}"
        check_failed=1
    fi
    
    if [ ! -f "$key_file" ]; then
        echo -e "${RED}✗ Private key file not found: $key_file${NC}"
        check_failed=1
    fi
    
    # Only continue checks if files exist
    if [ $check_failed -eq 0 ]; then
        # Verify certificate is valid
        if ! openssl x509 -in "$cert_file" -noout 2>/dev/null; then
            echo -e "${RED}✗ Invalid certificate format${NC}"
            check_failed=1
        fi
        
        # Verify private key is valid
        if ! openssl rsa -in "$key_file" -check -noout 2>/dev/null; then
            echo -e "${RED}✗ Invalid private key format${NC}"
            check_failed=1
        fi
        
        # Check if certificate and key match
        if [ $check_failed -eq 0 ]; then
            cert_md5=$(openssl x509 -noout -modulus -in "$cert_file" 2>/dev/null | openssl md5)
            key_md5=$(openssl rsa -noout -modulus -in "$key_file" 2>/dev/null | openssl md5)
            
            if [ "$cert_md5" = "$key_md5" ]; then
                echo -e "${GREEN}✓ Certificate and private key match${NC}"
            else
                echo -e "${RED}✗ Certificate and private key DO NOT match!${NC}"
                check_failed=1
            fi
        fi
        
        # Check certificate expiry
        if [ $check_failed -eq 0 ]; then
            expiry=$(openssl x509 -in "$cert_file" -noout -enddate 2>/dev/null | cut -d= -f2)
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
        
        # Show certificate subject and SANs
        if [ $check_failed -eq 0 ]; then
            subject=$(openssl x509 -in "$cert_file" -noout -subject 2>/dev/null | sed 's/subject=//')
            echo "  Subject: $subject"
            
            sans=$(openssl x509 -in "$cert_file" -noout -ext subjectAltName 2>/dev/null | grep -v "X509v3 Subject Alternative Name" | tr -d ' ')
            if [ -n "$sans" ]; then
                echo "  SANs: $sans"
            fi
        fi
        
        # Verify certificate chain if CA file exists
        if [ -f "$ca_file" ] && [ $check_failed -eq 0 ]; then
            if openssl verify -CAfile "$ca_file" "$cert_file" >/dev/null 2>&1; then
                echo -e "${GREEN}✓ Certificate chain is valid${NC}"
            else
                echo -e "${YELLOW}⚠ Certificate chain verification failed (this may be expected for some setups)${NC}"
            fi
        fi
        
        # Verify full chain file if it exists
        if [ -f "$full_file" ] && [ $check_failed -eq 0 ]; then
            if openssl x509 -in "$full_file" -noout 2>/dev/null; then
                echo -e "${GREEN}✓ Full chain file is valid${NC}"
            else
                echo -e "${RED}✗ Full chain file is invalid${NC}"
                check_failed=1
            fi
        fi
    fi
    
    # If any check failed, see if this certificate is in use
    if [ $check_failed -eq 1 ]; then
        check_certificate_usage "$cert_name"
    fi
    
    echo ""
    return $check_failed
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
