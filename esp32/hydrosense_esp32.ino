
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"

// ============================================================
// HYDROSENSE 2.0
// ESP32 DevKit V1
// 10-second sensor polling + 3-reading rolling average
// LCD + WiFi + HTTPS + Flask cloud backend
// ============================================================

// =====================================================
// 1. HYDROSENSE 2.0 - CONFIGURATION
// =====================================================

const char* WIFI_SSID     = "Ryo";
const char* WIFI_PASSWORD = "574113299";

const char* SERVER_URL    = "https://hydrosense-2-0.onrender.com/api/sensor-data";
const char* API_KEY       = "HYDRO_SECRET_KEY_123";
const char* DEVICE_ID     = "HYDRO_ESP32_01";
const char* DATA_SOURCE   = "HARDWARE";


// 2. PIN CONFIGURATION
#define PH_PIN        34
#define TDS_PIN       32
#define TURB_PIN      35
#define ONE_WIRE_PIN  25
#define LED_PIN       2

#define I2C_SDA       21
#define I2C_SCL       22

// 3. LCD
LiquidCrystal_I2C lcd(0x27, 16, 2);

const unsigned long LCD_REFRESH_MS = 500UL;
int lcdPage = 0;
unsigned long lastLCDRefresh = 0;
unsigned long lastPageChange = 0;

// 4. TEMPERATURE SENSOR
OneWire oneWire(ONE_WIRE_PIN);
DallasTemperature tempSensor(&oneWire);

// 5. ADC CONFIGURATION
#define ADC_MAX          4095.0f
#define ADC_VREF         3.3f
#define SAMPLE_COUNT     30
#define ADC_LOW_FAULT    20
#define ADC_HIGH_FAULT   4085

// 6. VOLTAGE SCALING
// pH is measured directly at GPIO34.
// Turbidity board output retains the existing 1.5 scaling factor.
#define TURB_DIV_RATIO   1.5f

// 7. SENSOR CALIBRATION
// Provisional pH calibration; verify with pH 4.01 and 7.00 buffers.
const float PH_V7 = 1.55f;
const float PH_V4 = 2.09f;

float latestPH = NAN;

// Turbidity is displayed as a RELATIVE INDEX (0-10), not certified NTU.
// On startup, place the probe in clean water. The firmware measures
// that water as the zero reference. 2.00 V is the provisional dirty-end
// reference in the scaled sensor-output voltage domain.
float TURB_V_CLEAR = NAN;
const float TURB_V_DIRTY = 2.00f;
const float TURBIDITY_INDEX_MAX = 10.0f;
bool turbidityCalibrationValid = false;

// 8. REFERENCE LIMITS
#define TDS_MAX   500.0f
#define PH_MIN    6.5f
#define PH_MAX    8.5f
#define TURB_MAX  5.0f

// 9. TIMING
const unsigned long SENSOR_INTERVAL_MS = 10000UL;
const unsigned long WIFI_RETRY_MS = 10000UL;
const unsigned long HTTP_TIMEOUT_MS = 15000UL;
const unsigned long LCD_PAGE_INTERVAL = 2500UL;

// 10. DATA STRUCTURES
struct SensorReading {
  float ph;
  float tds;
  float turbidity;
  float temperature;
};

struct SensorPacket {
  float ph;
  float tds;
  float turbidity;
  float temperature;

  uint32_t sample_id;
  uint32_t timestamp_ms;
  uint8_t samples_in_window;
};

// 11. MOVING AVERAGE
SensorReading readingHistory[3];

uint8_t historyCount = 0;
uint8_t historyIndex = 0;

SensorReading averagedReading = {
  NAN, NAN, NAN, NAN
};

bool averageReady = false;

// 12. GLOBAL VARIABLES
QueueHandle_t sensorQueue = nullptr;

uint32_t sampleID = 0;

unsigned long lastSensorPoll = 0;
unsigned long lastWiFiRetry = 0;

volatile int cloudStatus = 0;
// 0 = waiting
// 1 = sending
// 2 = success
// 3 = failed
// 4 = WiFi offline

volatile int lastHTTPCode = 0;
bool wifiStarted = false;

// ============================================================
// 13. LCD HELPERS
// ============================================================

