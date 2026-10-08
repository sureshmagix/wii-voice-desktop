import { PeerInfo } from './types.ts';

export function electLeader(peers: PeerInfo[]): PeerInfo {
  if (peers.length === 0) throw new Error('Cannot elect leader from empty peer list');

  return [...peers].sort((a, b) => {
    const platformDifference = Number(b.platform === 'desktop') - Number(a.platform === 'desktop');
    if (platformDifference !== 0) return platformDifference;

    const powerDifference = Number(b.isPluggedIn) - Number(a.isPluggedIn);
    if (powerDifference !== 0) return powerDifference;

    if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
    return a.deviceId.localeCompare(b.deviceId);
  })[0];
}
