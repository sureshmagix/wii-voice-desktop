export const PROTOCOL_VERSION = '1.0.0';
export const MDNS_SERVICE_NAME = 'wii-voice';

export type ClientPlatform = 'desktop' | 'mobile';

export interface PeerInfo {
  deviceId: string;
  deviceName: string;
  platform: ClientPlatform;
  isPluggedIn: boolean;
  lanIp: string;
  signalingPort: number;
  joinedAt: number;
}

export interface DiscoveredRoom {
  roomId: string;
  roomName: string;
  hostName: string;
  hostIp: string;
  hostPort: number;
  epoch: number;
  isRoom?: boolean;
}

export type SignalingMessage =
  | { type: 'JOIN_REQUEST'; peer: PeerInfo }
  | { type: 'ROOM_STATE'; hostId: string; epoch: number; peers: PeerInfo[] }
  | { type: 'SDP_OFFER'; from: string; to: string; sdp: string }
  | { type: 'SDP_ANSWER'; from: string; to: string; sdp: string }
  | { type: 'ICE_CANDIDATE'; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: 'PEER_LEFT'; peerId: string }
  // Direct Calling & Call Control Messages:
  | { type: 'CALL_INVITE'; callId: string; caller: PeerInfo; targetDeviceId?: string }
  | { type: 'CALL_RINGING'; callId: string; recipient: PeerInfo }
  | { type: 'CALL_ACCEPTED'; callId: string; recipient: PeerInfo }
  | { type: 'CALL_DECLINED'; callId: string; recipient: PeerInfo; reason?: string }
  | { type: 'CALL_CANCELLED'; callId: string; caller: PeerInfo }
  | { type: 'CALL_HANGUP'; callId: string; peerId: string; reason?: string }
  | { type: 'PING' }
  | { type: 'PONG' };

export type DataChannelMessage =
  | { type: 'PING' }
  | { type: 'PONG' }
  | { type: 'PEER_MUTED'; peerId: string; isMuted: boolean }
  | { type: 'HOST_FAILOVER'; newHostId: string; epoch: number };

export interface Contact {
  id: string;
  name: string;
  ip: string;
  port: number;
  note?: string;
  updatedAt: number;
}

export interface CallHistoryItem {
  id: string;
  peerName: string;
  peerIp: string;
  peerPort: number;
  timestamp: number;
  durationSeconds: number;
  callType: 'direct-outgoing' | 'direct-incoming' | 'hosted-room' | 'joined-room' | 'test-call';
  status: 'completed' | 'missed' | 'declined' | 'failed';
}

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  family: string;
  isInternal: boolean;
}

