#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import axios from 'axios';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface CombellSSLCertificate {
  sha1_fingerprint: string;
  common_name: string;
  expires_after: string;
  validation_level: string;
  type: string;
}

interface CombellSSLCertificateDetail extends CombellSSLCertificate {
  subject_alt_names?: Array<{ type: string; value: string }>;
}

interface CombellApiResponse {
  sha1_fingerprint: string;
  common_name: string;
  expires_after: string;
  validation_level: string;
  type: string;
  subject_alt_names?: Array<{ domain_name: string }>;
}

class SSLManager {
  private apiKey: string;
  private apiSecret: string;
  private pfxPassword: string;
  private apiBaseUrl = 'https://api.combell.com/v2';
  private sitesEnabledDir = '/etc/nginx/sites-enabled';
  private certDir = '/etc/nginx/ssl';
  private testMode: boolean;

  constructor(testMode: boolean = false) {
    this.testMode = testMode;
    this.apiKey = process.env.COMBELL_API_KEY || '';
    this.apiSecret = process.env.COMBELL_API_SECRET || '';
    this.pfxPassword = process.env.PFX_PASSWORD || '';

    if (!this.apiKey || !this.apiSecret) {
      throw new Error('COMBELL_API_KEY and COMBELL_API_SECRET must be set in environment variables or .env file');
    }

    if (!this.pfxPassword && !testMode) {
      console.warn('⚠️  WARNING: PFX_PASSWORD not set. Certificate download will be disabled.');
    }

    // Allow overriding directories via env vars
    if (process.env.NGINX_SITES_ENABLED_DIR) {
      this.sitesEnabledDir = process.env.NGINX_SITES_ENABLED_DIR;
    }
    if (process.env.NGINX_CERT_DIR) {
      this.certDir = process.env.NGINX_CERT_DIR;
    }

    if (this.testMode) {
      console.log('🧪 TEST MODE - No changes will be made\n');
    }
  }

  /**
   * Generate HMAC signature for Combell API authentication
   */
  private generateHmacSignature(method: string, path: string, timestamp: number, nonce: string, content: string = ''): string {
    // Lowercase method
    const lowerMethod = method.toLowerCase();
    
    // Split path and query string
    const [basePath, queryString] = path.split('?');
    
    // Lowercase the base path only
    const lowerBasePath = basePath.toLowerCase();
    
    // For query string, lowercase only the keys, not the values (important for passwords!)
    let lowerQueryString = '';
    if (queryString) {
      const params = new URLSearchParams(queryString);
      const lowerParams = new URLSearchParams();
      
      params.forEach((value, key) => {
        // Lowercase the key, keep the value as-is
        lowerParams.append(key.toLowerCase(), value);
      });
      
      lowerQueryString = '?' + lowerParams.toString();
    }
    
    const lowerPath = lowerBasePath + lowerQueryString;
    
    // URL encode the ENTIRE path (including slashes) and uppercase hex codes
    // encodeURIComponent encodes everything except: A-Z a-z 0-9 - _ . ! ~ * ' ( )
    const encodedPath = encodeURIComponent(lowerPath).replace(/%[0-9a-f]{2}/gi, (match) => match.toUpperCase());
    
    // Hash content if present (MD5, Base64 encoded)
    const contentHash = content ? crypto.createHash('md5').update(content).digest('base64') : '';
    
    // Concatenate: apikey + method + encodedPath + timestamp + nonce + content
    const message = `${this.apiKey}${lowerMethod}${encodedPath}${timestamp}${nonce}${contentHash}`;
    
    if (this.testMode) {
      console.log(`\n🔐 HMAC Debug:`);
      console.log(`  Method: ${lowerMethod}`);
      console.log(`  Original Path: ${path}`);
      console.log(`  Lowercased Path: ${lowerPath}`);
      console.log(`  Encoded Path: ${encodedPath}`);
      console.log(`  Timestamp: ${timestamp}`);
      console.log(`  Nonce: ${nonce}`);
      console.log(`  Message to sign: ${message.substring(0, 100)}...`);
    }
    
    // Generate HMAC-SHA256 signature using the API secret
    const hmac = crypto.createHmac('sha256', this.apiSecret);
    hmac.update(message);
    const signature = hmac.digest('base64');
    
    return signature;
  }

  /**
   * Get authorization header for Combell API using HMAC
   */
  private getAuthHeader(method: string, path: string, content: string = ''): { Authorization: string } {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString('hex');
    const signature = this.generateHmacSignature(method, path, timestamp, nonce, content);
    
    // Authorization format: hmac apikey:signature:nonce:timestamp
    const authHeader = `hmac ${this.apiKey}:${signature}:${nonce}:${timestamp}`;
    
    return { Authorization: authHeader };
  }