// Convert any message into exactly 16 characters.
// The remaining positions are filled with spaces.
void makeLCDLine(char output[17], const char* message) {
  memset(output, ' ', 16);
  output[16] = '\0';

  if (message == nullptr) return;

  size_t length = strlen(message);
  if (length > 16) length = 16;

  memcpy(output, message, length);
}

// Write a complete 16-character row.
// No lcd.clear() is used during normal operation.
void writeLCDRow(uint8_t row, const char* message) {
  if (row > 1) return;

  char fixedLine[17];
  makeLCDLine(fixedLine, message);

  lcd.setCursor(0, row);
  lcd.print(fixedLine);
}

// ============================================================
// 14. LCD DISPLAY
// ============================================================

void updateLCD() {
  unsigned long now = millis();

  // Refresh LCD only every 500 ms.
  if (now - lastLCDRefresh < LCD_REFRESH_MS) {
    return;
  }

  lastLCDRefresh = now;

  // Rotate pages every 2.5 seconds.
  if (now - lastPageChange >= LCD_PAGE_INTERVAL) {
    lastPageChange = now;
    lcdPage = (lcdPage + 1) % 3;
  }

  char line0[17];
  char line1[17];

  // ---------------- WARMUP PAGES ----------------
  if (!averageReady) {
    if (lcdPage == 0) {
      if (isfinite(latestPH)) {
        snprintf(line0, sizeof(line0), "pH: %.2f", latestPH);
      } else {
        snprintf(line0, sizeof(line0), "HydroSense 2.0");
      }
      snprintf(line1, sizeof(line1), "WARMUP %u/3", historyCount);
    }
    else if (lcdPage == 1) {
      snprintf(line0, sizeof(line0), "Collecting data");
      snprintf(line1, sizeof(line1), "Samples: %u/3", historyCount);
    }
    else {
      snprintf(
        line0, sizeof(line0), "%s",
        WiFi.status() == WL_CONNECTED
          ? "WiFi: CONNECTED"
          : "WiFi: OFFLINE"
      );

      snprintf(line1, sizeof(line1), "Cloud: WAITING");
    }
  }

  // ---------------- NORMAL PAGES ----------------
  else {
    if (lcdPage == 0) {
      snprintf(line0, sizeof(line0), "pH: %.2f", latestPH);
      snprintf(line1, sizeof(line1), "Temp: %.1f C",
               averagedReading.temperature);
    }
    else if (lcdPage == 1) {
      snprintf(line0, sizeof(line0), "TDS: %.0f ppm",
               averagedReading.tds);
      snprintf(line1, sizeof(line1), "Turb: %.1f /10",
               averagedReading.turbidity);
    }
    else {
      snprintf(
        line0, sizeof(line0), "%s",
        WiFi.status() == WL_CONNECTED
          ? "WiFi: CONNECTED"
          : "WiFi: OFFLINE"
      );

      switch (cloudStatus) {
        case 0:
          snprintf(line1, sizeof(line1), "Cloud: WAITING");
          break;
        case 1:
          snprintf(line1, sizeof(line1), "Cloud: SENDING");
          break;
        case 2:
          snprintf(line1, sizeof(line1), "Cloud: SUCCESS");
          break;
        case 3:
          snprintf(line1, sizeof(line1), "Cloud: FAILED");
          break;
        case 4:
          snprintf(line1, sizeof(line1), "Cloud: OFFLINE");
          break;
        default:
          snprintf(line1, sizeof(line1), "Cloud: UNKNOWN");
          break;
      }
    }
  }

  // Always overwrite the complete row.
  // This prevents old characters remaining on the display.
  writeLCDRow(0, line0);
  writeLCDRow(1, line1);
}

// ============================================================
// 15. ADC MEDIAN FILTER
// ============================================================

int readMedianADC(int pin) {
  analogRead(pin);
  delay(10);

  analogRead(pin);
  delay(5);

  int buffer[SAMPLE_COUNT];

  for (int i = 0; i < SAMPLE_COUNT; i++) {
    buffer[i] = analogRead(pin);
    delay(5);
  }

  // Sort readings.
  for (int i = 0; i < SAMPLE_COUNT - 1; i++) {
    for (int j = i + 1; j < SAMPLE_COUNT; j++) {
      if (buffer[j] < buffer[i]) {
        int temp = buffer[i];
        buffer[i] = buffer[j];
        buffer[j] = temp;
      }
    }
  }

  return (buffer[14] + buffer[15]) / 2;
}

