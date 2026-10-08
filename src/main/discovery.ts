import { Bonjour, Browser, Service } from 'bonjour-service';
import { MDNS_SERVICE_NAME } from '../protocol/types.ts';
import type { DiscoveredRoom } from '../protocol/types.ts';

export class DiscoveryManager {
  private bonjour = new Bonjour();
  private publishedService: Service | null = null;
  private browser: Browser | null = null;
  private onRoomFoundCallback: (rooms: DiscoveredRoom[]) => void;
  private discoveredMap = new Map<string, DiscoveredRoom>();
  private roomIdByService = new Map<string, string>();

  constructor(onRoomFound: (rooms: DiscoveredRoom[]) => void) {
    this.onRoomFoundCallback = onRoomFound;
  }

  public startAdvertising(room: DiscoveredRoom) {
    this.stopAdvertising();
    this.publishedService = this.bonjour.publish({
      name: `${room.roomName}_${room.roomId.substring(0, 6)}`,
      type: MDNS_SERVICE_NAME,
      port: room.hostPort,
      txt: {
        roomId: room.roomId,
        roomName: room.roomName,
        hostName: room.hostName,
        epoch: room.epoch.toString(),
        isRoom: room.isRoom ? 'true' : 'false'
      }
    });
  }

  public stopAdvertising() {
    if (this.publishedService) {
      this.bonjour.unpublishAll();
      this.publishedService = null;
    }
  }

  public startBrowsing() {
    if (this.browser) return;

    this.discoveredMap.clear();
    this.roomIdByService.clear();
    this.browser = this.bonjour.find({ type: MDNS_SERVICE_NAME }, (service) => {
      this.addOrUpdateRoom(service);
    });

    this.browser.on('down', (service) => {
      const roomId = this.roomIdByService.get(service.fqdn) || service.txt?.roomId;
      this.roomIdByService.delete(service.fqdn);
      if (roomId && this.discoveredMap.delete(roomId)) {
        this.emitRooms();
      }
    });
  }

  public stopBrowsing() {
    this.browser?.stop();
    this.browser = null;
    this.discoveredMap.clear();
    this.roomIdByService.clear();
    this.bonjour.destroy();
  }

  private addOrUpdateRoom(service: Service) {
    const roomId = service.txt?.roomId;
    const roomName = service.txt?.roomName;
    const hostName = service.txt?.hostName;
    const hostPort = service.port;
    const ipv4 = service.addresses?.find((address) => address.includes('.')) || service.referer?.address;

    if (
      typeof roomId !== 'string' ||
      typeof roomName !== 'string' ||
      typeof hostName !== 'string' ||
      !ipv4 ||
      !Number.isInteger(hostPort) ||
      hostPort < 1 ||
      hostPort > 65535
    ) {
      return;
    }

    const epochValue = Number.parseInt(String(service.txt?.epoch || '1'), 10);
    const isRoom = service.txt?.isRoom === 'true';
    const room: DiscoveredRoom = {
      roomId,
      roomName,
      hostName,
      hostIp: ipv4,
      hostPort,
      epoch: Number.isFinite(epochValue) ? epochValue : 1,
      isRoom
    };

    this.roomIdByService.set(service.fqdn, roomId);
    this.discoveredMap.set(room.roomId, room);
    this.emitRooms();
  }

  private emitRooms() {
    this.onRoomFoundCallback(Array.from(this.discoveredMap.values()));
  }
}