  /**
   * Fetch SSL certificate from Combell API
   */
  async fetchCertificate(domainName: string): Promise<CombellSSLCertificateDetail> {
    try {
      console.log(`Fetching SSL certificates list from Combell...`);
      
      const listPath = `/sslcertificates`;
      const listUrl = `${this.apiBaseUrl}${listPath}`;
      const listHeaders = {
        ...this.getAuthHeader('GET', `/v2${listPath}`),
        'Content-Type': 'application/json'
      };

      if (this.testMode) {
        console.log(`\n🔍 Debug Info:`);
        console.log(`  API URL: ${listUrl}`);
        console.log(`  API Key: ${this.apiKey.substring(0, 8)}...`);
        console.log(`  API Secret: ${this.apiSecret.substring(0, 8)}...`);
        console.log(`  Auth Header: ${listHeaders.Authorization.substring(0, 40)}...`);
      }
      
      // Get list of all certificates
      const listResponse = await axios.get<CombellSSLCertificate[]>(listUrl, { headers: listHeaders });
      
      console.log(`Found ${listResponse.data.length} SSL certificate(s)`);
      console.log(listResponse.data.map(c => `  - ${c.common_name} (expires: ${c.expires_after})`).join('\n'));
      
      // Find certificate matching the domain
      const cert = listResponse.data.find(c => 
        c.common_name === domainName || 
        c.common_name === `www.${domainName}` ||
        domainName.startsWith(c.common_name.replace('*.', ''))
      );
      
      if (!cert) {
        throw new Error(`No SSL certificate found for domain: ${domainName}\n\nAvailable certificates:\n${
          listResponse.data.map(c => `  - ${c.common_name} (expires: ${c.expires_after})`).join('\n')
        }`);
      }
      
      console.log(`Found certificate for ${cert.common_name}`);
      
      // Get certificate details
      // Note: The fingerprint from the API is in uppercase
      const detailPath = `/sslcertificates/${cert.sha1_fingerprint.toLowerCase()}`;
      const detailUrl = `${this.apiBaseUrl}${detailPath}`;
      const detailHeaders = {
        ...this.getAuthHeader('GET', `/v2${detailPath}`),
        'Content-Type': 'application/json'
      };
      
      if (this.testMode) {
        console.log(`  Detail URL: ${detailUrl}`);
      }
      
      const detailResponse = await axios.get<CombellSSLCertificateDetail>(detailUrl, { headers: detailHeaders });
      
      return detailResponse.data;
    } catch (error: any) {
      if (error.response) {
        const errorMsg = `Combell API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`;
        
        if (error.response.status === 401) {
          throw new Error(`${errorMsg}\n\nAuthentication failed. Please check:\n  1. Your COMBELL_API_KEY and COMBELL_API_SECRET in .env file\n  2. That your API credentials are active in your Combell account\n  3. That you have whitelisted your IP address in the Combell control panel\n  4. That you have permission to access SSL certificates`);
        }
        
        throw new Error(errorMsg);
      }
      throw error;
    }
  }

  /**
   * Get paths for certificate files
   */
  private getCertPaths(certName: string) {
    return {
      certFile: path.join(this.certDir, `${certName}.crt`),
      keyFile: path.join(this.certDir, `${certName}.key`),
      chainFile: path.join(this.certDir, `${certName}.chain.crt`),
      fullChainFile: path.join(this.certDir, `${certName}.fullchain.crt`)
    };
  }

  /**
   * Check if new certificate is different/newer than existing one
   */
  private shouldUpdateCertificate(certPath: string, expiresAfter: string): boolean {
    if (!fs.existsSync(certPath)) {
      console.log('No existing certificate found. Would install new certificate.');
      return true;
    }

    // Try to read expiry from existing cert
    try {
      const certContent = fs.readFileSync(certPath, 'utf8');
      // This is a simplified check - in production you'd parse the cert properly
      console.log(`Existing certificate found. New cert expires: ${expiresAfter}`);
      return true; // For now, always suggest update if dates differ
    } catch (error) {
      console.log('Could not read existing certificate. Would install new one.');
      return true;
    }
  }

  /**
   * Download PFX certificate from Combell API
   */
  private async downloadPfxCertificate(sha1Fingerprint: string): Promise<Buffer> {
    const downloadPath = `/sslcertificates/${sha1Fingerprint.toLowerCase()}/download`;
    const queryString = `file_format=pfx&password=${encodeURIComponent(this.pfxPassword)}`;
    const fullPath = `${downloadPath}?${queryString}`;
    
    const downloadUrl = `${this.apiBaseUrl}${fullPath}`;
    const hmacPath = `/v2${fullPath}`;
    
    const headers = {
      ...this.getAuthHeader('GET', hmacPath),
      'Accept': 'application/x-pkcs12'
    };

    console.log('Downloading PFX certificate...');
    
    const response = await axios.get(downloadUrl, {
      headers,
      responseType: 'arraybuffer'
    });

    return Buffer.from(response.data);
  }