// ============================================================
// 16. ADC TO VOLTAGE
// ============================================================

float adcToVoltage(int raw) {
  return ((float)raw / ADC_MAX) * ADC_VREF;
}

// Median of calibrated ESP32 ADC millivolt readings.
// Used for pH and turbidity voltage measurements.
int readMedianMilliVolts(int pin) {
  const int VOLTAGE_SAMPLES = 21;
  int buffer[VOLTAGE_SAMPLES];

  analogReadMilliVolts(pin);
  delay(3);
  analogReadMilliVolts(pin);
  delay(3);

  for (int i = 0; i < VOLTAGE_SAMPLES; i++) {
    buffer[i] = analogReadMilliVolts(pin);
    delay(2);
  }

  for (int i = 0; i < VOLTAGE_SAMPLES - 1; i++) {
    for (int j = i + 1; j < VOLTAGE_SAMPLES; j++) {
      if (buffer[j] < buffer[i]) {
        int temp = buffer[i];
        buffer[i] = buffer[j];
        buffer[j] = temp;
      }
    }
  }

  return buffer[VOLTAGE_SAMPLES / 2];
}

float readScaledTurbidityVoltage() {
  float pinVoltage = readMedianMilliVolts(TURB_PIN) / 1000.0f;
  return pinVoltage * TURB_DIV_RATIO;
}

void calibrateTurbidityClearWater() {
  const int CALIBRATION_SAMPLES = 5;
  float readings[CALIBRATION_SAMPLES];

  Serial.println();
  Serial.println("Turbidity reference: keep sensor in clean water");

  for (int i = 0; i < CALIBRATION_SAMPLES; i++) {
    readings[i] = readScaledTurbidityVoltage();
    delay(150);
  }

  // Sort five readings and use their median as the clear-water baseline.
  for (int i = 0; i < CALIBRATION_SAMPLES - 1; i++) {
    for (int j = i + 1; j < CALIBRATION_SAMPLES; j++) {
      if (readings[j] < readings[i]) {
        float temp = readings[i];
        readings[i] = readings[j];
        readings[j] = temp;
      }
    }
  }

  TURB_V_CLEAR = readings[CALIBRATION_SAMPLES / 2];

  if (
    isfinite(TURB_V_CLEAR) &&
    TURB_V_CLEAR > TURB_V_DIRTY + 0.10f &&
    TURB_V_CLEAR < 4.95f
  ) {
    turbidityCalibrationValid = true;
    Serial.print("Turbidity reference set: ");
    Serial.print(TURB_V_CLEAR, 3);
    Serial.println(" V");
  } else {
    turbidityCalibrationValid = false;
    Serial.println("Turbidity reference error: check sensor and clean-water setup");
  }
}

// ============================================================
// 17. TEMPERATURE
// ============================================================

float readTemperature() {
  tempSensor.requestTemperatures();

  float temperature = tempSensor.getTempCByIndex(0);

  if (
    temperature == DEVICE_DISCONNECTED_C ||
    !isfinite(temperature) ||
    temperature < -55.0f ||
    temperature > 125.0f
  ) {
    Serial.println("Temperature sensor error");
    return NAN;
  }

  return temperature;
}

// ============================================================
// 18. pH SENSOR
// ============================================================

float readPH() {
  // One current-cycle median measurement; no previous-cycle averaging.
  float voltage = readMedianMilliVolts(PH_PIN) / 1000.0f;

  if (!isfinite(voltage) || voltage <= 0.0f || voltage >= 3.30f) {
    latestPH = NAN;
    return NAN;
  }

  if (fabsf(PH_V4 - PH_V7) < 0.01f) {
    latestPH = NAN;
    return NAN;
  }

  float ph =
    7.00f +
    (voltage - PH_V7) *
    ((4.01f - 7.00f) / (PH_V4 - PH_V7));

  if (!isfinite(ph) || ph < 0.0f || ph > 14.0f) {
    latestPH = NAN;
    return NAN;
  }

  latestPH = ph;
  return ph;
}

// ============================================================
// 19. TDS SENSOR
// ============================================================

