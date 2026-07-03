/**
 * BluetoothService - Real BLE support via react-native-ble-plx
 *
 * Scans for AiMB-S1 smart glasses, connects, monitors battery,
 * and provides button press events. Falls back to UI-only mode
 * if BLE is unavailable (e.g., Expo Go without dev client).
 */
import { BleManager, Device, State, BleError, Characteristic, Subscription } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LogService } from '../LogService';

export type GlassesButtonKind = 'generic' | 'photo' | 'video' | 'unknown';

export type GlassesButtonEvent = {
  id: string;
  timestamp: number;
  source: 'ble' | 'manual';
  kind: GlassesButtonKind;
  deviceId: string | null;
  serviceUuid: string | null;
  characteristicUuid: string;
  base64: string;
  bytes: number[];
  decimal: string;
  hex: string;
  ascii: string;
  signature: string;
};

type ButtonCallback = (event: GlassesButtonEvent) => void;
type ButtonEventCallback = (event: GlassesButtonEvent) => void;
type StatusCallback = (connected: boolean, deviceName: string | null, battery: number | null) => void;

const GLASSES_NAME_PREFIXES = ['AiMB-S1', 'AiMB', 'AIMB', 'Aimbee', 'Smart', 'Glasses'];
const BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL_CHAR_UUID = '00002a19-0000-1000-8000-00805f9b34fb';
const RECONNECT_DELAY_MS = 2500;
const SCAN_DURATION_MS = 12000;
const BUTTON_EVENT_HISTORY_LIMIT = 160;

/** Common BLE service UUIDs to search for connected peripherals */
const KNOWN_SERVICE_UUIDS = [
  '00001800-0000-1000-8000-00805f9b34fb', // Generic Access
  '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
  BATTERY_SERVICE_UUID,                     // Battery Service
  '0000ffe0-0000-1000-8000-00805f9b34fb', // Common custom serial/control
];
const SAVED_DEVICE_KEY = 'ble_last_device_id';

