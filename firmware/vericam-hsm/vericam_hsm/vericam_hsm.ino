// VeriCam-HSM: ESP32-C3 + RC522 BLE bridge for MIFARE Classic 1K (S50).
//
// Capture: phone arms CAPTURE -> card tapped -> read UID + blocks 4,5 (32 B)
//   -> notify phone -> phone streams 25 frames into SHA-256 chain -> phone
//   writes 32 B digest -> burned into blocks 4,5 IF it arrives within
//   WINDOW_MS of the card read and the card never left the field.
// Verify:  phone arms VERIFY -> card tapped -> read UID + blocks 4,5 -> notify.
//
// BLE protocol (service 7e1a0001-...):
//   CMD  (0002, write)  : [0x00]=disarm [0x01]=arm capture [0x02]=arm verify
//   EVT  (0003, notify) :
//     0x10 CARD  [0x10][mode][uidLen][uid x10][data x32][windowMs u16 LE]  (47 B)
//     0x11 OK    [0x11][tDigest u16 LE][tTotal u16 LE]
//     0x12 FAIL  [0x12][reason]  1=deadline 2=auth/read 3=write 4=readback 5=not waiting
//     0x13 ARMED [0x13][mode]
//   DIG  (0004, write)  : 32-byte digest

#include <SPI.h>
#include <MFRC522.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define PIN_SS   7
#define PIN_SCK  4
#define PIN_MOSI 6
#define PIN_MISO 5
#define PIN_RST  3

#define WINDOW_MS 1500   // active RF session window for the digest burn
#define BLK_A 4
#define BLK_B 5
#define BLK_TRAILER 7

#define SVC_UUID "7e1a0001-5c3b-4c6e-9f2a-0e5a1c0de001"
#define CMD_UUID "7e1a0002-5c3b-4c6e-9f2a-0e5a1c0de001"
#define EVT_UUID "7e1a0003-5c3b-4c6e-9f2a-0e5a1c0de001"
#define DIG_UUID "7e1a0004-5c3b-4c6e-9f2a-0e5a1c0de001"

enum : uint8_t { MODE_IDLE = 0, MODE_CAPTURE = 1, MODE_VERIFY = 2 };
enum : uint8_t { EV_CARD = 0x10, EV_OK = 0x11, EV_FAIL = 0x12, EV_ARMED = 0x13 };
enum : uint8_t { R_DEADLINE = 1, R_AUTH = 2, R_WRITE = 3, R_READBACK = 4, R_NOTWAIT = 5 };

MFRC522 rfid(PIN_SS, PIN_RST);
MFRC522::MIFARE_Key keyA;

BLECharacteristic *evtChr;
volatile bool connected = false;
volatile uint8_t armed = MODE_IDLE;
volatile bool waitingDigest = false;
volatile bool digestReady = false;
uint8_t digest[32];
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

static void notify(const uint8_t *p, size_t n) {
  if (!connected) return;
  evtChr->setValue((uint8_t *)p, n);
  evtChr->notify();
}
static void sendFail(uint8_t r) { uint8_t p[2] = {EV_FAIL, r}; notify(p, 2); }

class SrvCb : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { connected = true; }
  void onDisconnect(BLEServer *) override {
    connected = false; armed = MODE_IDLE; waitingDigest = false;
    BLEDevice::startAdvertising();
  }
};

class CmdCb : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    auto v = c->getValue();
    if (v.length() < 1) return;
    uint8_t m = (uint8_t)v[0];
    if (m > MODE_VERIFY) return;
    armed = m;
    uint8_t p[2] = {EV_ARMED, m};
    notify(p, 2);
  }
};

class DigCb : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    auto v = c->getValue();
    if (v.length() != 32) return;
    if (!waitingDigest) { sendFail(R_NOTWAIT); return; }
    portENTER_CRITICAL(&mux);
    memcpy(digest, (const uint8_t *)v.c_str(), 32);
    digestReady = true;
    portEXIT_CRITICAL(&mux);
  }
};

static void endCard() {
  rfid.PICC_HaltA();       // halted card ignores REQA until it leaves the field
  rfid.PCD_StopCrypto1();
}

// REQA ignores a halted card; WUPA re-selects one still held in the field, so
// back-to-back chained capture segments don't need a lift-and-re-tap.
static bool cardPresent() {
  if (rfid.PICC_IsNewCardPresent()) return true;
  byte atqa[2], size = sizeof(atqa);
  return rfid.PICC_WakeupA(atqa, &size) == MFRC522::STATUS_OK;
}