float readTDS(float temperature) {
  int raw = readMedianADC(TDS_PIN);

  if (raw <= ADC_LOW_FAULT || raw >= ADC_HIGH_FAULT) {
    Serial.println("TDS sensor fault: ADC near rail");
    return NAN;
  }

  float voltage = adcToVoltage(raw);

  float coefficient =
    1.0f + 0.02f * (temperature - 25.0f);

  if (coefficient <= 0.0f || !isfinite(coefficient)) {
    return NAN;
  }

  float compensatedVoltage = voltage / coefficient;

  float tds =
    (
      133.42f * compensatedVoltage * compensatedVoltage *
      compensatedVoltage
      - 255.86f * compensatedVoltage * compensatedVoltage
      + 857.39f * compensatedVoltage
    ) * 0.5f;

  if (!isfinite(tds) || tds < 0.0f) {
    return NAN;
  }

  return tds;
}

// ============================================================
// 20. TURBIDITY SENSOR
// ============================================================

float readTurbidity() {
  if (!turbidityCalibrationValid) {
    return NAN;
  }

  float voltage = readScaledTurbidityVoltage();
  float span = TURB_V_CLEAR - TURB_V_DIRTY;

  if (
    !isfinite(voltage) ||
    span < 0.10f
  ) {
    return NAN;
  }

  // Relative turbidity index:
  // 0 = same as startup clean-water reference
  // 10 = provisional dirty-end voltage reference
  float index =
    ((TURB_V_CLEAR - voltage) / span) * TURBIDITY_INDEX_MAX;

  if (!isfinite(index)) return NAN;

  if (index < 0.0f) index = 0.0f;
  if (index > TURBIDITY_INDEX_MAX) index = TURBIDITY_INDEX_MAX;

  return index;
}

// ============================================================
// 21. ACQUIRE ONE COMPLETE SENSOR SET
// ============================================================

SensorReading acquireSensorReading() {
  SensorReading current;

  current.temperature = readTemperature();

  float compensationTemperature =
    isfinite(current.temperature)
      ? current.temperature
      : 25.0f;

  current.ph = readPH();
  current.tds = readTDS(compensationTemperature);
  current.turbidity = readTurbidity();

  return current;
}

// ============================================================
// 22. VALIDATE SENSOR READING
// ============================================================

bool isReadingValid(const SensorReading& reading) {
  return
    isfinite(reading.ph) &&
    isfinite(reading.tds) &&
    isfinite(reading.turbidity) &&
    isfinite(reading.temperature);
}

// ============================================================
// 23. RESET MOVING AVERAGE
// ============================================================

void resetMovingAverage() {
  historyCount = 0;
  historyIndex = 0;
  averageReady = false;

  averagedReading.ph = NAN;
  averagedReading.tds = NAN;
  averagedReading.turbidity = NAN;
  averagedReading.temperature = NAN;

  Serial.println("Moving average reset: invalid sensor reading");
}

// ============================================================
// 24. THREE-READING ROLLING MOVING AVERAGE
// ============================================================

bool updateMovingAverage(const SensorReading& current) {
  if (!isReadingValid(current)) {
    resetMovingAverage();
    return false;
  }

  readingHistory[historyIndex] = current;
  historyIndex = (historyIndex + 1) % 3;

  if (historyCount < 3) {
    historyCount++;
  }

  if (historyCount < 3) {
    averageReady = false;
    return false;
  }

  float tdsSum = 0.0f;
  float turbiditySum = 0.0f;
  float temperatureSum = 0.0f;

  for (int i = 0; i < 3; i++) {
    tdsSum += readingHistory[i].tds;
    turbiditySum += readingHistory[i].turbidity;
    temperatureSum += readingHistory[i].temperature;
  }

  // pH is deliberately NOT averaged: use the newest sample immediately.
  averagedReading.ph = current.ph;
  averagedReading.tds = tdsSum / 3.0f;
  averagedReading.turbidity = turbiditySum / 3.0f;
  averagedReading.temperature = temperatureSum / 3.0f;

  averageReady = true;
  return true;
}

// ============================================================
// 25. SERIAL REPORT
// ============================================================