function bytesToHex(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function bytesToAscii(bytes: number[]): string {
  return bytes
    .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'))
    .join('');
}

function makeButtonSignature(serviceUuid: string | null, characteristicUuid: string, bytes: number[]): string {
  const service = (serviceUuid || 'unknown-service').toLowerCase();
  const characteristic = characteristicUuid.toLowerCase();
  return `${service}|${characteristic}|${bytesToHex(bytes)}`;
}

function isMatchingGlasses(device: Device | null | undefined, preferredId?: string | null): boolean {
  if (!device) return false;
  if (preferredId && device.id === preferredId) return true;
  if (!device.name) return false;
  const normalized = device.name.toUpperCase();
  return GLASSES_NAME_PREFIXES.some((prefix) => normalized.startsWith(prefix.toUpperCase()));
}

class BluetoothServiceClass {
  private subscribers: ButtonCallback[] = [];
  private buttonEventSubscribers: ButtonEventCallback[] = [];
  private statusSubscribers: StatusCallback[] = [];
  private manager: BleManager | null = null;
  private _isConnected: boolean = false;
  private _deviceName: string | null = null;
  private _battery: number | null = null;
  private _connectedDevice: Device | null = null;
  private _isScanning: boolean = false;
  private _bleAvailable: boolean = false;
  private _autoReconnect: boolean = true;
  private _scanTimeout: ReturnType<typeof setTimeout> | null = null;
  private _notifSubs: Subscription[] = [];
  private _lastButtonAt: number = 0;
  private _buttonEventHistory: GlassesButtonEvent[] = [];

  async initialize(): Promise<void> {
    try {
      if (this.manager) return;

      this.manager = new BleManager({
        restoreStateIdentifier: 'smartglasses-ble-central',
        restoreStateFunction: (restoredState) => {
          const restoredDevice = restoredState?.connectedPeripherals?.find((device) => isMatchingGlasses(device));
          if (restoredDevice) {
            LogService.info('BLE', `Restored connected peripheral: ${restoredDevice.name || restoredDevice.id}`);
            this.connectToDevice(restoredDevice.id).catch((error) => {
              LogService.warn('BLE', `Restore reconnect failed: ${error}`);
            });
          }
        },
      });

      const state = await this.manager.state();
      console.log('[BLE] Manager state:', state);

      if (state === State.PoweredOn) {
        this._bleAvailable = true;
        console.log('[BLE] Bluetooth is powered on, ready to scan');
      }

      // Always listen for state changes — even when already PoweredOn
      this.manager.onStateChange((newState) => {
        console.log('[BLE] State changed:', newState);
        const was = this._bleAvailable;
        this._bleAvailable = newState === State.PoweredOn;
        if (was !== this._bleAvailable) {
          this.notifyStatusChange();
        }
      }, true);
    } catch (error) {
      console.warn('[BLE] BLE not available:', error);
      this._bleAvailable = false;
    }
  }

  async startScan(): Promise<Device[]> {
    if (!this.manager || !this._bleAvailable) {
      console.warn('[BLE] Cannot scan: BLE not available');
      return [];
    }
    if (this._isScanning) {
      console.warn('[BLE] Already scanning');
      return [];
    }

    this._isScanning = true;
    const foundDevices: Device[] = [];
    const deviceIds = new Set<string>();
    let savedId: string | null = null;

    // 1) Check already-connected BLE peripherals
    try {
      const connected = await this.manager.connectedDevices(KNOWN_SERVICE_UUIDS);
      for (const d of connected) {
        if (d.name && !deviceIds.has(d.id)) {
          deviceIds.add(d.id);
          foundDevices.push(d);
          console.log(`[BLE] Already connected: ${d.name} (${d.id})`);
        }
      }
    } catch (e) {
      console.log('[BLE] connectedDevices check failed:', e);
    }

    // 2) Check saved device from last successful connection
    try {
      savedId = await AsyncStorage.getItem(SAVED_DEVICE_KEY);
      if (savedId && !deviceIds.has(savedId)) {
        const known = await this.manager.devices([savedId]);
        for (const d of known) {
          if (!deviceIds.has(d.id)) {
            deviceIds.add(d.id);
            foundDevices.push(d);
            console.log(`[BLE] Known saved device: ${d.name || savedId} (${d.id})`);
          }
        }
      }
    } catch {}

    // 3) Active BLE scan for advertising devices
    console.log('[BLE] Starting active scan...');

    return new Promise((resolve) => {
      this._scanTimeout = setTimeout(() => {
        this.stopScan();
        resolve(foundDevices);
      }, SCAN_DURATION_MS);

      this.manager!.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error) {
          console.warn('[BLE] Scan error:', error.message);
          return;
        }
        if (device && !deviceIds.has(device.id) && isMatchingGlasses(device, savedId)) {
          deviceIds.add(device.id);
          foundDevices.push(device);
          console.log(`[BLE] Found: ${device.name} (${device.id})`);
        }
      });
    });
  }

  stopScan(): void {
    if (this._scanTimeout) {
      clearTimeout(this._scanTimeout);
      this._scanTimeout = null;
    }
    if (this.manager && this._isScanning) {
      this.manager.stopDeviceScan();
      this._isScanning = false;
      console.log('[BLE] Scan stopped');
    }
  }

  async connectToDevice(deviceId: string): Promise<boolean> {
    if (!this.manager || !this._bleAvailable) return false;

    try {
      this.stopScan();
      this._autoReconnect = true;
      LogService.info('BLE', `Connecting to ${deviceId}...`);

      const device = await this.manager.connectToDevice(deviceId, {
        timeout: 10000,
      });

      await device.discoverAllServicesAndCharacteristics();
      LogService.info('BLE', `Connected to ${device.name}`);

      this._connectedDevice = device;
      this._isConnected = true;
      this._deviceName = device.name || 'Unknown Device';

      // Persist device ID for future reconnection
      try { await AsyncStorage.setItem(SAVED_DEVICE_KEY, deviceId); } catch {}

      // Monitor disconnection
      device.onDisconnected((error, disconnectedDevice) => {
        LogService.warn('BLE', `Disconnected from ${disconnectedDevice?.name}: ${error?.message || 'user'}`);
        this._isConnected = false;
        this._connectedDevice = null;
        this._battery = null;
        this._cancelNotifSubs();
        this.notifyStatusChange();

        if (this._autoReconnect) {
          setTimeout(() => this.connectToDevice(deviceId), RECONNECT_DELAY_MS);
        }
      });

      // Discover and log all services + characteristics
      await this._discoverAndSubscribe(device);

      // Try to read battery level
      await this.readBatteryLevel(device);

      this.notifyStatusChange();
      return true;
    } catch (error) {
      const msg = error instanceof BleError ? error.message : String(error);
      LogService.error('BLE', `Connection failed: ${msg}`);
      this._isConnected = false;
      this._connectedDevice = null;
      this.notifyStatusChange();
      return false;
    }
  }

  /** Discover all services/characteristics, log them, and subscribe to NOTIFY chars */
  private async _discoverAndSubscribe(device: Device): Promise<void> {
    this._cancelNotifSubs();

    try {
      const services = await device.services();
      LogService.info('BLE', `Found ${services.length} services`);

      for (const svc of services) {
        LogService.debug('BLE', `Service: ${svc.uuid}`);
        try {
          const chars = await svc.characteristics();
          for (const ch of chars) {
            const props: string[] = [];
            if (ch.isReadable) props.push('R');
            if (ch.isWritableWithResponse) props.push('W');
            if (ch.isWritableWithoutResponse) props.push('Wn');
            if (ch.isNotifiable) props.push('N');
            if (ch.isIndicatable) props.push('I');
            LogService.debug('BLE', `  Char: ${ch.uuid} [${props.join(',')}]`);

            // Subscribe to all notifiable characteristics — button events come as notifications
            if (ch.isNotifiable) {
              LogService.info('BLE', `Subscribing to notifications: ${ch.uuid}`);
              const sub = ch.monitor((err, characteristic) => {
                if (err) {
                  LogService.warn('BLE', `Notification error ${ch.uuid}: ${err.message}`);
                  return;
                }
                if (characteristic?.value) {
                  const raw = atob(characteristic.value);
                  const bytes = Array.from(raw).map((c) => c.charCodeAt(0));
                  LogService.info('BLE', `Notification ${ch.uuid}: [${bytes.join(', ')}]`);
                  // Treat any notification from a non-battery char as button press
                  if (ch.uuid.toLowerCase() !== BATTERY_LEVEL_CHAR_UUID) {
                    const event = this.createButtonEvent(ch, characteristic, bytes);
                    LogService.info('BLE', `Button event ${event.signature}`);
                    this.notifyButtonPress(event);
                  }
                }
              });
              this._notifSubs.push(sub);
            }
          }
        } catch (e) {
          LogService.debug('BLE', `  Could not read chars for ${svc.uuid}`);
        }
      }
    } catch (e) {
      LogService.warn('BLE', `Service discovery failed: ${e}`);
    }
  }

  private _cancelNotifSubs(): void {
    this._notifSubs.forEach((s) => { try { s.remove(); } catch {} });
    this._notifSubs = [];
  }

  async disconnect(): Promise<void> {
    this._autoReconnect = false;
    if (this._connectedDevice) {
      try {
        await this._connectedDevice.cancelConnection();
      } catch {}
    }
    this._connectedDevice = null;
    this._isConnected = false;
    this._deviceName = null;
    this._battery = null;
    this.notifyStatusChange();
  }

  /** Try to auto-connect to a previously saved device or already-connected peripheral */
  async tryAutoConnect(scanDurationMs: number = 5000): Promise<boolean> {
    if (!this.manager || !this._bleAvailable || this._isConnected) return false;

    try {
      this._autoReconnect = true;
      const savedId = await AsyncStorage.getItem(SAVED_DEVICE_KEY);

      // 1) Check already-connected BLE peripherals (connected via iOS Settings)
      const connectedDevice = await this.findConnectedGlasses(savedId);
      if (connectedDevice) {
        LogService.info('BLE', `Auto-connect: found already-connected ${connectedDevice.name || connectedDevice.id}`);
        return this.connectToDevice(connectedDevice.id);
      }

      // 2) Try saved device ID from last successful connection
      if (savedId) {
        const known = await this.manager.devices([savedId]);
        for (const d of known) {
          if (d.id === savedId) {
            LogService.info('BLE', `Auto-connect: trying saved device ${d.name || savedId}`);
            return this.connectToDevice(d.id);
          }
        }
      }

      // 3) Short active scan in background for known glasses
      LogService.info('BLE', 'Auto-connect: running short background scan...');
      return this.autoConnectFromScan(savedId, scanDurationMs);
    } catch (e) {
      LogService.debug('BLE', `Auto-connect failed: ${e}`);
    }

    return false;
  }

  private async autoConnectFromScan(preferredId: string | null, durationMs: number): Promise<boolean> {
    if (!this.manager || this._isScanning) return false;

    return new Promise((resolve) => {
      let resolved = false;
      this._isScanning = true;

      const finish = (result: boolean) => {
        if (resolved) return;
        resolved = true;
        this.stopScan();
        resolve(result);
      };

      this._scanTimeout = setTimeout(() => finish(false), durationMs);

      this.manager!.startDeviceScan(null, { allowDuplicates: false }, async (error, device) => {
        if (error) {
          LogService.warn('BLE', `Auto-connect scan error: ${error.message}`);
          finish(false);
          return;
        }

        if (!isMatchingGlasses(device, preferredId)) return;

        LogService.info('BLE', `Auto-connect: found ${device?.name || device?.id}, connecting...`);
        finish(await this.connectToDevice(device!.id));
      });
    });
  }

  private async readBatteryLevel(device: Device): Promise<void> {
    try {
      const char = await device.readCharacteristicForService(
        BATTERY_SERVICE_UUID,
        BATTERY_LEVEL_CHAR_UUID,
      );
      if (char.value) {
        const raw = atob(char.value);
        this._battery = raw.charCodeAt(0);
        console.log(`[BLE] Battery level: ${this._battery}%`);
      }
    } catch {
      console.log('[BLE] Battery service not available on this device');
    }
  }

  // -- Pub/Sub for button presses --
  subscribe(callback: ButtonCallback): () => void {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter(cb => cb !== callback);
    };
  }

  subscribeButtonEvents(callback: ButtonEventCallback): () => void {
    this.buttonEventSubscribers.push(callback);
    return () => {
      this.buttonEventSubscribers = this.buttonEventSubscribers.filter(cb => cb !== callback);
    };
  }

  getButtonEventHistory(): GlassesButtonEvent[] {
    return [...this._buttonEventHistory];
  }

  clearButtonEventHistory(): void {
    this._buttonEventHistory = [];
  }

  onStatusChange(callback: StatusCallback): () => void {
    this.statusSubscribers.push(callback);
    return () => {
      this.statusSubscribers = this.statusSubscribers.filter(cb => cb !== callback);
    };
  }

  notifyButtonPress(event?: GlassesButtonEvent): void {
    const buttonEvent = event ?? this.createManualButtonEvent();
    this.recordButtonEvent(buttonEvent);
    const now = Date.now();
    if (now - this._lastButtonAt < 350) {
      LogService.debug('BLE', 'Ignoring duplicate button notification');
      return;
    }
    this._lastButtonAt = now;
    this.subscribers.forEach(cb => cb(buttonEvent));
  }

  private recordButtonEvent(event: GlassesButtonEvent): void {
    this._buttonEventHistory = [event, ...this._buttonEventHistory].slice(0, BUTTON_EVENT_HISTORY_LIMIT);
    this.buttonEventSubscribers.forEach(cb => cb(event));
  }

  private createManualButtonEvent(kind: GlassesButtonKind = 'generic'): GlassesButtonEvent {
    const timestamp = Date.now();
    return {
      id: `manual_${timestamp}`,
      timestamp,
      source: 'manual',
      kind,
      deviceId: this._connectedDevice?.id ?? null,
      serviceUuid: null,
      characteristicUuid: 'manual',
      base64: '',
      bytes: [],
      decimal: '',
      hex: '',
      ascii: '',
      signature: `manual|${kind}`,
    };
  }

  private createButtonEvent(
    characteristicDefinition: Characteristic,
    notification: Characteristic,
    bytes: number[],
  ): GlassesButtonEvent {
    const timestamp = Date.now();
    const serviceUuid = (
      notification.serviceUUID ||
      characteristicDefinition.serviceUUID ||
      null
    );
    const characteristicUuid = notification.uuid || characteristicDefinition.uuid;
    const signature = makeButtonSignature(serviceUuid, characteristicUuid, bytes);

    return {
      id: `${timestamp}_${signature}`,
      timestamp,
      source: 'ble',
      kind: 'unknown',
      deviceId: notification.deviceID || characteristicDefinition.deviceID || this._connectedDevice?.id || null,
      serviceUuid,
      characteristicUuid,
      base64: notification.value || characteristicDefinition.value || '',
      bytes,
      decimal: bytes.join(', '),
      hex: bytesToHex(bytes),
      ascii: bytesToAscii(bytes),
      signature,
    };
  }

  private async findConnectedGlasses(preferredId?: string | null): Promise<Device | null> {
    if (!this.manager) return null;
    const connected = await this.manager.connectedDevices(KNOWN_SERVICE_UUIDS);
    return connected.find((device) => isMatchingGlasses(device, preferredId)) ?? null;
  }

  setAutoReconnect(enabled: boolean): void {
    this._autoReconnect = enabled;
  }

  private notifyStatusChange(): void {
    this.statusSubscribers.forEach(cb =>
      cb(this._isConnected, this._deviceName, this._battery),
    );
  }

  getBluetoothStatus(): { isConnected: boolean; deviceName: string | null; battery: number | null; bleAvailable: boolean } {
    return {
      isConnected: this._isConnected,
      deviceName: this._deviceName,
      battery: this._battery,
      bleAvailable: this._bleAvailable,
    };
  }

  isScanning(): boolean {
    return this._isScanning;
  }

  setConnected(connected: boolean): void {
    this._isConnected = connected;
  }

  cleanup(): void {
    this._autoReconnect = false;
    this.stopScan();
    this._cancelNotifSubs();
    this.subscribers = [];
    this.buttonEventSubscribers = [];
    this.statusSubscribers = [];
    if (this._connectedDevice) {
      try { this._connectedDevice.cancelConnection(); } catch {}
    }
    if (this.manager) {
      this.manager.destroy();
      this.manager = null;
    }
  }
}

export const BluetoothService = new BluetoothServiceClass();
