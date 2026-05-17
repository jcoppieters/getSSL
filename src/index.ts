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
  subject_alt_names?: Array<{ domain_name: string }>;
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
  private apiSecret: string | Buffer;
  private apiBaseUrl = 'https://api.combell.com/v2';
  private sitesEnabledDir = '/etc/nginx/sites-enabled';
  private certDir = '/etc/nginx/ssl';
  private testMode: boolean;

  constructor(testMode: boolean = false) {
    this.testMode = testMode;
    this.apiKey = process.env.COMBELL_API_KEY || '';
    const apiSecretString = process.env.COMBELL_API_SECRET || '';

    if (!this.apiKey || !apiSecretString) {
      throw new Error('COMBELL_API_KEY and COMBELL_API_SECRET must be set in environment variables or .env file');
    }

    // The API secret is a hex string - decode it to bytes for HMAC
    if (/^[0-9A-Fa-f]+$/.test(apiSecretString) && apiSecretString.length === 64) {
      this.apiSecret = Buffer.from(apiSecretString, 'hex');
    } else {
      this.apiSecret = apiSecretString;
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
    
    // URL encode the path: lowercase the path, then encode it, then uppercase the hex codes
    // For a path like "/v2/sslcertificates", this should just be "/v2/sslcertificates" since no encoding needed
    let encodedPath = path.toLowerCase();
    // Only encode if there are special characters
    if (encodedPath.match(/[^a-z0-9\/._~-]/)) {
      encodedPath = encodeURIComponent(encodedPath).replace(/%[0-9A-F]{2}/g, (match) => match.toUpperCase());
    }
    
    // Hash content if present (MD5, Base64 encoded)
    const contentHash = content ? crypto.createHash('md5').update(content).digest('base64') : '';
    
    // Concatenate: apikey + method + path + timestamp + nonce + content
    const message = `${this.apiKey}${lowerMethod}${encodedPath}${timestamp}${nonce}${contentHash}`;
    
    if (this.testMode) {
      console.log(`\n🔐 HMAC Debug:`);
      console.log(`  Method: ${lowerMethod}`);
      console.log(`  Path: ${encodedPath}`);
      console.log(`  Timestamp: ${timestamp}`);
      console.log(`  Nonce: ${nonce}`);
      console.log(`  Message to sign: ${message}`);
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
        console.log(`  API Secret: ${Buffer.isBuffer(this.apiSecret) ? '<hex-decoded>' : this.apiSecret.substring(0, 8) + '...'}`);
        console.log(`  Auth Header: ${listHeaders.Authorization.substring(0, 40)}...`);
      }
      
      // Get list of all certificates
      const listResponse = await axios.get<CombellSSLCertificate[]>(listUrl, { headers: listHeaders });
      
      console.log(`Found ${listResponse.data.length} SSL certificate(s)`);
      
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
      const detailPath = `/sslcertificates/${cert.sha1_fingerprint}`;
      const detailUrl = `${this.apiBaseUrl}${detailPath}`;
      const detailHeaders = {
        ...this.getAuthHeader('GET', `/v2${detailPath}`),
        'Content-Type': 'application/json'
      };
      
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
  private getCertPaths(siteName: string) {
    return {
      certFile: path.join(this.certDir, `${siteName}.crt`),
      keyFile: path.join(this.certDir, `${siteName}.key`),
      chainFile: path.join(this.certDir, `${siteName}.chain.crt`),
      fullChainFile: path.join(this.certDir, `${siteName}.fullchain.crt`)
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
   * Install certificate files
   * NOTE: Combell API only provides PFX downloads which require a password
   */
  private installCertificate(siteName: string, cert: CombellSSLCertificateDetail): void {
    const paths = this.getCertPaths(siteName);

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
          console.log(`    - ${san.domain_name}`);
        });
      }
      
      console.log(`\n⚠️  LIMITATION:`);
      console.log(`  The Combell API only provides SSL certificates as PFX (PKCS#12) files`);
      console.log(`  which require a password to decrypt. To download and install:`);
      console.log(``);
      console.log(`  1. Manually download from: https://api.combell.com/v2/sslcertificates/${cert.sha1_fingerprint}/download`);
      console.log(`  2. Provide a password and file_format=pfx as query parameters`);
      console.log(`  3. Convert PFX to separate .crt and .key files using openssl:`);
      console.log(`     openssl pkcs12 -in cert.pfx -out cert.crt -clcerts -nokeys`);
      console.log(`     openssl pkcs12 -in cert.pfx -out cert.key -nocerts -nodes`);
      
      console.log(`\n📂 Would install to:`);
      console.log(`  • Certificate: ${paths.certFile}`);
      console.log(`  • Private key: ${paths.keyFile}`);
      console.log(`  • Chain: ${paths.chainFile}`);
      console.log(`  • Full chain: ${paths.fullChainFile}`);
      return;
    }

    throw new Error('Certificate installation not yet implemented.\n\nThe Combell API requires a password to download PFX certificates.\nPlease add PFX_PASSWORD to your .env file or download certificates manually from the Combell control panel.');
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
  async updateSSL(siteName: string): Promise<void> {
    console.log(`\n=== SSL Certificate Update for ${siteName} ===\n`);

    // Fetch certificate from Combell API
    const cert = await this.fetchCertificate(siteName);

    // Check if update is needed
    const paths = this.getCertPaths(siteName);
    if (!this.shouldUpdateCertificate(paths.certFile, cert.expires_after)) {
      console.log('\nNo update needed. Exiting.');
      return;
    }

    // Install certificate
    this.installCertificate(siteName, cert);

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
  let testMode = false;

  for (const arg of args) {
    if (arg === '--test' || arg === '-t' || arg === '--dry-run') {
      testMode = true;
    } else if (!arg.startsWith('-')) {
      siteName = arg;
    }
  }

  if (!siteName) {
    console.error('Usage: getssl [--test] <site-name>');
    console.error('');
    console.error('Options:');
    console.error('  --test, -t, --dry-run    Run in test mode (no changes made)');
    console.error('');
    console.error('Examples:');
    console.error('  getssl de-essen.be');
    console.error('  getssl --test de-essen.be');
    process.exit(1);
  }

  try {
    const manager = new SSLManager(testMode);
    await manager.updateSSL(siteName);
  } catch (error: any) {
    console.error('\n✗ Error:', error.message);
    process.exit(1);
  }
}

main();
