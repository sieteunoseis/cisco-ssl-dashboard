import https from 'https';
import tls from 'tls';
import fs from 'fs';
import path from 'path';
import { Logger } from './logger';

export interface CertificateInfo {
  subject: {
    CN?: string;
    O?: string;
    OU?: string;
  };
  issuer: {
    CN?: string;
    O?: string;
    OU?: string;
  };
  validFrom: string;
  validTo: string;
  fingerprint: string;
  fingerprint256: string;
  serialNumber: string;
  subjectAltNames?: string[];
  keyUsage?: string[];
  isValid: boolean;
  daysUntilExpiry: number;
  error?: string;
}

export async function getCertificateInfo(hostname: string, port: number = 443): Promise<CertificateInfo | null> {
  return new Promise((resolve) => {
    Logger.info(`Attempting to get certificate for ${hostname}:${port}`);
    
    const options = {
      host: hostname,
      port: port,
      rejectUnauthorized: false, // Allow self-signed certificates
      timeout: 5000, // 5 second timeout
    };

    const socket = tls.connect(options, () => {
      try {
        Logger.info(`Connected to ${hostname}:${port}, getting certificate`);
        const cert = socket.getPeerCertificate(true);
        
        if (!cert || Object.keys(cert).length === 0) {
          Logger.error(`No certificate found for ${hostname}:${port}`);
          resolve(null);
          return;
        }

        const now = new Date();
        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        const certInfo: CertificateInfo = {
          subject: {
            CN: cert.subject?.CN || '<Not Part Of Certificate>',
            O: cert.subject?.O || '<Not Part Of Certificate>',
            OU: cert.subject?.OU || '<Not Part Of Certificate>',
          },
          issuer: {
            CN: cert.issuer?.CN || '<Not Part Of Certificate>',
            O: cert.issuer?.O || '<Not Part Of Certificate>',
            OU: cert.issuer?.OU || '<Not Part Of Certificate>',
          },
          validFrom: validFrom.toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            timeZoneName: 'short'
          }),
          validTo: validTo.toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            timeZoneName: 'short'
          }),
          fingerprint: cert.fingerprint || '',
          fingerprint256: cert.fingerprint256 || '',
          serialNumber: cert.serialNumber || '',
          subjectAltNames: cert.subjectaltname ? cert.subjectaltname.split(', ') : [],
          isValid: now >= validFrom && now <= validTo,
          daysUntilExpiry: daysUntilExpiry,
        };

        Logger.info(`Successfully retrieved certificate info for ${hostname}:${port}`);
        resolve(certInfo);
      } catch (error) {
        Logger.error(`Error parsing certificate for ${hostname}:${port}:`, error);
        resolve(null);
      } finally {
        socket.destroy();
      }
    });

    socket.on('error', (error) => {
      Logger.error(`TLS connection error for ${hostname}:${port}:`, error);
      resolve(null);
    });

    socket.on('timeout', () => {
      Logger.error(`TLS connection timeout for ${hostname}:${port}`);
      socket.destroy();
      resolve(null);
    });

    socket.setTimeout(5000);
  });
}

/**
 * Parse a PEM certificate file and extract certificate information
 * @param certPath Path to the certificate.pem file
 * @returns CertificateInfo object or null if parsing fails
 */