void printSensorReport(const SensorReading& current) {
  Serial.println();
  Serial.println("----------------------------------------");
  Serial.print("HydroSense | Sample ");
  Serial.println(sampleID);

  Serial.print("pH: ");
  if (isfinite(current.ph)) Serial.println(current.ph, 2);
  else Serial.println("Sensor error");

  if (averageReady) {
    Serial.print("TDS: ");
    Serial.print(averagedReading.tds, 1);
    Serial.println(" ppm");

    Serial.print("Turbidity Index: ");
    Serial.print(averagedReading.turbidity, 1);
    Serial.println(" / 10");

    Serial.print("Temperature: ");
    Serial.print(averagedReading.temperature, 1);
    Serial.println(" C");
  } else {
    Serial.print("Other sensors: collecting ");
    Serial.print(historyCount);
    Serial.println("/3 readings");
  }

  Serial.print("Cloud: ");
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Offline");
  } else if (!averageReady) {
    Serial.println("Waiting for sensor window");
  } else {
    Serial.println("Ready");
  }

  Serial.println("----------------------------------------");
}

// ============================================================
// 26. WIFI INITIALIZATION
// ============================================================

void startWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  wifiStarted = true;
  lastWiFiRetry = millis();

  Serial.println("WiFi connection initiated...");
}

// ============================================================
// 27. WIFI RECONNECTION
// ============================================================

void checkWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  cloudStatus = 4;

  if (
    !wifiStarted ||
    millis() - lastWiFiRetry >= WIFI_RETRY_MS
  ) {
    lastWiFiRetry = millis();

    Serial.println("WiFi disconnected. Reconnecting...");

    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    wifiStarted = true;
  }
}

// ============================================================
// 28. STATUS LED
// ============================================================

void updateStatusLED() {
  static unsigned long previousToggle = 0;
  static bool ledState = false;

  unsigned long interval = 1000;
  bool solidOn = false;

  if (WiFi.status() != WL_CONNECTED) {
    interval = 500;
  }
  else if (cloudStatus == 1) {
    interval = 150;
  }
  else if (cloudStatus == 2) {
    solidOn = true;
  }
  else if (cloudStatus == 3) {
    interval = 100;
  }

  if (solidOn) {
    digitalWrite(LED_PIN, HIGH);
    return;
  }

  if (millis() - previousToggle >= interval) {
    previousToggle = millis();
    ledState = !ledState;
    digitalWrite(LED_PIN, ledState);
  }
}

// ============================================================
// 29. CLOUD SENDER TASK
// ============================================================

void cloudSenderTask(void* parameter) {
  SensorPacket packet;

  for (;;) {
    if (
      xQueueReceive(sensorQueue, &packet, portMAX_DELAY) != pdTRUE
    ) {
      continue;
    }

    if (WiFi.status() != WL_CONNECTED) {
      cloudStatus = 4;
      Serial.println("Cloud upload skipped: WiFi offline");
      continue;
    }

    cloudStatus = 1;

    WiFiClientSecure secureClient;

    // Demonstration setting only: server certificate is NOT verified.
    secureClient.setInsecure();

    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);

    if (!http.begin(secureClient, SERVER_URL)) {
      cloudStatus = 3;
      lastHTTPCode = -1;
      Serial.println("HTTP begin failed");
      continue;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-API-Key", API_KEY);

    char payload[512];

    int written = snprintf(
      payload,
      sizeof(payload),
      "{"
        "\"device_id\":\"%s\","
        "\"data_source\":\"%s\","
        "\"sample_id\":%lu,"
        "\"timestamp_ms\":%lu,"
        "\"samples_in_window\":%u,"
        "\"ph_samples_in_window\":1,"
        "\"pH\":%.2f,"
        "\"TDS\":%.2f,"
        "\"Turbidity\":%.2f,"
        "\"Temperature\":%.2f,"
        "\"sensor_status\":\"OK\""
      "}",
      DEVICE_ID,
      DATA_SOURCE,
      (unsigned long)packet.sample_id,
      (unsigned long)packet.timestamp_ms,
      (unsigned int)packet.samples_in_window,
      packet.ph,
      packet.tds,
      packet.turbidity,
      packet.temperature
    );

    if (written <= 0 || written >= (int)sizeof(payload)) {
      cloudStatus = 3;
      lastHTTPCode = -2;
      http.end();
      Serial.println("JSON payload creation failed");
      continue;
    }

    Serial.println();
    Serial.println("========== CLOUD UPLOAD ==========");
    Serial.print("Sample ID: ");
    Serial.println(packet.sample_id);
    Serial.println(payload);

    int httpCode = http.POST(
      (uint8_t*)payload,
      strlen(payload)
    );

    lastHTTPCode = httpCode;

    if (httpCode >= 200 && httpCode < 300) {
      cloudStatus = 2;

      Serial.print("Upload successful. HTTP: ");
      Serial.println(httpCode);

      Serial.println(http.getString());
    }
    else {
      cloudStatus = 3;

      Serial.print("Upload failed. HTTP: ");
      Serial.println(httpCode);

      if (httpCode > 0) {
        Serial.println(http.getString());
      } else {
        Serial.println(http.errorToString(httpCode));
      }
    }

    http.end();
    Serial.println("==================================");
  }
}

