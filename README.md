# getSSL - Combell SSL Certificate Automation

A TypeScript tool to automatically fetch, install, and manage SSL certificates from Combell's API for nginx.

## Features

- ✅ Fetches SSL certificates from Combell API
- ✅ Checks if certificate is newer before installing
- ✅ Installs certificate, private key, and certificate chain
- ✅ Tests nginx configuration before restarting
- ✅ Automatically restarts nginx after successful installation
- ✅ Can be run from crontab for automated certificate renewal

## Prerequisites

- Node.js 18+ and npm
- Access to Combell API (API key and secret)
- nginx installed and configured
- Sufficient permissions to write to nginx directories and restart nginx (usually requires root/sudo)

## Installation

1. Clone or download this repository:
   ```bash
   cd /opt
   git clone <repository-url> getssl
   cd getssl
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the TypeScript code:
   ```bash
   npm run build
   ```

4. Create a `.env` file with your Combell API credentials:
   ```bash
   cp .env.example .env
   nano .env
   ```

   Add your credentials:
   ```
   COMBELL_API_KEY=your_actual_api_key
   COMBELL_API_SECRET=your_actual_api_secret
   ```

5. (Optional) Install globally or create a symlink:
   ```bash
   npm link
   # or
   ln -s /opt/getssl/dist/index.js /usr/local/bin/getssl
   chmod +x /opt/getssl/dist/index.js
   ```

## Usage

### Test Mode (Dry Run)

Test the tool without making any changes - perfect for development and testing on macOS:

```bash
# Using npm
npm start -- --test de-essen.be

# Using npm run dev
npm run dev -- --test de-essen.be

# If installed globally
getssl --test de-essen.be
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
# Using npm
npm start de-essen.be

# Using npm with test mode
npm start -- --test de-essen.be

# If installed globally or symlinked
getssl de-essen.be

# Test mode
getssl --test de-essen.be

# With sudo (required for nginx operations in production)
sudo -E npm start de-essen.be
# or
sudo getssl de-essen.be
```

### Running from Crontab

To automatically check and update SSL certificates daily:

1. Edit root's crontab:
   ```bash
   sudo crontab -e
   ```

2. Add a cron job (example: run daily at 3:00 AM):
   ```cron
   # Check SSL certificate for de-essen.be daily at 3:00 AM
   0 3 * * * cd /opt/getssl && /usr/bin/node dist/index.js de-essen.be >> /var/log/getssl.log 2>&1
   ```

   Or if you have multiple sites:
   ```cron
   # Check SSL certificates daily at 3:00 AM
   0 3 * * * cd /opt/getssl && /usr/bin/node dist/index.js de-essen.be >> /var/log/getssl-de-essen.log 2>&1
   0 3 * * * cd /opt/getssl && /usr/bin/node dist/index.js example.com >> /var/log/getssl-example.log 2>&1
   ```

3. Make sure the `.env` file is readable by root:
   ```bash
   sudo chmod 600 /opt/getssl/.env
   sudo chown root:root /opt/getssl/.env
   ```

## Configuration

### Environment Variables

- `COMBELL_API_KEY` (required): Your Combell API key
- `COMBELL_API_SECRET` (required): Your Combell API secret
- `NGINX_SITES_ENABLED_DIR` (optional): Override nginx sites-enabled directory (default: `/etc/nginx/sites-enabled`)
- `NGINX_CERT_DIR` (optional): Override certificate storage directory (default: `/etc/nginx/ssl`)

### Certificate Files

The tool creates the following files in `/etc/nginx/ssl/`:

- `{sitename}.crt` - The SSL certificate
- `{sitename}.key` - The private key
- `{sitename}.chain.crt` - The certificate chain
- `{sitename}.fullchain.crt` - Full chain (certificate + chain)

### Nginx Configuration Example

```nginx
server {
    listen 443 ssl http2;
    server_name de-essen.be www.de-essen.be;

    ssl_certificate /etc/nginx/ssl/de-essen.be.fullchain.crt;
    ssl_certificate_key /etc/nginx/ssl/de-essen.be.key;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384;

    # ... rest of your configuration
}
```

## How It Works

1. **Fetch**: Connects to Combell API and retrieves the SSL certificate for the specified domain
2. **Compare**: Checks if the certificate is different from the currently installed one
3. **Install**: If newer/different, writes the certificate files to `/etc/nginx/ssl/`
4. **Test**: Runs `nginx -t` to verify configuration is still valid
5. **Restart**: Restarts nginx to apply the new certificate

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

### Nginx Won't Restart
- Check nginx logs: `sudo journalctl -u nginx -n 50`
- Verify configuration: `sudo nginx -t`
- Check certificate files exist and have correct permissions

### Certificate Not Found
- Ensure the domain name is correct
- Verify the SSL certificate exists in your Combell account
- Check the Combell API documentation for the correct domain format

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev de-essen.be

# Build
npm run build
```

## Security Notes

- Keep your `.env` file secure and never commit it to version control
- Ensure proper file permissions on certificate files (644 for certs, 600 for private keys)
- Run the tool with minimum required privileges
- Consider using a dedicated API key with limited permissions

## License

ISC
