/**
 * URL Validator for MCP Servers
 *
 * Provides SSRF (Server-Side Request Forgery) protection by validating
 * MCP server URLs against common attack patterns and dangerous destinations.
 */

import { createLogger } from "@/lib/logs/console/logger";

const logger = createLogger("McpUrlValidator");

// Allow localhost/private IPs in development mode
const IS_DEVELOPMENT =
  process.env.NODE_ENV === "development" ||
  process.env.ALLOW_LOCAL_MCP === "true";

// Blocked IPv4 ranges
const PRIVATE_IP_RANGES = [
  /^127\./, // Loopback (127.0.0.0/8)
  /^10\./, // Private class A (10.0.0.0/8)
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // Private class B (172.16.0.0/12)
  /^192\.168\./, // Private class C (192.168.0.0/16)
  /^169\.254\./, // Link-local (169.254.0.0/16)
  /^0\./, // Invalid range
];

// Blocked IPv6 ranges
const PRIVATE_IPV6_RANGES = [
  /^::1$/, // Localhost
  /^::ffff:/, // IPv4-mapped IPv6
  /^fc00:/, // Unique local (fc00::/7)
  /^fd00:/, // Unique local (fd00::/8)
  /^fe80:/, // Link-local (fe80::/10)
];

// Development-safe hostnames (allowed in development mode)
const DEV_SAFE_HOSTNAMES = ["localhost"];

// Blocked hostnames - SSRF protection (always blocked even in development)
const BLOCKED_HOSTNAMES = [
  // Cloud metadata endpoints
  "metadata.google.internal", // Google Cloud metadata
  "metadata.gce.internal", // Google Compute Engine metadata (legacy)
  "169.254.169.254", // AWS/Azure/GCP metadata service IP
  "metadata.azure.com", // Azure Instance Metadata Service
  "instance-data.ec2.internal", // AWS EC2 instance metadata (internal)
  // Service discovery endpoints
  "consul", // HashiCorp Consul
  "etcd", // etcd key-value store
];

// Blocked ports
const BLOCKED_PORTS = [
  22, // SSH
  23, // Telnet
  25, // SMTP
  53, // DNS
  110, // POP3
  143, // IMAP
  993, // IMAPS
  995, // POP3S
  1433, // SQL Server
  1521, // Oracle
  3306, // MySQL
  5432, // PostgreSQL
  6379, // Redis
  9200, // Elasticsearch
  27017, // MongoDB
];

export interface UrlValidationResult {
  isValid: boolean;
  error?: string;
  normalizedUrl?: string;
}

export function validateMcpServerUrl(urlString: string): UrlValidationResult {
  if (!urlString || typeof urlString !== "string") {
    return {
      isValid: false,
      error: "URL is required and must be a string",
    };
  }

  let url: URL;
  try {
    url = new URL(urlString.trim());
  } catch (error) {
    return {
      isValid: false,
      error: "Invalid URL format",
    };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return {
      isValid: false,
      error: "Only HTTP and HTTPS protocols are allowed",
    };
  }

  const hostname = url.hostname.toLowerCase();

  // Check if hostname is explicitly blocked (always checked)
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    return {
      isValid: false,
      error: `Hostname '${hostname}' is not allowed for security reasons`,
    };
  }

  // In development mode, allow localhost and other dev-safe hostnames
  const isDevelopmentSafeHostname =
    IS_DEVELOPMENT && DEV_SAFE_HOSTNAMES.includes(hostname);

  // Check private IPs (skip in development for safe hostnames)
  if (!isDevelopmentSafeHostname) {
    if (isIPv4(hostname)) {
      for (const range of PRIVATE_IP_RANGES) {
        if (range.test(hostname)) {
          // In development, allow 127.0.0.1 (localhost)
          if (IS_DEVELOPMENT && hostname.startsWith("127.")) {
            logger.debug(`Allowing localhost IP in development: ${hostname}`);
          } else {
            return {
              isValid: false,
              error: `Private IP addresses are not allowed: ${hostname}`,
            };
          }
        }
      }
    }

    if (isIPv6(hostname)) {
      for (const range of PRIVATE_IPV6_RANGES) {
        if (range.test(hostname)) {
          // In development, allow ::1 (localhost)
          if (IS_DEVELOPMENT && hostname === "::1") {
            logger.debug(`Allowing localhost IPv6 in development: ${hostname}`);
          } else {
            return {
              isValid: false,
              error: `Private IPv6 addresses are not allowed: ${hostname}`,
            };
          }
        }
      }
    }
  } else {
    logger.debug(`Allowing development-safe hostname: ${hostname}`);
  }

  if (url.port) {
    const port = Number.parseInt(url.port, 10);
    if (BLOCKED_PORTS.includes(port)) {
      return {
        isValid: false,
        error: `Port ${port} is not allowed for security reasons`,
      };
    }
  }

  if (url.toString().length > 2048) {
    return {
      isValid: false,
      error: "URL is too long (maximum 2048 characters)",
    };
  }

  if (url.protocol === "https:" && url.port === "80") {
    return {
      isValid: false,
      error: "HTTPS URLs should not use port 80",
    };
  }

  if (url.protocol === "http:" && url.port === "443") {
    return {
      isValid: false,
      error: "HTTP URLs should not use port 443",
    };
  }

  logger.debug(`Validated MCP server URL: ${hostname}`);

  return {
    isValid: true,
    normalizedUrl: url.toString(),
  };
}

function isIPv4(hostname: string): boolean {
  const ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipv4Regex.test(hostname);
}

function isIPv6(hostname: string): boolean {
  const cleanHostname = hostname.replace(/^\[|\]$/g, "");

  const ipv6Regex =
    /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::$|^::1$|^(?:[0-9a-fA-F]{1,4}:)*::[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*$/;

  return ipv6Regex.test(cleanHostname);
}