static bool authSector1() {
  return rfid.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A, BLK_TRAILER, &keyA,
                               &rfid.uid) == MFRC522::STATUS_OK;
}

static bool readBlocks(uint8_t out[32]) {
  uint8_t buf[18]; uint8_t len;
  len = sizeof(buf);
  if (rfid.MIFARE_Read(BLK_A, buf, &len) != MFRC522::STATUS_OK) return false;
  memcpy(out, buf, 16);
  len = sizeof(buf);
  if (rfid.MIFARE_Read(BLK_B, buf, &len) != MFRC522::STATUS_OK) return false;
  memcpy(out + 16, buf, 16);
  return true;
}

void setup() {
  Serial.begin(115200);
  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_SS);
  rfid.PCD_Init();
  rfid.PCD_SetAntennaGain(MFRC522::RxGain_max);
  for (int i = 0; i < 6; i++) keyA.keyByte[i] = 0xFF;
  Serial.print("RC522 version: 0x");
  Serial.println(rfid.PCD_ReadRegister(MFRC522::VersionReg), HEX);

  BLEDevice::init("VeriCam-HSM");
  BLEDevice::setMTU(185);
  BLEServer *srv = BLEDevice::createServer();
  srv->setCallbacks(new SrvCb());
  BLEService *svc = srv->createService(SVC_UUID);
  BLECharacteristic *cmd = svc->createCharacteristic(
      CMD_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  cmd->setCallbacks(new CmdCb());
  evtChr = svc->createCharacteristic(EVT_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  evtChr->addDescriptor(new BLE2902());
  BLECharacteristic *dig = svc->createCharacteristic(
      DIG_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  dig->setCallbacks(new DigCb());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("VeriCam-HSM advertising");
}

void loop() {
  uint8_t mode = armed;
  if (mode == MODE_IDLE) { delay(5); return; }
  if (!cardPresent() || !rfid.PICC_ReadCardSerial()) { delay(2); return; }

  uint32_t t0 = millis();
  uint8_t data[32];
  if (!authSector1() || !readBlocks(data)) { sendFail(R_AUTH); endCard(); return; }

  digestReady = false;
  waitingDigest = (mode == MODE_CAPTURE);

  uint8_t p[47] = {0};
  p[0] = EV_CARD; p[1] = mode;
  p[2] = rfid.uid.size > 10 ? 10 : rfid.uid.size;
  memcpy(p + 3, rfid.uid.uidByte, p[2]);
  memcpy(p + 13, data, 32);
  p[45] = WINDOW_MS & 0xFF; p[46] = WINDOW_MS >> 8;
  notify(p, sizeof(p));
  Serial.printf("card mode=%u uidLen=%u\n", mode, p[2]);

  if (mode == MODE_VERIFY) { armed = MODE_IDLE; endCard(); return; }

  // CAPTURE: hold the RF session open, wait for the digest inside the window.
  while (!digestReady && millis() - t0 < WINDOW_MS && connected) delay(1);
  waitingDigest = false;
  armed = MODE_IDLE;
  if (!digestReady) { sendFail(R_DEADLINE); endCard(); Serial.println("deadline miss"); return; }

  uint16_t tDig = millis() - t0;
  uint8_t d[32];
  portENTER_CRITICAL(&mux); memcpy(d, digest, 32); portEXIT_CRITICAL(&mux);

  if (rfid.MIFARE_Write(BLK_A, d, 16) != MFRC522::STATUS_OK ||
      rfid.MIFARE_Write(BLK_B, d + 16, 16) != MFRC522::STATUS_OK) {
    sendFail(R_WRITE); endCard(); Serial.println("write fail"); return;
  }
  uint8_t back[32];
  if (!readBlocks(back) || memcmp(back, d, 32) != 0) {
    sendFail(R_READBACK); endCard(); Serial.println("readback fail"); return;
  }
  uint16_t tTot = millis() - t0;
  uint8_t ok[5] = {EV_OK, (uint8_t)(tDig & 0xFF), (uint8_t)(tDig >> 8),
                   (uint8_t)(tTot & 0xFF), (uint8_t)(tTot >> 8)};
  notify(ok, 5);
  Serial.printf("burned: digest@%ums total %ums\n", tDig, tTot);
  endCard();
}