export async function getCertificateInfoFromFile(certPath: string): Promise<CertificateInfo | null> {
  try {
    if (!fs.existsSync(certPath)) {
      Logger.debug(`Certificate file not found: ${certPath}`);
      return null;
    }

    const certContent = fs.readFileSync(certPath, 'utf8');
    
    // Use Node.js crypto module to parse the certificate
    const crypto = require('crypto');
    const cert = new crypto.X509Certificate(certContent);
    
    const now = new Date();
    const validFrom = new Date(cert.validFrom);
    const validTo = new Date(cert.validTo);
    const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    // Parse subject and issuer
    const subject = cert.subject.split('\n').reduce((acc: any, line: string) => {
      const [key, value] = line.split('=');
      if (key && value) {
        acc[key] = value;
      }
      return acc;
    }, {});

    const issuer = cert.issuer.split('\n').reduce((acc: any, line: string) => {
      const [key, value] = line.split('=');
      if (key && value) {
        acc[key] = value;
      }
      return acc;
    }, {});

    const certInfo: CertificateInfo = {
      subject: {
        CN: subject.CN || '<Not Part Of Certificate>',
        O: subject.O || '<Not Part Of Certificate>',
        OU: subject.OU || '<Not Part Of Certificate>',
      },
      issuer: {
        CN: issuer.CN || '<Not Part Of Certificate>',
        O: issuer.O || '<Not Part Of Certificate>',
        OU: issuer.OU || '<Not Part Of Certificate>',
      },
      validFrom: validFrom.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        timeZoneName: 'short'
      }),
      validTo: validTo.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        timeZoneName: 'short'
      }),
      fingerprint: cert.fingerprint || '',
      fingerprint256: cert.fingerprint256 || '',
      serialNumber: cert.serialNumber || '',
      subjectAltNames: cert.subjectAltName ? cert.subjectAltName.split(', ') : [],
      isValid: now >= validFrom && now <= validTo,
      daysUntilExpiry: daysUntilExpiry,
    };

    Logger.info(`Successfully parsed certificate from file: ${certPath}`);
    return certInfo;
  } catch (error) {
    Logger.error(`Error parsing certificate file ${certPath}:`, error);
    return null;
  }
}

/**
 * Get certificate information from local files or fallback to live TLS connection
 * @param hostname The hostname to get certificate for
 * @returns CertificateInfo object or null if not found
 */
export async function getCertificateInfoWithFallback(hostname: string): Promise<CertificateInfo | null> {
  Logger.info(`Getting certificate info for ${hostname}`);
  
  // First, try to get certificate from local files
  const accountsDir = process.env.ACCOUNTS_DIR || path.join(__dirname, '..', 'accounts');
  const domainDir = path.join(accountsDir, hostname);
  
  // Check for staging environment setting (consistent with account-manager.ts)
  const isStaging = process.env.LETSENCRYPT_STAGING !== 'false';
  const certSubDir = isStaging ? 'staging' : 'prod';
  
  const certPath = path.join(domainDir, certSubDir, 'certificate.pem');
  
  // Primary: Try to get certificate from live TLS connection (what's actually deployed)
  const ports = [443, 8443, 9443];
  
  for (const port of ports) {
    try {
      Logger.info(`Attempting to get certificate for ${hostname}:${port}`);
      const certInfo = await getCertificateInfo(hostname, port);
      if (certInfo) {
        Logger.info(`Retrieved certificate for ${hostname} from live TLS connection on port ${port}`);
        return certInfo;
      }
    } catch (error) {
      Logger.debug(`Failed to connect to ${hostname}:${port}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  Logger.info(`No live TLS connection available for ${hostname}, falling back to local certificate files`);
  
  // Fallback 1: Try local certificate in primary directory
  Logger.debug(`Checking for local certificate at: ${certPath}`);
  const localCertInfo = await getCertificateInfoFromFile(certPath);
  if (localCertInfo) {
    Logger.info(`Found local certificate for ${hostname} in ${certSubDir} directory`);
    return localCertInfo;
  }
  
  // Fallback 2: Try local certificate in alternate directory (staging/prod)
  const alternateCertSubDir = isStaging ? 'prod' : 'staging';
  const alternateCertPath = path.join(domainDir, alternateCertSubDir, 'certificate.pem');
  
  Logger.debug(`Checking for alternate local certificate at: ${alternateCertPath}`);
  const alternateCertInfo = await getCertificateInfoFromFile(alternateCertPath);
  if (alternateCertInfo) {
    Logger.info(`Found local certificate for ${hostname} in ${alternateCertSubDir} directory`);
    return alternateCertInfo;
  }
  
  // No certificate found anywhere
  Logger.warn(`No certificate found for ${hostname} in live TLS connection or local files`);
  return null;
}