import { Injectable, Logger } from '@nestjs/common';

interface IpApiResponse {
  status: string;
  country: string;
  countryCode: string;
  region: string;
  regionName: string;
  city: string;
  zip: string;
  lat: number;
  lon: number;
  timezone: string;
  isp: string;
  org: string;
  as: string;
  query: string;
}

@Injectable()
export class GeoIpService {
  private readonly logger = new Logger(GeoIpService.name);
  private cache: Map<string, { country: string; timestamp: number }> = new Map();
  private readonly cacheTtl = 24 * 60 * 60 * 1000; // 24 hours

  async getCountryFromIp(ip: string): Promise<string | null> {
    // Skip private/local IPs
    if (this.isPrivateIp(ip)) {
      this.logger.warn(`Skipping private/local IP: ${ip} - country lookup not available for local testing`);
      return null;
    }

    // Check cache
    const cached = this.cache.get(ip);
    if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
      return cached.country;
    }

    try {
      // Use ip-api.com (free, no API key needed, 45 requests/minute limit)
      const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: Partial<IpApiResponse> = await response.json();

      if (data.status !== 'success' || !data.countryCode) {
        this.logger.warn(`Failed to get country for IP ${ip}: ${data.status}`);
        return null;
      }

      // Cache the result
      this.cache.set(ip, {
        country: data.countryCode,
        timestamp: Date.now(),
      });

      this.logger.debug(`IP ${ip} resolved to country: ${data.countryCode}`);
      return data.countryCode;
    } catch (error) {
      this.logger.error(`Failed to lookup IP ${ip}:`, error);
      return null;
    }
  }

  private isPrivateIp(ip: string): boolean {
    // IPv4 private ranges
    if (
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      ip.startsWith('127.') ||
      ip.startsWith('172.16.') ||
      ip.startsWith('172.17.') ||
      ip.startsWith('172.18.') ||
      ip.startsWith('172.19.') ||
      ip.startsWith('172.20.') ||
      ip.startsWith('172.21.') ||
      ip.startsWith('172.22.') ||
      ip.startsWith('172.23.') ||
      ip.startsWith('172.24.') ||
      ip.startsWith('172.25.') ||
      ip.startsWith('172.26.') ||
      ip.startsWith('172.27.') ||
      ip.startsWith('172.28.') ||
      ip.startsWith('172.29.') ||
      ip.startsWith('172.30.') ||
      ip.startsWith('172.31.') ||
      ip === '::1' ||
      ip === 'localhost'
    ) {
      return true;
    }

    return false;
  }
}
