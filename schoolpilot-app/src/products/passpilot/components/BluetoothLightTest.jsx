import { useState } from 'react';
import { Button } from '../../../components/ui/button';

const serviceId = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const receiveId = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const transmitId = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

async function receiveGreeting(characteristic) {
  const decoder = new TextDecoder();
  let partial = '';
  let finish;
  let timer;
  const greeted = new Promise(resolve => { finish = resolve; });

  function onNotification(event) {
    const lines = (partial + decoder.decode(event.target.value, { stream: true })).split('\n');
    partial = lines.pop().slice(-32);
    if (lines.some(line => /^H,[0-9a-f]{16}\r?$/i.test(line))) finish(true);
  }

  characteristic.addEventListener('characteristicvaluechanged', onNotification);
  try {
    await characteristic.startNotifications();
    timer = setTimeout(() => finish(false), 8000);
    return await greeted;
  } finally {
    clearTimeout(timer);
    characteristic.removeEventListener('characteristicvaluechanged', onNotification);
  }
}

export default function BluetoothLightTest() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function connect() {
    if (!window.isSecureContext || !navigator.bluetooth?.requestDevice) {
      setStatus('Browser Bluetooth is unavailable on this Chromebook.');
      return;
    }

    setBusy(true);
    setStatus('Choose your PassPilot light in Chrome.');
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'PP-Light-', services: [serviceId] }],
      });
      setStatus('Checking the light’s Bluetooth connection…');
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(serviceId);
      const characteristics = await service.getCharacteristics();
      const receiver = characteristics.find(item => item.uuid === receiveId);
      const transmitter = characteristics.find(item => item.uuid === transmitId);
      if (!receiver?.properties.write || !transmitter?.properties.notify) {
        throw new Error('The selected device did not expose the expected light controls.');
      }
      const greeted = await receiveGreeting(transmitter);
      setStatus(greeted
        ? 'Bluetooth test passed. This Chromebook received a response from the light.'
        : 'Chrome connected, but the light did not respond. Restart the light and try again.');
    } catch (error) {
      setStatus('Bluetooth test stopped. ' + (error?.message || 'Try connecting again.'));
    } finally {
      if (device?.gatt.connected) device.gatt.disconnect();
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-5" aria-label="Bluetooth connection test">
      <h2 className="text-lg font-medium">Bluetooth connection test</h2>
      <p className="text-sm text-muted-foreground">Turn on the light and select it in Chrome to test this Chromebook’s connection.</p>
      <Button type="button" onClick={connect} disabled={busy}>Connect light</Button>
      <p role="status" className="text-sm">{status}</p>
    </section>
  );
}
