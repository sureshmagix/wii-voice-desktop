import os from 'os';
import type { NetworkInterfaceInfo } from '../protocol/types.ts';

const VIRTUAL_NAME_PATTERNS = [
  /docker/i,
  /veth/i,
  /virbr/i,
  /vmnet/i,
  /vbox/i,
  /tailscale/i,
  /utun/i,
  /tap/i,
  /tun/i,
  /wsl/i,
  /hyper-v/i,
  /vethernet/i,
  /^br-/i
];

function isVirtualInterface(name: string): boolean {
  return VIRTUAL_NAME_PATTERNS.some(regex => regex.test(name));
}

function scoreIp(ip: string, name: string): number {
  let score = 0;
  if (!isVirtualInterface(name)) score += 50;
  if (/^(en|eth|wlan|wi-fi|ethernet)/i.test(name)) score += 30;

  if (ip.startsWith('192.168.')) score += 40;
  else if (ip.startsWith('10.')) score += 30;
  else if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) score += 20;

  return score;
}

export function getAllIPv4Interfaces(): NetworkInterfaceInfo[] {
  const result: NetworkInterfaceInfo[] = [];
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (!iface.address.startsWith('169.254.') && !iface.address.startsWith('127.')) {
          result.push({
            name,
            address: iface.address,
            family: iface.family,
            isInternal: iface.internal
          });
        }
      }
    }
  }

  // Sort best candidate first
  result.sort((a, b) => scoreIp(b.address, b.name) - scoreIp(a.address, a.name));
  return result;
}

export function getLocalIPv4(): string {
  const all = getAllIPv4Interfaces();
  return all.length > 0 ? all[0].address : '127.0.0.1';
}

