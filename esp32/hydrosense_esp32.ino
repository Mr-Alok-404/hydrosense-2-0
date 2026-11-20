#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// Wi-Fi details (Apne Wi-Fi ka naam aur password yahan daalo)
const char* WIFI_SSID = "Ryo";
const char* WIFI_PASSWORD = "574113299";

// Live Render backend endpoint
const char* SERVER_URL = "https://hydrosense-2-0.onrender.com/api/sensor-data";

const char* DEVICE_ID = "HYDRO_ESP32_01";
const int LED_PIN = 2; // ESP32-WROOM onboard LED (ya external LED + 220 ohm resistor)
unsigned long lastSend = 0;
const unsigned long SEND_INTERVAL = 10000; // IEEE Standard 10 seconds

void blinkLED(int count, int onMs = 120, int offMs = 120) {
  for (int i = 0; i < count; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(onMs);
    digitalWrite(LED_PIN, LOW);
    if (i < count - 1) {
      delay(offMs);
    }
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 20000) {
    digitalWrite(LED_PIN, !digitalRead(LED_PIN)); // Slow toggle while connecting
    delay(250);
    Serial.print(".");
  }
  digitalWrite(LED_PIN, LOW);

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWi-Fi connected");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
    blinkLED(2, 130, 120); // 2 blinks = Wi-Fi connected
  } else {
    Serial.println("\nWi-Fi connection timeout, will retry...");
    blinkLED(4, 180, 150); // 4 blinks = Wi-Fi timeout
  }
}

void sendReading() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    if (WiFi.status() != WL_CONNECTED) return;
  }

  // SIMULATED readings: Jab real sensors connect hon toh yahan sensor readings daal lena
  float ph = random(650, 851) / 100.0;
  float temperature = random(240, 321) / 10.0;
  float turbidity = random(10, 101) / 10.0;
  float tds = random(250, 601);

  StaticJsonDocument<384> doc;
  doc["device_id"] = DEVICE_ID;
  doc["pH"] = ph;
  doc["TDS"] = tds;
  doc["Turbidity"] = turbidity;
  doc["Temperature"] = temperature;
  doc["data_source"] = "SIMULATED";

  String payload;
  serializeJson(doc, payload);

  WiFiClientSecure client;
  client.setInsecure(); // Skip CA chain verification for HTTPS on ESP32

  HTTPClient http;
  http.setTimeout(15000); // Render free tier cold-start ke liye extra timeout
  http.begin(client, SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", "HYDRO_SECRET_KEY_123");

  int responseCode = http.POST(payload);

  Serial.println("Sending sensor reading to Render:");
  Serial.println(payload);
  Serial.print("HTTP response: ");
  Serial.println(responseCode);

  if (responseCode == 200) {
    Serial.println(http.getString());
    blinkLED(1, 350, 100); // 1 steady blink = HTTP 200 success
  } else if (responseCode > 0) {
    Serial.println(http.getString());
    blinkLED(3, 100, 100); // 3 quick blinks = HTTP non-200 error (e.g. 400/500)
  } else {
    Serial.print("HTTP POST failed: ");
    Serial.println(http.errorToString(responseCode));
    blinkLED(5, 80, 80); // 5 rapid blinks = Network / timeout / Render sleep (-1, -11, etc.)
  }

  http.end();
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.begin(115200);
  randomSeed(analogRead(0));
  connectWiFi();
}

void loop() {
  if (millis() - lastSend >= SEND_INTERVAL) {
    lastSend = millis();
    sendReading();
  }
}