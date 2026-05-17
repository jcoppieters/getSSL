#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import axios from 'axios';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface CombellSSLCertificate {
  certificateChain: string;
  privateKey: string;
  certificate: string;
  validFrom: string;
  validTo: string;
}

interface CombellApiResponse {
  certificate: string;
  privateKey: string;
  certificateChain: string;
  validFrom: string;
  validTo: string;
}

class SSLManager {
  private apiKey: string;
  private apiSecret: string;
  private apiBaseUrl = 'https://api.combell.com/v2';
  private sitesEnabledDir = '/etc/nginx/sites-enabled';
  private certDir = '/etc/nginx/ssl';
  private testMode: boolean;

  constructor(testMode: boolean = false) {
    this.testMode = testMode;
    this.apiKey = process.env.COMBELL_API_KEY || '';
    this.apiSecret = process.env.COMBELL_API_SECRET || '';

    if (!this.apiKey || !this.apiSecret) {
      throw new Error('COMBELL_API_KEY and COMBELL_API_SECRET must be set in environment variables or .env file');
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
   * Get authorization header for Combell API
   */
  private getAuthHeader(): string {
    const credentials = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64');
    return `Basic ${credentials}`;
  }

  /**
   * Fetch SSL certificate from Combell API
   */
  async fetchCertificate(domainName: string): Promise<CombellSSLCertificate> {
    try {
      console.log(`Fetching SSL certificate for ${domainName}...`);
      
      // According to Combell API docs, we need to get the certificate for a specific domain
      const response = await axios.get<CombellApiResponse>(
        `${this.apiBaseUrl}/sslcertificates/${domainName}`,
        {
          headers: {
            'Authorization': this.getAuthHeader(),
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        certificate: response.data.certificate,
        privateKey: response.data.privateKey,
        certificateChain: response.data.certificateChain,
        validFrom: response.data.validFrom,
        validTo: response.data.validTo
      };
    } catch (error: any) {
      if (error.response) {
        throw new Error(`Combell API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
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
  private shouldUpdateCertificate(certPath: string, newCert: string, validTo: string): boolean {
    if (!fs.existsSync(certPath)) {
      console.log('No existing certificate found. Installing new certificate.');
      return true;
    }

    const existingCert = fs.readFileSync(certPath, 'utf8');
    
    // Check if certificate content is different
    if (existingCert.trim() !== newCert.trim()) {
      console.log('Certificate content has changed. Updating...');
      return true;
    }

    console.log('Certificate is already up to date.');
    return false;
  }

  /**
   * Install certificate files
   */
  private installCertificate(siteName: string, cert: CombellSSLCertificate): void {
    const paths = this.getCertPaths(siteName);

    if (this.testMode) {
      console.log('📝 TEST MODE - Would install certificate files:');
      console.log(`  • Certificate: ${paths.certFile}`);
      console.log(`  • Private key: ${paths.keyFile}`);
      console.log(`  • Chain: ${paths.chainFile}`);
      console.log(`  • Full chain: ${paths.fullChainFile}`);
      console.log(`\n📅 Certificate Details:`);
      console.log(`  • Valid from: ${cert.validFrom}`);
      console.log(`  • Valid to: ${cert.validTo}`);
      console.log(`\n📄 Certificate preview (first 200 chars):`);
      console.log(cert.certificate.substring(0, 200) + '...');
      return;
    }

    // Create cert directory if it doesn't exist
    if (!fs.existsSync(this.certDir)) {
      console.log(`Creating certificate directory: ${this.certDir}`);
      fs.mkdirSync(this.certDir, { recursive: true, mode: 0o755 });
    }

    console.log('Installing certificate files...');

    // Write certificate file
    fs.writeFileSync(paths.certFile, cert.certificate, { mode: 0o644 });
    console.log(`  ✓ Certificate: ${paths.certFile}`);

    // Write private key file
    fs.writeFileSync(paths.keyFile, cert.privateKey, { mode: 0o600 });
    console.log(`  ✓ Private key: ${paths.keyFile}`);

    // Write certificate chain file
    if (cert.certificateChain) {
      fs.writeFileSync(paths.chainFile, cert.certificateChain, { mode: 0o644 });
      console.log(`  ✓ Chain: ${paths.chainFile}`);

      // Create fullchain file (certificate + chain)
      const fullChain = cert.certificate + '\n' + cert.certificateChain;
      fs.writeFileSync(paths.fullChainFile, fullChain, { mode: 0o644 });
      console.log(`  ✓ Full chain: ${paths.fullChainFile}`);
    }

    console.log(`Certificate valid from ${cert.validFrom} to ${cert.validTo}`);
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
    if (!this.shouldUpdateCertificate(paths.certFile, cert.certificate, cert.validTo)) {
      console.log('\nNo update needed. Exiting.');
      return;
    }

    // Install certificate
    this.installCertificate(siteName, cert);

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
