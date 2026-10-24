# getSSL - Combell SSL Certificate Automation

A TypeScript tool to automatically fetch, install, and manage SSL certificates from Combell's API for nginx.

## Features

- ✅ Fetches SSL certificates from Combell API
- ✅ Checks if certificate is newer before installing
- ✅ Installs certificate, private key, and certificate chain
- ✅ Includes verification script to validate certificates before deployment
- ✅ Can be run from crontab for automated certificate renewal

## Prerequisites

- Node.js 18+ and npm
- Access to Combell API (API key and secret)
- **IP address whitelisted** in your Combell control panel (required!)
- nginx installed and configured
- Sufficient permissions to write to nginx directories (usually requires root/sudo)

## Important Combell API Notes

⚠️ **Authentication**: The Combell API uses HMAC (Hash-based Message Authentication Code), not simple API keys  
⚠️ **IP Whitelisting**: You **must** whitelist your server's IP address in the Combell control panel under API settings  
✅ **Certificate Download**: SSL certificates are downloaded as PFX (PKCS#12) files and automatically converted to nginx-compatible formats

## Installation

1. **Whitelist your IP** in Combell control panel:
   - Log in to your Combell account
   - Go to API settings
   - Add your server's IP address to the whitelist

2. Clone or download this repository:
   ```bash
   cd /etc/nodejs
   git clone <repository-url> getSSL
   cd getSSL
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Build the TypeScript code:
   ```bash
   npm run build
   ```

5. Create a `.env` file with your Combell API credentials:
   ```bash
   cp .env.example .env
   vi .env
   ```

   Add your credentials:
   ```
   COMBELL_API_KEY=your_actual_api_key
   COMBELL_API_SECRET=your_actual_api_secret
   PFX_PASSWORD=your_secure_password
   ```

   **Note**: The `PFX_PASSWORD` is used to encrypt/decrypt the certificate file when downloading from Combell. Choose a strong password and keep it secure.

6. (Optional) Install globally or create a symlink:
   ```bash
   npm link
   # or
   ln -s /opt/getSSL/dist/index.js /usr/local/bin/getSSL
   chmod +x /opt/getSSL/dist/index.js
   ```

## Usage

### Command Syntax

```bash
getSSL [--test] <domain-name> [certificate-name]
```

**Parameters:**
- `--test` (optional): Run in test mode without making changes
- `<domain-name>` (required): The domain name as registered in Combell (e.g., `de-essen.be`)
- `[certificate-name]` (optional): Custom name for certificate files (e.g., `essen`)
  - If omitted, uses the domain name
  - If provided, creates shorter file names (e.g., `essen.cert` instead of `de-essen.be.cert`)

### Test Mode (Dry Run)

Test the tool without making any changes - perfect for development and testing on macOS:

```bash
# Using npm
npm start -- --test de-essen.be

# With custom certificate name
npm start -- --test de-essen.be essen

# Using npm run dev
npm run dev -- --test de-essen.be

# If installed globally
getSSL --test de-essen.be

# With custom certificate name
getSSL --test rooigemhuisartsenpraktijk.be rooigem
```

Test mode will:
- ✅ Fetch the certificate from Combell API
- ✅ Display certificate details (valid from/to dates)
- ✅ Show what files would be created
- ✅ Preview certificate content
- ❌ Not write any files
- ❌ Not test nginx configuration
- ❌ Not restart nginx

### Manual Run

```bash
# Using npm (certificate files will use domain name)
npm start de-essen.be

# Using npm with custom certificate name
npm start rooigemhuisartsenpraktijk.be rooigem

# Using npm with test mode
npm start -- --test de-essen.be

# If installed globally or symlinked
getSSL de-essen.be

# With custom certificate name
getSSL rooigemhuisartsenpraktijk.be rooigem

# Test mode
getSSL --test de-essen.be

# With sudo (required for nginx operations in production)
sudo -E npm start de-essen.be
# or
sudo getSSL rooigemhuisartsenpraktijk.be rooigem
```

**Custom Certificate Names:**

If your nginx configuration uses shorter certificate names (e.g., `rooigem.crt` instead of `rooigemhuisartsenpraktijk.be.crt`), you can specify the certificate file base name as a second parameter:

```bash
getSSL rooigemhuisartsenpraktijk.be rooigem
```

This will:
- Look up the certificate for `rooigemhuisartsenpraktijk.be` in Combell
- Save the files as `rooigem.cert`, `rooigem.key`, `rooigem.ca`, `rooigem.full.cert`

### Running from Crontab

To automatically check and update SSL certificates daily:

1. Edit root's crontab:
   ```bash
   sudo crontab -e
   ```

2. Add a cron job (example: run daily at 3:00 AM):
   ```cron
   # Check SSL certificate for de-essen.be daily at 3:00 AM
   0 3 * * * cd /opt/getSSL && /usr/bin/node dist/index.js de-essen.be >> /var/log/getSSL.log 2>&1
   ```

   Or if you have multiple sites:
   ```cron
   # Check SSL certificates daily at 3:00 AM
   0 3 * * * cd /opt/getSSL && /usr/bin/node dist/index.js de-essen.be >> /var/log/getSSL-de-essen.log 2>&1
   0 3 * * * cd /opt/getSSL && /usr/bin/node dist/index.js rooigemhuisartsenpraktijk.be rooigem >> /var/log/getSSL-rooigem.log 2>&1
   0 3 * * * cd /opt/getSSL && /usr/bin/node dist/index.js example.com >> /var/log/getSSL-example.log 2>&1
   ```

   **Note:** The second parameter (e.g., `rooigem`) is the base name for certificate files if your nginx config uses shorter names than the full domain.

3. Make sure the `.env` file is readable by root:
   ```bash
   sudo chmod 600 /opt/getSSL/.env
   sudo chown root:root /opt/getSSL/.env
   ```

## Configuration

### Environment Variables

- `COMBELL_API_KEY` (required): Your Combell API key
- `COMBELL_API_SECRET` (required): Your Combell API secret
- `PFX_PASSWORD` (required for production): Password used to encrypt/decrypt PFX certificate files. Not required in test mode.
- `NGINX_SITES_ENABLED_DIR` (optional): Override nginx sites-enabled directory (default: `/etc/nginx/sites-enabled`)
- `NGINX_CERT_DIR` (optional): Override certificate storage directory (default: `/etc/nginx/certs`)
  - Common alternative: `/etc/nginx/ssl`

### Certificate Files

The tool creates the following files (default: `/etc/nginx/certs/`, configurable via `NGINX_CERT_DIR`):

- `{certname}.key` - The private key
- `{certname}.full.cert` - Full certificate chain (certificate + CA chain)

Where `{certname}` is:
- The domain name (e.g., `de-essen.be`) if no custom name is specified
- The custom certificate name (e.g., `essen`) if provided as the second parameter

**Examples:**
```bash
# Creates: de-essen.be.key, de-essen.be.full.cert
getSSL de-essen.be

# Creates: essen.key, essen.full.cert
getSSL de-essen.be essen
```

### Nginx Configuration Example

```nginx
server {
    listen 443 ssl http2;
    server_name de-essen.be www.de-essen.be;

    ssl_certificate /etc/nginx/certs/essen.full.cert;
    ssl_certificate_key /etc/nginx/certs/essen.key;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384;

    # ... rest of your configuration
}
```

## How It Works

1. **Fetch**: Connects to Combell API and retrieves the SSL certificate list for your account
2. **Match**: Finds the certificate matching the specified domain name (selects newest if multiple exist)
3. **Compare**: Checks if the certificate is different from the currently installed one
4. **Download**: Downloads the certificate as a PFX file using your PFX_PASSWORD
5. **Convert**: Uses OpenSSL to extract the certificate, private key, and chain from the PFX file
6. **Install**: Writes the certificate files to `/etc/nginx/certs/`
7. **Test**: Runs `nginx -t` to verify configuration is still valid
8. **Output**: Displays instructions to verify and restart nginx manually

## Verifying Certificates

After installing certificates, use the included `checkSSL.sh` script to verify everything is correct before restarting nginx.

The script checks **both** sources of certificates on a server:
- Combell certificates installed by `getSSL` (in `NGINX_CERT_DIR`, as `{name}.key` / `{name}.full.cert`)
- Self-generated Let's Encrypt certificates from certbot (in `LETSENCRYPT_DIR`, as `{domain}/privkey.pem` / `{domain}/fullchain.pem`)

Each certificate's **Issuer** is shown so you can see at a glance which ones come from Combell and which were self-generated via Let's Encrypt.

### Usage

```bash
# Check all certificates (Combell + Let's Encrypt)
./checkSSL.sh

# Check a specific certificate (by Combell cert name or Let's Encrypt domain)
./checkSSL.sh essen

# Use custom directories
NGINX_CERT_DIR=/custom/path LETSENCRYPT_DIR=/etc/letsencrypt/live ./checkSSL.sh
```

### What It Checks

The script performs comprehensive validation:

1. **File Existence**: Verifies `.key` and `.full.cert` files exist
2. **Format Validation**: Checks files are valid PEM format using OpenSSL
3. **Key/Certificate Match**: Compares modulus to ensure private key matches certificate
4. **Expiration Date**: Shows expiry date with color-coded warnings:
   - 🟢 **Green**: More than 30 days until expiry
   - 🟡 **Yellow**: Less than 30 days (renewal recommended)
   - 🔴 **Red**: Certificate expired
5. **Certificate Details**: Displays subject, Subject Alternative Names (SANs), and issuer — including whether the certificate came from Combell or was self-generated via Let's Encrypt
6. **Usage Check**: For every certificate, searches the active configs in `/etc/nginx/sites-enabled/` (ignoring `*.bak*` files) to show exactly which site(s), if any, actually load it — useful for spotting certificates that are expired-but-unused, or still-valid-but-no-longer-referenced (e.g. before cancelling a Combell certificate, confirm nothing still points at it)

### Example Output

**Successful check:**
```bash
$ ./checkSSL.sh essen

=== Checking essen ===
✓ Certificate and private key match
✓ Certificate valid until: Dec  1 23:59:59 2026 GMT (562 days)
  Subject: CN=de-essen.be
  SANs: DNS:www.de-essen.be,DNS:de-essen.be
  Issuer: C=BE, O=Sectigo Limited, CN=Sectigo RSA Domain Validation Secure Server CA
  Source: Combell
  Where used:
    - /etc/nginx/sites-enabled/essen.conf

================================
Summary: 1 certificate(s) checked
Passed: 1

All certificates are valid!

You can now safely restart nginx:
  sudo systemctl restart nginx
or
  sudo service nginx restart
```

**Failed check, still in use (don't remove this one):**
```bash
$ ./checkSSL.sh old-cert

=== Checking old-cert ===
✓ Certificate and private key match
✗ Certificate EXPIRED on: Jan 15 23:59:59 2025 GMT
⚠️  WARNING: This certificate is currently in use!
  Where used:
    - /etc/nginx/sites-enabled/old-site.conf

================================
Summary: 1 certificate(s) checked
Passed: 0
Failed: 1
```

**Valid but unused (safe to clean up / safe to cancel at the CA):**
```bash
$ ./checkSSL.sh coppieters

=== Checking coppieters ===
✓ Certificate and private key match
✓ Certificate valid until: Nov 30 01:16:16 2026 GMT (36 days)
  Subject: CN=coppieters.be
  Issuer: C=US, O=Let's Encrypt, CN=YE1
  Source: Let's Encrypt (self-generated)
  Where used: (not referenced in any active nginx config)
```

### Configuration

The script respects environment variables:

- `NGINX_CERT_DIR` - Combell certificate directory (default: `/etc/nginx/certs`)
- `LETSENCRYPT_DIR` - Let's Encrypt live directory (default: `/etc/letsencrypt/live`)
- `NGINX_SITES_ENABLED_DIR` - Nginx sites directory (default: `/etc/nginx/sites-enabled`)

### Exit Codes

- `0` - All checks passed
- `1` - One or more checks failed

This makes it safe to use in scripts:

```bash
if ./checkSSL.sh essen; then
    sudo systemctl restart nginx
else
    echo "Certificate validation failed!"
    exit 1
fi
```

### Tips

- Run `checkSSL.sh` after every certificate update before restarting nginx
- Check all certificates periodically: `./checkSSL.sh` (no arguments)
- Use in cron jobs to monitor certificate health:
  ```bash
  # Daily certificate check at 2 AM
  0 2 * * * cd /opt/getSSL && ./checkSSL.sh >> /var/log/cert-check.log 2>&1
  ```
- If a certificate fails but isn't in use, you can safely ignore it until needed

## Troubleshooting

### Permission Issues
Make sure to run with sudo or as root:
```bash
sudo node dist/index.js de-essen.be
```

### API Authentication Errors
- Verify your API credentials in `.env`
- Check that your Combell account has API access enabled
- Ensure the domain name matches exactly what's in your Combell account

### Manual Nginx Restart
This tool does **not** automatically restart nginx for safety. After installing certificates:

1. Verify certificates first:
   ```bash
   ./checkSSL.sh
   ```

2. If all checks pass, restart nginx:
   ```bash
   sudo systemctl restart nginx
   # or
   sudo service nginx restart
   ```

3. If issues occur:
   - Check nginx logs: `sudo journalctl -u nginx -n 50`
   - Verify configuration: `sudo nginx -t`
   - Check certificate files exist and have correct permissions

### Certificate Not Found
- Ensure the domain name is correct
- Verify the SSL certificate exists in your Combell account
- Check the Combell API documentation for the correct domain format

## Development

### Testing on macOS

For testing on macOS (where nginx might not be installed or you don't have root access):

```bash
# Use test mode for dry-run (no files written)
npm start -- --test de-essen.be

# Or test actual download to a temporary directory
NGINX_CERT_DIR=/tmp/nginx-test npm start de-essen.be
```

This will:
- Download the actual PFX certificate from Combell
- Convert it using OpenSSL
- Save files to `/tmp/nginx-test` instead of `/etc/nginx/certs`
- Skip nginx restart operations

### Development Commands

```bash
# Install dependencies
npm install

# Run in development mode (with test flag)
npm run dev -- --test de-essen.be

# Build TypeScript
npm run build

# Run without test mode
npm start de-essen.be
```

## Security Notes

- Keep your `.env` file secure and never commit it to version control
- Ensure proper file permissions on certificate files (644 for certs, 600 for private keys)
- Run the tool with minimum required privileges
- Consider using a dedicated API key with limited permissions

## License

ISC
