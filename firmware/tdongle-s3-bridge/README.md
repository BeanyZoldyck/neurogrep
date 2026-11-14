# T-Dongle-S3 USB-NCM Wi-Fi bridge

Makes the dongle the Raspberry Pi's **network adapter**. Plug it into the Pi and
the Pi gets a normal Ethernet interface, a DHCP lease from your actual router, and
its own LAN address — no NAT, no double translation, and no software installed on
the Pi.

```
   [ Wi-Fi ] ~~~ 2.4 GHz ~~~ [ T-Dongle-S3 ] === USB NCM === [ Raspberry Pi 5 ]
        router                 L2 bridge                   usb0, DHCP from router
```

The ESP bridges raw layer-2 frames between its Wi-Fi station interface and a USB
NCM interface (`esp_wifi_internal_tx` in one direction, `tinyusb_net_send_sync` in
the other), so the Pi's own MAC address is what appears on the LAN. That's why the
Pi keeps its hostname and gets an address in your normal subnet.

Built on ESP-IDF's `tusb_ncm` example, which is the only supported way to get this
(NCM + a raw Wi-Fi frame path); the Arduino core's TinyUSB build has no NCM class.

## What the screen shows

- `ONLINE` / `OFFLINE` for the Wi-Fi association, with the disconnect reason
  (`no 2.4GHz AP`, `auth failed`, `bad password?`, ...).
- `PI 192.168.1.57` — the address the Pi got. The ESP is a bridge and has no IP of
  its own, so this is recovered by watching the DHCP reply pass from Wi-Fi to USB.
  Until that happens it says `PI waiting for DHCP`.
- `CH 6 -62dBm 12/s` — channel, signal and packets/second forwarded to the Pi.
- `PI` indicator top right — the Pi has enumerated the USB device (kernel up).
- `UP HH:MM:SS` and a one-second sweep bar that stops if the loop hangs.

## Flashing

First flash (from the Arduino firmware or factory image) auto-resets normally:

```sh
./flash.sh
```

**After that the USB pins belong to the OTG controller**, so esptool can no longer
reset the chip over CDC. To reflash: hold **BOOT**, plug the dongle in, release
BOOT, then run `./flash.sh` again (esptool talks to the ROM loader instead).

## Verify the panel without looking at it

```sh
./flash.sh display    # display-only build, console stays on USB-Serial/JTAG
python3 ../tdongle-s3/capture.py /dev/ttyACM0 dump.txt
python3 ../tdongle-s3/decode_frame.py dump.txt screen.png
```

Send `1` or `2` to switch between the synthetic online and offline states. The
panel driver, font and layout are identical in both builds, so this verifies what
the bridge image renders.

## Configuration

Credentials live in `main/secrets.h` (gitignored, same file name the Arduino
sketch uses). `secrets.h.example` is the template. `CONFIG_APP_BRIDGE_MODE` in
`main/Kconfig.projbuild` selects bridge vs display-only.

## Caveats, honestly

- **2.4 GHz only.** The S3 radio cannot see 5 GHz. With one SSID on both bands it
  joins the 2.4 GHz radio, which caps throughput (expect roughly 5-15 Mbps, and
  the USB side is full-speed 12 Mbps).
- **The dongle becomes a single point of failure for the Pi's network.** If the
  ESP resets or the AP drops, the Pi loses its link.
- **Some APs dislike multiple MACs behind one station.** Client isolation, MAC
  filtering or strict DHCP snooping can stop the Pi from getting a lease; the
  screen then sits at `PI waiting for DHCP` even though Wi-Fi is `ONLINE`.
- **Power.** Bridging + Wi-Fi peaks around 350-400 mA; a Pi 5 port handles that.
- Flashing requires the BOOT button from then on (see above).
