import acme from 'acme-client';
import { Logger } from './logger';
import { accountManager } from './account-manager';

export interface ACMEAccount {
  accountKey: string;
  accountUrl: string;
  email: string;
  directory: string;
}

export interface CertificateOrder {
  order: any;
  csr: string;
  domains: string[];
  challenges: any[];
}

export class ACMEClient {
  private client: acme.Client;
  private isStaging: boolean;

  constructor(isStaging: boolean = false) {
    this.isStaging = isStaging;
    const directoryUrl = isStaging
      ? acme.directory.letsencrypt.staging
      : acme.directory.letsencrypt.production;
    
    // Client will be initialized when account is loaded/created
    this.client = null as any;
  }


  async createAccount(email: string, domain: string, connectionId: number): Promise<ACMEAccount> {
    try {
      Logger.info(`Creating Let's Encrypt account for ${email} (domain: ${domain})`);
      
      // Generate account key
      const accountKey = await acme.forge.createPrivateKey();
      
      // Update client with account key
      this.client = new acme.Client({
        directoryUrl: this.isStaging
          ? acme.directory.letsencrypt.staging
          : acme.directory.letsencrypt.production,
        accountKey
      });

      // Create account with Let's Encrypt (with timeout)
      Logger.info(`Creating Let's Encrypt account for ${email}`);
      const accountPromise = this.client.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${email}`]
      });
      
      const accountTimeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Account creation timeout after 30 seconds')), 30000)
      );
      
      const account = await Promise.race([accountPromise, accountTimeoutPromise]);

      Logger.info(`Account creation response:`, account);
      
      // Get the account URL from the client (it's set automatically after account creation)
      let accountUrl = '';
      try {
        accountUrl = (this.client as any).api.getAccountUrl();
        Logger.info(`Got account URL from client: ${accountUrl}`);
      } catch (error) {
        Logger.warn(`Could not get account URL from client: ${error instanceof Error ? error.message : 'Unknown error'}`);
        // Try to extract from response as fallback
        if (account && typeof account === 'object') {
          accountUrl = (account as any).url || 
                       (account as any).uri || 
                       (account as any).accountUrl || 
                       (account as any).location || '';
        }
      }
      
      Logger.info(`Final account URL: ${accountUrl}`);

      const acmeAccount: ACMEAccount = {
        accountKey: accountKey.toString(),
        accountUrl: accountUrl,
        email,
        directory: this.isStaging
          ? acme.directory.letsencrypt.staging
          : acme.directory.letsencrypt.production
      };
      
      Logger.info(`Account created with URL: ${acmeAccount.accountUrl}`);

      // Save account to file system
      await accountManager.saveAccount(connectionId, domain, 'letsencrypt', acmeAccount);
      
      Logger.info(`Successfully created Let's Encrypt account for ${email}`);
      return acmeAccount;
    } catch (error) {
      Logger.error(`Failed to create Let's Encrypt account for ${email}:`, error);
      throw error;
    }
  }

  async loadAccount(domain: string, connectionId: number): Promise<ACMEAccount | null> {
    try {
      const savedAccount = await accountManager.loadAccount(connectionId, domain, 'letsencrypt');
      
      if (!savedAccount) {
        return null;
      }

      const acmeAccount = savedAccount.account_data as ACMEAccount;
      
      Logger.info(`Loading account for domain: ${domain}`);
      Logger.info(`Account URL: ${acmeAccount.accountUrl}`);
      Logger.info(`Account directory: ${acmeAccount.directory}`);
      
      // Update client with loaded account key (convert string back to Buffer if needed)
      const accountKeyBuffer = Buffer.from(acmeAccount.accountKey, 'utf8');
      this.client = new acme.Client({
        directoryUrl: acmeAccount.directory,
        accountKey: accountKeyBuffer,
        accountUrl: acmeAccount.accountUrl || undefined
      });

      Logger.info(`Loaded Let's Encrypt account for domain: ${domain}`);
      return acmeAccount;
    } catch (error) {
      Logger.error(`Failed to load Let's Encrypt account for ${domain}:`, error);
      return null;
    }
  }

  async requestCertificate(csr: string, domains: string[]): Promise<CertificateOrder> {
    try {
      Logger.info(`Requesting certificate for domains: ${domains.join(', ')}`);
      
      if (!this.client) {
        throw new Error('ACME client not initialized. Please load or create an account first.');
      }

      if (!domains || domains.length === 0) {
        throw new Error('No domains provided for certificate request');
      }
      
      // Create certificate order with timeout
      Logger.info(`Creating certificate order for domains: ${domains.join(', ')}`);
      Logger.info(`Using ACME directory: ${this.isStaging ? 'STAGING' : 'PRODUCTION'}`);
      
      const orderPromise = this.client.createOrder({
        identifiers: domains.map(domain => ({
          type: 'dns',
          value: domain
        }))
      });
      
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => {
          Logger.error('Order creation timeout after 15 seconds');
          reject(new Error('Order creation timeout after 15 seconds - Let\'s Encrypt API may be slow'));
        }, 15000)
      );
      
      Logger.info('Waiting for order creation response...');
      const order = await Promise.race([orderPromise, timeoutPromise]) as any;
      Logger.info(`Created certificate order: ${order.url}`);