  /**
   * Convert PFX to separate certificate and private key files using OpenSSL
   */
  private convertPfxToPem(pfxBuffer: Buffer, certName: string): void {
    const paths = this.getCertPaths(certName);
    const tempPfxPath = path.join(this.certDir, `${certName}.temp.pfx`);

    try {
      // Create cert directory if it doesn't exist
      if (!fs.existsSync(this.certDir)) {
        console.log(`Creating certificate directory: ${this.certDir}`);
        try {
          fs.mkdirSync(this.certDir, { recursive: true, mode: 0o755 });
        } catch (mkdirError: any) {
          if (mkdirError.code === 'EACCES') {
            throw new Error(`Permission denied creating directory ${this.certDir}. Run with sudo or set CERT_DIR to a writable directory.`);
          }
          throw mkdirError;
        }
      }

      console.log(`Downloaded ${pfxBuffer.length} bytes`);

      // Write PFX to temporary file
      fs.writeFileSync(tempPfxPath, pfxBuffer, { mode: 0o600 });

      console.log('Converting PFX to PEM format...');

      // Extract certificate (without private key)
      execSync(
        `openssl pkcs12 -in "${tempPfxPath}" -clcerts -nokeys -out "${paths.certFile}" -passin pass:"${this.pfxPassword}" -passout pass:`,
        { stdio: 'pipe' }
      );
      fs.chmodSync(paths.certFile, 0o644);
      console.log(`  ✓ Certificate: ${paths.certFile}`);

      // Extract private key
      execSync(
        `openssl pkcs12 -in "${tempPfxPath}" -nocerts -nodes -out "${paths.keyFile}" -passin pass:"${this.pfxPassword}" -passout pass:`,
        { stdio: 'pipe' }
      );
      fs.chmodSync(paths.keyFile, 0o600);
      console.log(`  ✓ Private key: ${paths.keyFile}`);

      // Extract CA certificate chain
      try {
        execSync(
          `openssl pkcs12 -in "${tempPfxPath}" -cacerts -nokeys -out "${paths.chainFile}" -passin pass:"${this.pfxPassword}" -passout pass:`,
          { stdio: 'pipe' }
        );
        
        // Check if chain file has content
        const chainContent = fs.readFileSync(paths.chainFile, 'utf8');
        if (chainContent.trim().length > 0) {
          fs.chmodSync(paths.chainFile, 0o644);
          console.log(`  ✓ Chain: ${paths.chainFile}`);

          // Create fullchain file (certificate + chain)
          const certContent = fs.readFileSync(paths.certFile, 'utf8');
          const fullChain = certContent + '\n' + chainContent;
          fs.writeFileSync(paths.fullChainFile, fullChain, { mode: 0o644 });
          console.log(`  ✓ Full chain: ${paths.fullChainFile}`);
        } else {
          // No chain in PFX, remove empty file
          fs.unlinkSync(paths.chainFile);
          // Copy cert as fullchain
          fs.copyFileSync(paths.certFile, paths.fullChainFile);
          console.log(`  ℹ No certificate chain found, using certificate only`);
        }
      } catch (error) {
        // If chain extraction fails, just use the certificate
        fs.copyFileSync(paths.certFile, paths.fullChainFile);
        console.log(`  ℹ Certificate chain extraction failed, using certificate only`);
      }

    } finally {
      // Clean up temporary PFX file
      if (fs.existsSync(tempPfxPath)) {
        fs.unlinkSync(tempPfxPath);
      }
    }
  }

  /**
   * Install certificate files
   */
  private async installCertificate(siteName: string, cert: CombellSSLCertificateDetail, certName?: string): Promise<void> {
    const actualCertName = certName || siteName;
    const paths = this.getCertPaths(actualCertName);

    if (this.testMode) {
      console.log('\n📝 Certificate Information:');
      console.log(`  • Common Name: ${cert.common_name}`);
      console.log(`  • Expires After: ${cert.expires_after}`);
      console.log(`  • Validation Level: ${cert.validation_level}`);
      console.log(`  • Type: ${cert.type}`);
      console.log(`  • SHA1 Fingerprint: ${cert.sha1_fingerprint}`);
      
      if (cert.subject_alt_names && cert.subject_alt_names.length > 0) {
        console.log(`  • Subject Alternative Names:`);
        cert.subject_alt_names.forEach(san => {
          console.log(`    - ${san.value}`);
        });
      }
      
      console.log(`\n📂 Would install to:`);
      console.log(`  • Certificate: ${paths.certFile}`);
      console.log(`  • Private key: ${paths.keyFile}`);
      console.log(`  • Chain: ${paths.chainFile}`);
      console.log(`  • Full chain: ${paths.fullChainFile}`);

      if (!this.pfxPassword) {
        console.log(`\n⚠️  PFX_PASSWORD not set - certificate download would be skipped`);
      } else {
        console.log(`\n✓ PFX_PASSWORD is set - certificate download would proceed`);
      }
      return;
    }

    // Check if password is set
    if (!this.pfxPassword) {
      throw new Error('PFX_PASSWORD must be set in .env file to download certificates.\n\nAdd to your .env file:\nPFX_PASSWORD=your_secure_password');
    }

    // Download PFX certificate
    const pfxBuffer = await this.downloadPfxCertificate(cert.sha1_fingerprint);
    console.log(`Downloaded ${pfxBuffer.length} bytes`);

    // Convert PFX to PEM format
    this.convertPfxToPem(pfxBuffer, actualCertName);

    console.log(`\nCertificate installed successfully!`);
    console.log(`Valid until: ${cert.expires_after}`);
  }

