"""Reader-disconnected BLE smoke test. Install bleak, then run this file."""
import asyncio
from bleak import BleakClient, BleakScanner

SERVICE = "f3641400-00b0-4240-ba50-05ca45bf8abc"
COMMAND = "f3641401-00b0-4240-ba50-05ca45bf8abc"
STATE = "f3641402-00b0-4240-ba50-05ca45bf8abc"


async def main():
    device = await BleakScanner.find_device_by_filter(
        lambda device, advertisement: SERVICE in advertisement.service_uuids,
        timeout=12,
    )
    if device is None:
        raise RuntimeError("VeriCam advertisement not found")
    print("Discovered:", device)
    async with BleakClient(device) as client:
        initial = await client.read_gatt_char(STATE)
        assert len(initial) == 54 and initial[0] == 1
        await client.write_gatt_char(COMMAND, b"R\x01\x02\x03\x04", response=True)
        for _ in range(20):
            state = await client.read_gatt_char(STATE)
            if state[4:8] == bytes([1, 2, 3, 4]) and state[1] == 128:
                print("PASS: GATT read/write and missing-reader error")
                return
            await asyncio.sleep(0.1)
        raise RuntimeError(f"Expected disconnected-reader error, got {state.hex()}")


if __name__ == "__main__":
    asyncio.run(main())
