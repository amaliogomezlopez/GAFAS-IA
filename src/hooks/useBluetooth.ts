import { useEffect, useState, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import { BluetoothService } from '../services/bluetooth';
import { useAppStore } from '../stores';
import { LogService } from '../services/LogService';

export function useBluetooth() {
  const setBluetoothStatus = useAppStore((s) => s.setBluetoothStatus);
  const settings = useAppStore((s) => s.settings);
  const [isScanning, setIsScanning] = useState(false);
  const [isAutoConnecting, setIsAutoConnecting] = useState(false);
  const [bleAvailable, setBleAvailable] = useState(false);
  const settingsRef = useRef(settings);
  const autoConnectInFlightRef = useRef(false);
  const suppressAutoConnectUntilRef = useRef(0);
  settingsRef.current = settings;

  useEffect(() => {
    const attemptAutoConnect = async (reason: string) => {
      const activeSettings = settingsRef.current;
      const status = BluetoothService.getBluetoothStatus();
      if (
        autoConnectInFlightRef.current ||
        Date.now() < suppressAutoConnectUntilRef.current ||
        status.isConnected ||
        !status.bleAvailable ||
        !activeSettings.autoConnectBluetooth ||
        !activeSettings.autoScanBluetoothOnLaunch
      ) {
        return;
      }

      autoConnectInFlightRef.current = true;
      setIsAutoConnecting(true);
      try {
        LogService.info('BLE', `Auto-connect attempt (${reason})`);
        const autoConnected = await BluetoothService.tryAutoConnect(activeSettings.bluetoothAutoScanDurationMs);
        if (autoConnected) {
          const newStatus = BluetoothService.getBluetoothStatus();
          setBluetoothStatus(newStatus.isConnected, newStatus.deviceName, newStatus.battery);
          LogService.info('BLE', `Auto-connected to ${newStatus.deviceName}`);
        }
      } finally {
        autoConnectInFlightRef.current = false;
        setIsAutoConnecting(false);
      }
    };

    BluetoothService.initialize().then(async () => {
      const status = BluetoothService.getBluetoothStatus();
      setBluetoothStatus(status.isConnected, status.deviceName, status.battery);
      setBleAvailable(status.bleAvailable);
      await attemptAutoConnect('launch');
    });

    const unsubStatus = BluetoothService.onStatusChange((connected, deviceName, battery) => {
      setBluetoothStatus(connected, deviceName, battery);
      const status = BluetoothService.getBluetoothStatus();
      setBleAvailable(status.bleAvailable);
      if (!connected && status.bleAvailable) {
        attemptAutoConnect('state-change').catch((error) => {
          LogService.warn('BLE', `Auto-connect after state change failed: ${error}`);
        });
      }
    });

    const interval = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      attemptAutoConnect('watcher').catch((error) => {
        LogService.warn('BLE', `Auto-connect watcher failed: ${error}`);
      });
    }, Math.max(3500, settingsRef.current.bluetoothAutoReconnectIntervalMs));

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        attemptAutoConnect('app-active').catch((error) => {
          LogService.warn('BLE', `Auto-connect on app-active failed: ${error}`);
        });
      }
    });

    return () => {
      clearInterval(interval);
      appStateSub.remove();
      unsubStatus();
      BluetoothService.cleanup();
    };
  }, [setBluetoothStatus]);

  useEffect(() => {
    BluetoothService.setAutoReconnect(settings.autoConnectBluetooth);
  }, [settings.autoConnectBluetooth]);

  const scanForDevices = useCallback(async () => {
    setIsScanning(true);
    try {
      const devices = await BluetoothService.startScan();
      return devices;
    } finally {
      setIsScanning(false);
    }
  }, []);

  const connectToDevice = useCallback(async (deviceId: string) => {
    const success = await BluetoothService.connectToDevice(deviceId);
    return success;
  }, []);

  const disconnect = useCallback(async () => {
    suppressAutoConnectUntilRef.current = Date.now() + 15000;
    await BluetoothService.disconnect();
  }, []);

  return {
    notifyButtonPress: () => BluetoothService.notifyButtonPress(),
    scanForDevices,
    connectToDevice,
    disconnect,
    isScanning,
    isAutoConnecting,
    bleAvailable,
  };
}