  /**
   * Test nginx configuration
   */
  private testNginxConfig(): boolean {
    if (this.testMode) {
      console.log('🧪 TEST MODE - Would test nginx configuration (nginx -t)');
      return true;
    }

    try {
      console.log('Testing nginx configuration...');
      execSync('nginx -t', { stdio: 'pipe' });
      console.log('  ✓ Nginx configuration is valid');
      return true;
    } catch (error: any) {
      console.error('  ✗ Nginx configuration test failed:');
      console.error(error.stderr?.toString() || error.message);
      return false;
    }
  }

  /**
   * Restart nginx
   */
  private restartNginx(): void {
    if (this.testMode) {
      console.log('🧪 TEST MODE - Would restart nginx (systemctl restart nginx)');
      return;
    }

    try {
      console.log('Restarting nginx...');
      execSync('systemctl restart nginx', { stdio: 'inherit' });
      console.log('  ✓ Nginx restarted successfully');
    } catch (error: any) {
      // Try alternative restart methods
      try {
        execSync('service nginx restart', { stdio: 'inherit' });
        console.log('  ✓ Nginx restarted successfully');
      } catch (e) {
        throw new Error('Failed to restart nginx. Please restart manually.');
      }
    }
  }

  /**
   * Main process to update SSL certificate
   */
  async updateSSL(siteName: string, certName?: string): Promise<void> {
    const actualCertName = certName || siteName;
    
    console.log(`\n=== SSL Certificate Update ===`);
    console.log(`Domain: ${siteName}`);
    if (certName) {
      console.log(`Certificate files: ${certName}.*`);
    }
    console.log('');

    // Fetch certificate from Combell API
    const cert = await this.fetchCertificate(siteName);

    // Check if update is needed
    const paths = this.getCertPaths(actualCertName);
    if (!this.shouldUpdateCertificate(paths.certFile, cert.expires_after)) {
      console.log('\nNo update needed. Exiting.');
      return;
    }

    // Install certificate
    await this.installCertificate(siteName, cert, actualCertName);

    if (this.testMode) {
      console.log('\n🧪 TEST MODE - Skipping nginx operations');
      return;
    }

    // Test nginx configuration
    if (!this.testNginxConfig()) {
      throw new Error('Nginx configuration test failed. Certificate files may be invalid.');
    }

    // Restart nginx
    this.restartNginx();

    console.log('\n✓ SSL certificate update completed successfully!\n');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let siteName = '';
  let certName = '';
  let testMode = false;
  const positionalArgs: string[] = [];

  for (const arg of args) {
    if (arg === '--test' || arg === '-t' || arg === '--dry-run') {
      testMode = true;
    } else if (!arg.startsWith('-')) {
      positionalArgs.push(arg);
    }
  }

  siteName = positionalArgs[0] || '';
  certName = positionalArgs[1] || '';

  if (!siteName) {
    console.error('Usage: getssl [--test] <domain-name> [cert-name]');
    console.error('');
    console.error('Arguments:');
    console.error('  domain-name              Domain name to fetch from Combell API');
    console.error('  cert-name                Optional: Base name for certificate files');
    console.error('                           (defaults to domain-name if not specified)');
    console.error('');
    console.error('Options:');
    console.error('  --test, -t, --dry-run    Run in test mode (no changes made)');
    console.error('');
    console.error('Examples:');
    console.error('  getssl de-essen.be');
    console.error('  getssl de-essen.be essen');
    console.error('  getssl rooigemhuisartsenpraktijk.be rooigem');
    console.error('  getssl --test de-essen.be');
    process.exit(1);
  }

  try {
    const manager = new SSLManager(testMode);
    await manager.updateSSL(siteName, certName || undefined);
  } catch (error: any) {
    console.error('\n✗ Error:', error.message);
    process.exit(1);
  }
}

main();
