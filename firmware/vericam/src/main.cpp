#include <Arduino.h>
#include <SPI.h>
#include <MFRC522.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include "network.h"

// AI-Thinker ESP32-CAM: SD slot must be empty; camera is not initialized.
MFRC522 rfid(13, 2);
MFRC522::MIFARE_Key key;
BLECharacteristic *stateChar;
QueueHandle_t commands;
struct Command { uint8_t size; uint8_t data[20]; };
uint8_t state[54] = {1}, digest[32], received = 0;
uint32_t started = 0, waiting = 0;
bool active = false, scanning = false;
volatile bool disconnected = false;
constexpr uint32_t WINDOW = 1100;

void publish(uint8_t status) {
  state[1] = status;
  uint32_t elapsed = active ? millis() - started : 0;
  memcpy(state + 8, &elapsed, 4);
  stateChar->setValue(state, sizeof(state));
  if (status == 3 || status == 4 || status >= 0x80) networkEvent(state);
}
void releaseCard() {
  rfid.PICC_HaltA(); rfid.PCD_StopCrypto1();
  active = scanning = false; received = 0;
}
void fail(uint8_t code) { publish(code); releaseCard(); }
bool readBlocks(uint8_t *out) {
  for (byte block = 4; block <= 5; ++block) {
    byte buffer[18], size = sizeof(buffer);
    if (rfid.MIFARE_Read(block, buffer, &size) != MFRC522::STATUS_OK) return false;
    memcpy(out + (block - 4) * 16, buffer, 16);
  }
  return true;
}
class Writer : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    auto value = c->getValue();
    if (value.empty() || value.size() > 20) return;
    Command cmd{}; cmd.size = value.size(); memcpy(cmd.data, value.data(), cmd.size);
    xQueueSend(commands, &cmd, 0);
  }
};
class ConnectionCallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer *) override { disconnected = true; }
};
void setup() {
  Serial.begin(115200);
  SPI.begin(14, 12, 15, 13);
  rfid.PCD_Init(); memset(key.keyByte, 0xff, 6);
  commands = xQueueCreate(8, sizeof(Command));
  BLEDevice::init("VeriCam-HSM");
  auto server = BLEDevice::createServer(); server->setCallbacks(new ConnectionCallbacks());
  auto service = server->createService("f3641400-00b0-4240-ba50-05ca45bf8abc");
  auto command = service->createCharacteristic("f3641401-00b0-4240-ba50-05ca45bf8abc", BLECharacteristic::PROPERTY_WRITE);
  command->setCallbacks(new Writer());
  stateChar = service->createCharacteristic("f3641402-00b0-4240-ba50-05ca45bf8abc", BLECharacteristic::PROPERTY_READ);
  publish(0); service->start();
  BLEDevice::getAdvertising()->addServiceUUID(service->getUUID());
  BLEDevice::getAdvertising()->setScanResponse(true);
  BLEDevice::startAdvertising();
  networkStart();
  Serial.printf("VeriCam ready; RC522 version: 0x%02x\n", rfid.PCD_ReadRegister(MFRC522::VersionReg));
}
void loop() {
  if (disconnected) {
    disconnected = false; releaseCard(); xQueueReset(commands); publish(0);
    BLEDevice::startAdvertising();
  }
  if (active && millis() - started > WINDOW) fail(0x83);
  if (scanning && millis() - waiting > 15000) fail(0x84);
  Command cmd;
  if (xQueueReceive(commands, &cmd, 0) == pdTRUE) {
    uint8_t op = cmd.data[0];
    if ((op == 'B' || op == 'R') && cmd.size == 5) {
      releaseCard(); memset(state, 0, sizeof(state)); state[0] = 1; state[3] = op;
      memcpy(state + 4, cmd.data + 1, 4);
      byte version = rfid.PCD_ReadRegister(MFRC522::VersionReg);
      if (version == 0 || version == 255) fail(0x80);
      else { scanning = true; waiting = millis(); publish(1); }
    } else if (op == 'X' && cmd.size == 5 && !memcmp(state + 4, cmd.data + 1, 4)) {
      releaseCard(); publish(0);
    } else if (op == 'C' && cmd.size == 20 && active && !memcmp(state + 4, cmd.data + 1, 4)) {
      // Three MTU-23-safe packets, offsets 0, 14, 28 (last two bytes padded).
      uint8_t offset = cmd.data[5];
      if (offset != received || offset > 28) { fail(0x85); return; }
      uint8_t count = min(14, 32 - int(offset));
      memcpy(digest + offset, cmd.data + 6, count); received += count;
      if (received == 32) {
        uint8_t check[32];
        if (millis() - started > WINDOW) { fail(0x83); return; }
        // Authenticate session remains selected: never reselect a replacement card.
        for (byte block = 4; block <= 5; ++block) {
          if (rfid.MIFARE_Write(block, digest + (block - 4) * 16, 16) != MFRC522::STATUS_OK) {
            fail(0x86); return; // A two-block EEPROM update is not atomic.
          }
        }
        if (!readBlocks(check) || memcmp(check, digest, 32)) { fail(0x86); return; }
        memcpy(state + 22, check, 32);
        publish(millis() - started <= WINDOW ? 3 : 0x87); releaseCard();
      }
    }
  }
  if (scanning && rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    scanning = false; started = millis(); active = true;
    if (rfid.PICC_GetType(rfid.uid.sak) != MFRC522::PICC_TYPE_MIFARE_1K) { fail(0x81); return; }
    state[2] = rfid.uid.size; memcpy(state + 12, rfid.uid.uidByte, rfid.uid.size);
    if (rfid.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A, 4, &key, &rfid.uid) != MFRC522::STATUS_OK || !readBlocks(state + 22)) {
      fail(0x82); return;
    }
    publish(state[3] == 'B' ? 2 : 4);
    if (state[3] == 'R') releaseCard();
  }
  delay(1);
}