// ============================================================
// 30. SETUP
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println();
  Serial.println("======================================");
  Serial.println("          HYDROSENSE 2.0");
  Serial.println("    HARDWARE MONITORING SYSTEM");
  Serial.println("======================================");

  // ADC initialization
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  analogSetPinAttenuation(PH_PIN, ADC_11db);
  analogSetPinAttenuation(TDS_PIN, ADC_11db);
  analogSetPinAttenuation(TURB_PIN, ADC_11db);

  // LCD initialization
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);

  lcd.init();
  lcd.backlight();
  lcd.clear();

  // Initial screen
  writeLCDRow(0, "HydroSense 2.0");
  writeLCDRow(1, "Starting...");

  // Temperature sensor
  tempSensor.begin();

  // Calibrate relative turbidity zero using clean water at startup.
  // Keep the turbidity probe in clean water while the device starts.
  calibrateTurbidityClearWater();

  // Cloud queue
  sensorQueue = xQueueCreate(1, sizeof(SensorPacket));

  if (sensorQueue == nullptr) {
    Serial.println("FATAL: Cloud queue creation failed");

    lcd.clear();
    writeLCDRow(0, "QUEUE ERROR");
    writeLCDRow(1, "Restart device");

    while (true) delay(1000);
  }

  // Cloud task
  BaseType_t taskCreated = xTaskCreate(
    cloudSenderTask,
    "CloudSender",
    8192,
    nullptr,
    1,
    nullptr
  );

  if (taskCreated != pdPASS) {
    Serial.println("FATAL: Cloud task creation failed");

    lcd.clear();
    writeLCDRow(0, "TASK ERROR");
    writeLCDRow(1, "Restart device");

    while (true) delay(1000);
  }

  // WiFi
  startWiFi();

  // First sensor acquisition starts immediately.
  lastSensorPoll = millis() - SENSOR_INTERVAL_MS;

  lastPageChange = millis();
  lastLCDRefresh = millis() - LCD_REFRESH_MS;

  Serial.println("System ready | Sampling interval: 10 seconds");
  Serial.println("pH calibration: provisional");
  Serial.println("Turbidity output: relative index 0-10");
  Serial.println("TDS, turbidity and temperature: 3-reading average");
}

// ============================================================
// 31. MAIN LOOP
// ============================================================

void loop() {
  checkWiFi();
  updateStatusLED();

  // LCD is accessed only from this main loop.
  updateLCD();

  unsigned long now = millis();

  if (now - lastSensorPoll >= SENSOR_INTERVAL_MS) {
    lastSensorPoll = now;
    sampleID++;

    Serial.println();
    Serial.println("Starting sensor acquisition...");

    SensorReading current = acquireSensorReading();

    bool ready = updateMovingAverage(current);

    printSensorReport(current);

    // Send after 3 valid complete sets: pH is current sample; other sensors are 3-reading averages.
    if (ready) {
      SensorPacket packet;

      packet.ph = current.ph;
      packet.tds = averagedReading.tds;
      packet.turbidity = averagedReading.turbidity;
      packet.temperature = averagedReading.temperature;

      packet.sample_id = sampleID;
      packet.timestamp_ms = millis();
      packet.samples_in_window = 3;

      // Queue length is 1; newest pending packet replaces old pending packet.
      xQueueOverwrite(sensorQueue, &packet);
    }
  }

  delay(20);
}