      // Get authorizations and challenges with timeout
      Logger.info(`Getting authorizations for order: ${order.url}`);
      const authPromise = this.client.getAuthorizations(order);
      const authTimeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Authorization retrieval timeout after 30 seconds')), 30000)
      );
      
      const authorizations = await Promise.race([authPromise, authTimeoutPromise]) as any;
      const challenges: any[] = [];

      for (const authorization of authorizations) {
        // Look for DNS-01 challenge
        const dnsChallenge = authorization.challenges.find(
          (challenge: any) => challenge.type === 'dns-01'
        );
        
        if (dnsChallenge) {
          challenges.push(dnsChallenge);
          Logger.info(`Found DNS-01 challenge for ${authorization.identifier.value}`);
        } else {
          throw new Error(`No DNS-01 challenge found for ${authorization.identifier.value}`);
        }
      }

      return {
        order,
        csr,
        domains,
        challenges
      };
    } catch (error) {
      const domainList = domains && Array.isArray(domains) ? domains.join(', ') : 'unknown domains';
      Logger.error(`Failed to request certificate for domains ${domainList}:`, error);
      throw error;
    }
  }

  async getChallengeKeyAuthorization(challenge: any): Promise<string> {
    try {
      const keyAuthorization = await this.client.getChallengeKeyAuthorization(challenge);
      return keyAuthorization;
    } catch (error) {
      Logger.error('Failed to get challenge key authorization:', error);
      throw error;
    }
  }

  async completeChallenge(challenge: any): Promise<void> {
    try {
      Logger.info(`Completing DNS-01 challenge for ${challenge.url}`);
      
      // Complete challenge
      await this.client.completeChallenge(challenge);
      
      Logger.info(`Successfully completed challenge for ${challenge.url}`);
    } catch (error) {
      Logger.error(`Failed to complete challenge ${challenge.url}:`, error);
      throw error;
    }
  }

  async waitForOrderCompletion(order: any, maxWaitTime: number = 300000): Promise<any> {
    try {
      Logger.info(`Waiting for order completion: ${order.url}`);
      
      // Add a small delay before checking order status to allow ACME server to process
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Wait for the order to be ready
      await this.client.waitForValidStatus(order);

      // Fetch the latest order details from the ACME server
      const completedOrder = await this.client.getOrder(order);
      
      Logger.info(`Order completed successfully: ${completedOrder.url}`);
      return completedOrder;
    } catch (error) {
      Logger.error(`Failed to wait for order completion:`, error);
      
      // Try to get more details about the failure
      try {
        const orderStatus = await this.client.getOrder(order);
        Logger.error(`Order status details:`, JSON.stringify(orderStatus, null, 2));
        
        // Get authorization details
        try {
          const authorizations = await this.client.getAuthorizations(orderStatus);
          Logger.error(`Authorization details:`, JSON.stringify(authorizations, null, 2));
          
          // Check for specific challenge errors
          authorizations.forEach((auth: any, index: number) => {
            Logger.error(`Authorization ${index + 1} status: ${auth.status}`);
            if (auth.challenges) {
              auth.challenges.forEach((challenge: any, chalIndex: number) => {
                Logger.error(`  Challenge ${chalIndex + 1} (${challenge.type}): ${challenge.status}`);
                if (challenge.error) {
                  Logger.error(`    Error: ${JSON.stringify(challenge.error, null, 4)}`);
                }
                if (challenge.validated) {
                  Logger.error(`    Validated: ${challenge.validated}`);
                }
              });
            }
          });
        } catch (authError) {
          Logger.error(`Failed to get authorization details:`, authError);
        }
      } catch (detailError) {
        Logger.error(`Failed to get order details:`, detailError);
      }
      
      throw error;
    }
  }

  async finalizeCertificate(order: any, csr: string): Promise<string> {
    try {
      Logger.info(`Finalizing certificate for order: ${order.url}`);
      
      // Finalize order with CSR
      const finalizedOrder = await this.client.finalizeOrder(order, csr);
      Logger.info('Finalized order details:', JSON.stringify(finalizedOrder, null, 2));

      // Get certificate
      const certificate = await this.client.getCertificate(finalizedOrder);
      
      Logger.info(`Successfully obtained certificate for order: ${order.url}`);
      return certificate;
    } catch (error) {
      Logger.error(`Failed to finalize certificate for order ${order.url}:`, error);
      throw error;
    }
  }

  async revokeCertificate(certificate: string, reason?: any): Promise<void> {
    try {
      Logger.info('Revoking certificate');
      
      await this.client.revokeCertificate(certificate, reason);
      
      Logger.info('Successfully revoked certificate');
    } catch (error) {
      Logger.error('Failed to revoke certificate:', error);
      throw error;
    }
  }

  // Helper method to get DNS TXT record value for challenge
  getDNSRecordValue(keyAuthorization: string): string {
    // According to ACME RFC 8555, the DNS TXT record value should be
    // the base64url-encoded SHA-256 digest of the key authorization.
    // The acme-client library's getChallengeKeyAuthorization function
    // already provides this value, so no further processing is needed.
    return keyAuthorization;
  }
}

// Create client based on LETSENCRYPT_STAGING environment variable
// Defaults to staging (true) for safety unless explicitly set to 'false'
const isStaging = process.env.LETSENCRYPT_STAGING !== 'false';
export const acmeClient = new ACMEClient(isStaging);